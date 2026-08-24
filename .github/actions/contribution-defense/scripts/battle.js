#!/usr/bin/env node
// Contribution Defense — contribution-driven castle defense renderer.
// The wall IS the owner's real contribution graph (53 weeks x 7 days,
// GitHub's own per-day color levels). Persistent battle state (castle HP,
// run records) advances daily. Renders animated light/dark SVG scenes
// with no text — picture only. Zero dependencies; Node 18+.

const https = require("https");
const fs = require("fs");
const path = require("path");

// Configuration resolves three ways: GitHub Action inputs (INPUT_*),
// plain env overrides, or defaults relative to the workspace/repo root.
const LOGIN =
  process.env.INPUT_USER ||
  process.env.DEFENSE_LOGIN ||
  (process.env.GITHUB_REPOSITORY || "").split("/")[0] ||
  "rim95dev";
const TOKEN =
  process.env.INPUT_GITHUB_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  "";
const WORKSPACE = process.env.GITHUB_WORKSPACE || path.join(__dirname, "..");
const STATE_FILE = path.resolve(WORKSPACE, process.env.INPUT_STATE_FILE || "state.json");
const DIST = path.resolve(WORKSPACE, process.env.INPUT_OUTPUT_DIR || "dist");

const REPLAY_DAYS = 56; // history replayed when state.json doesn't exist yet
const HP_MAX = 100;
const HP_LOSS = 10; // per zero-commit day
const REPAIR_CAP = 5; // max HP repaired per day

// ---------------------------------------------------------------- data

function gql(query, variables) {
  const body = JSON.stringify({ query, variables });
  const opts = {
    hostname: "api.github.com",
    path: "/graphql",
    method: "POST",
    headers: {
      "Authorization": `bearer ${TOKEN}`,
      "User-Agent": "contribution-defense",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          resolve(json.data);
        } catch (e) {
          reject(new Error(`bad response (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const LEVELS = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

async function fetchCalendar() {
  const to = new Date();
  const from = new Date(to.getTime() - 364 * 86400_000);
  const data = await gql(
    `query($login:String!,$from:DateTime!,$to:DateTime!){
      user(login:$login){
        contributionsCollection(from:$from,to:$to){
          contributionCalendar{
            totalContributions
            weeks{ contributionDays{ date contributionCount contributionLevel } }
          }
        }
      }
    }`,
    { login: LOGIN, from: from.toISOString(), to: to.toISOString() }
  );
  const cal = data.user.contributionsCollection.contributionCalendar;
  const weeks = cal.weeks.map((w) =>
    w.contributionDays.map((d) => ({
      date: d.date,
      count: d.contributionCount,
      level: LEVELS[d.contributionLevel] || 0,
    }))
  );
  const days = weeks.flat();
  return { total: cal.totalContributions, weeks, days };
}

// --------------------------------------------------------------- state

function kstToday() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function newState(foundedDate) {
  return {
    founded: foundedDate,
    runStart: foundedDate,
    lastDate: "",
    hp: HP_MAX,
    runs: 1,
    best: 0,
    fellYesterday: false,
  };
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
}

// Feed one completed day into the state machine.
function applyDay(state, date, count) {
  state.fellYesterday = false;
  if (count > 0) {
    state.hp = Math.min(HP_MAX, state.hp + Math.min(count, REPAIR_CAP));
  } else {
    state.hp -= HP_LOSS;
  }
  const runDays = daysBetween(state.runStart, date) + 1;
  state.best = Math.max(state.best, runDays);
  if (state.hp <= 0) {
    state.runs += 1;
    state.hp = HP_MAX;
    state.runStart = new Date(Date.parse(date) + 86400_000).toISOString().slice(0, 10);
    state.fellYesterday = true;
  }
  state.lastDate = date;
}

function advanceState(days) {
  const today = kstToday();
  const completed = days.filter((d) => d.date < today);
  let state;
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } else {
    const replay = completed.slice(-REPLAY_DAYS);
    state = newState(replay.length ? replay[0].date : today);
    for (const d of replay) applyDay(state, d.date, d.count);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
    return state;
  }
  const pending = completed.filter((d) => d.date > state.lastDate);
  for (const d of pending) applyDay(state, d.date, d.count);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  return state;
}

// ------------------------------------------------------------- helpers

// Deterministic PRNG so scenery is stable for a given day.
function rng(seedStr) {
  let s = 0;
  for (const ch of seedStr) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s >>> 8) / 16777216;
  };
}

// ------------------------------------------------------------- palettes

const THEMES = {
  light: {
    greens: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    emptyOpacity: 0.55,
    dirt: "#e9e1d1", dirtLine: "#d7ccb7",
    stone: "#a49e94", stoneDark: "#7d776d", stoneLite: "#bfb9af",
    enemy: "#d85a30", enemyDark: "#993c1d", enemyEye: "#3c1508",
    arrow: "#57606a", flag: "#d85a30",
    hpOn: "#e24b4a", hpOff: "#d0d7de",
    cloud: "#dde3ea", sun: "#f6c744",
    windowFill: "#57534b", puff: "#8b949e",
    hill: "#e2e8df", flameA: "#f0a04a", flameB: "#e2701f",
  },
  dark: {
    greens: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    emptyOpacity: 0.5,
    dirt: "#161b22", dirtLine: "#30363d",
    stone: "#545d68", stoneDark: "#343b44", stoneLite: "#6e7681",
    enemy: "#e8683c", enemyDark: "#8f3a1c", enemyEye: "#1c0f08",
    arrow: "#8b949e", flag: "#e8683c",
    hpOn: "#f85149", hpOff: "#30363d",
    moon: "#e6edf3", star: "#e6edf3",
    windowFill: "#f2cc60", puff: "#8b949e",
    hill: "#151c25", flameA: "#f2b13c", flameB: "#e8683c",
  },
};

// ------------------------------------------------------------- sprites

function goblinSprite(P, scale = 2) {
  return `<g transform="scale(${scale})">
    <g fill="${P.enemy}">
      <rect x="3" y="0" width="1" height="2"/><rect x="7" y="0" width="1" height="2"/>
      <rect x="4" y="2" width="3" height="1"/><rect x="3" y="3" width="5" height="1"/>
      <rect x="2" y="4" width="7" height="1"/><rect x="2" y="5" width="7" height="1"/>
      <rect x="1" y="6" width="9" height="1"/><rect x="1" y="7" width="9" height="1"/>
    </g>
    <rect x="0" y="8" width="11" height="1" fill="${P.enemyDark}"/>
    <g fill="${P.enemyEye}">
      <rect x="4" y="4" width="1" height="2"/><rect x="6" y="4" width="1" height="2"/>
    </g>
  </g>`;
}

// Stepped pixel circle built from horizontal strips of `u`-sized pixels.
function pixCircle(cx, cy, r, u, fill) {
  let s = `<g fill="${fill}">`;
  for (let yy = -r; yy < r; yy += u) {
    const mid = Math.abs(yy + u / 2);
    const hw = Math.round(Math.sqrt(Math.max(0, r * r - mid * mid)) / u) * u;
    if (hw > 0) s += `<rect x="${cx - hw}" y="${cy + yy}" width="${hw * 2}" height="${u}"/>`;
  }
  return s + `</g>`;
}

const ARROW_SPRITE = (P) => `<rect x="-8" y="-1" width="11" height="2" fill="${P.arrow}"/>
          <rect x="-12" y="-2" width="4" height="4" fill="${P.arrow}"/>
          <rect x="1" y="-3" width="2" height="2" fill="${P.arrow}"/>
          <rect x="1" y="1" width="2" height="2" fill="${P.arrow}"/>`;

// --------------------------------------------------------------- scene

const W = 900, H = 200;
const GROUND = 172;
const CELL = 8, PITCH = 10;
const KEEP_W = 80, KEEP_X = W - 8 - KEEP_W;

function render(theme, scene) {
  const P = THEMES[theme];
  const { weeks, yesterdayCount, state, seed } = scene;
  const R = rng(seed + theme);

  const nWeeks = weeks.length;
  const WALL_X = KEEP_X - 8 - nWeeks * PITCH;
  const WALL_TOP = GROUND - 7 * PITCH;
  const keepTop = GROUND - 100;
  const firstStanding = weeks.findIndex((w) => w.some((d) => d.level > 0));
  const standX = firstStanding < 0 ? KEEP_X - 12 : WALL_X + firstStanding * PITCH;
  const volley = Math.min(yesterdayCount, 8);

  // combat choreography: the first standing columns take the assault.
  // Each combat group (goblin + target brick + fragments + kill arrow)
  // shares one 14s timeline via a common animation-delay.
  const colH = weeks.map((w) => w.filter((d) => d.level > 0).length);

  // siege: one long master timeline (D seconds) that loops as a whole.
  // Broken bricks STAY broken for the entire timeline.
  // Two fronts share the demolition:
  //  - monsters (one at a time, the next spawns when one dies) walk up
  //    and smash the nearest standing column brick by brick
  //  - the camp on the far left fires missiles over the field, blasting
  //    columns from the back of the wall (and, at the end, the castle)
  // Arrows (yesterday's commits, up to 3) execute monsters one by one;
  // if they run out the last monster can't be stopped, the wall falls,
  // the camp bombards the castle, and only then does the siege reset.
  const kills = Math.min(3, volley);
  const defended = volley >= 3;
  const monsters = [];   // {spawnT, stops:[{x,tA,tL}], stopX, deathT|null, lunges:[t]}
  const meleeFrags = []; // {x, y, t, color}
  const missiles = [];   // {fromX, fromY, toX, toY, peak, tFire, tHit}
  const explosions = []; // {x, y, t, big}
  const castleHits = []; // {t, stage}
  const colBricks = new Map(); // ci -> bricks bottom-up: {s0,curS,alive,color,moves,deathT,melee,id}
  let D = 18;
  if (firstStanding >= 0) {
    const R2 = rng(seed + "siege"); // theme-independent so both themes fight the same battle
    const colXof = (ci) => WALL_X + ci * PITCH;
    weeks.forEach((wk, ci) => {
      const actives = wk.filter((d) => d.level > 0);
      if (!actives.length) return;
      colBricks.set(ci, actives.slice().reverse().map((cell, s) => ({
        s0: s, curS: s, alive: true, color: P.greens[cell.level],
        moves: [], deathT: null, melee: false, id: -1,
      })));
    });
    let colQueue = [...colBricks.keys()].sort((a, b) => a - b);
    const colAliveTop = (ci) => {
      const arr = colBricks.get(ci);
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].alive) return arr[i];
      return null;
    };
    const pruneQueue = () => { colQueue = colQueue.filter((ci) => colAliveTop(ci)); };
    const applyGravity = (ci, t) => {
      let s = 0;
      for (const b of colBricks.get(ci)) {
        if (!b.alive) continue;
        if (b.curS !== s) { b.moves.push({ t, from: b.curS, to: s }); b.curS = s; }
        s++;
      }
    };
    const CAMP = { x: 40, y: GROUND - 22 };
    const lobMissile = (toX, toY, tFire) => {
      const dist = toX - CAMP.x;
      const flight = 1.1 + dist / 700;
      const peak = Math.min(120, 50 + dist / 8);
      missiles.push({ fromX: CAMP.x, fromY: CAMP.y, toX, toY, peak, tFire, tHit: tFire + flight });
      return tFire + flight;
    };
    let curTargetCol = -1;
    // camp artillery: a missile at a RANDOM surviving brick; the impact
    // carves a plus-shaped hole (center, up, down, left, right) and any
    // bricks left hanging above the hole drop down under gravity
    const fireRandom = (tFire) => {
      const cands = [];
      for (const ci of colQueue) {
        if (ci === curTargetCol) continue;
        for (const b of colBricks.get(ci)) if (b.alive) cands.push({ ci, b });
      }
      if (!cands.length) return;
      const pick = cands[Math.floor(R2() * cands.length)];
      const ci = pick.ci, s = pick.b.curS;
      const ix = colXof(ci) + 4, iy = GROUND - CELL - s * 9 + 4;
      const tHit = lobMissile(ix, iy, tFire);
      const cross = [[ci, s], [ci, s + 1], [ci, s - 1], [ci - 1, s], [ci + 1, s]];
      const hitCols = new Set();
      for (const [cc, ss] of cross) {
        if (cc === curTargetCol) continue;
        const arr = colBricks.get(cc);
        if (!arr) continue;
        const b2 = arr.find((b) => b.alive && b.curS === ss);
        if (b2) { b2.alive = false; b2.deathT = tHit; hitCols.add(cc); }
      }
      for (const cc of hitCols) applyGravity(cc, tHit + 0.15);
      explosions.push({ x: ix, y: iy, t: tHit, big: false });
      pruneQueue();
    };
    let artNext = 3.0;
    const CADENCE = 2.4;
    let tt = 0.5;
    const chkArt = () => { while (artNext <= tt) { fireRandom(artNext); artNext += CADENCE; } };
    let w = 0;
    let survivor = null;
    while (colQueue.length) {
      if (defended && w >= kills) break;
      const isLast = !defended && w === kills;
      const m = { spawnT: tt, stops: [], stopX: -30, deathT: null, lunges: [] };
      monsters.push(m);
      let curX = -30;
      let smashed = 0;
      while (colQueue.length) {
        const target = colQueue[0];
        curTargetCol = target;
        const stopX = colXof(target) - 24;
        const walkT = Math.max(0.8, Math.abs(stopX - curX) / 170);
        const stop = { x: stopX, tA: tt + walkT, tL: tt + walkT + 0.25 };
        tt = stop.tL;
        chkArt();
        m.stops.push(stop);
        curX = stopX;
        m.stopX = stopX;
        while (true) {
          const tb2 = colAliveTop(target);
          if (!tb2) break;
          tt += 0.5;
          chkArt();
          m.lunges.push(tt);
          tb2.alive = false;
          tb2.deathT = tt;
          tb2.melee = true;
          meleeFrags.push({ x: colXof(target) + 4, y: GROUND - CELL - tb2.curS * 9 + 4, t: tt, color: tb2.color });
          smashed++;
          stop.tL = tt;
          if (!isLast && smashed >= 4) break;
        }
        pruneQueue();
        curTargetCol = -1;
        stop.tL = tt + 0.2;
        tt += 0.2;
        if (!isLast && smashed >= 4) break;
      }
      if (!isLast) {
        m.deathT = tt + 1.0;
        tt = m.deathT + 0.6;
        w++;
      } else {
        survivor = m;
        break;
      }
    }
    if (survivor) {
      // the wall is gone — the monster hammers the gate while the camp
      // bombards the castle into rubble
      const cwX = KEEP_X - 50;
      const walkT = Math.max(0.8, Math.abs(cwX - survivor.stopX) / 170);
      const stop = { x: cwX, tA: tt + walkT, tL: tt + walkT };
      survivor.stops.push(stop);
      survivor.stopX = cwX;
      tt = stop.tA + 0.3;
      const hitY = [keepTop - 4, keepTop + 30, GROUND - 30];
      for (let stage = 1; stage <= 3; stage++) {
        const tHit = lobMissile(KEEP_X + 40, hitY[stage - 1], tt);
        castleHits.push({ t: tHit, stage });
        explosions.push({ x: KEEP_X + 40, y: hitY[stage - 1], t: tHit, big: true });
        survivor.lunges.push(tHit - 0.4);
        stop.tL = tHit + 0.5;
        tt = tHit + 0.9;
      }
      tt += 2.2;
    }
    let maxT = tt;
    for (const ms of missiles) maxT = Math.max(maxT, ms.tHit + 0.8);
    for (const m of monsters) if (m.deathT) maxT = Math.max(maxT, m.deathT + 0.8);
    D = Math.max(16, maxT + 0.8);
  }
  // bricks that ever move or die get their own timeline class
  const animBricks = [];
  for (const arr of colBricks.values()) {
    for (const b of arr) {
      if (b.moves.length || b.deathT !== null) {
        b.id = animBricks.length;
        animBricks.push(b);
      }
    }
  }
  const PT = (t) => ((t / D) * 100).toFixed(2);

  let body = "";

  // sky
  if (theme === "dark") {
    body += pixCircle(84, 44, 14, 4, P.moon);
    body += `<g fill="${P.dirtLine}" opacity="0.6"><rect x="84" y="38" width="8" height="4"/><rect x="76" y="46" width="4" height="4"/></g>`;
    for (let i = 0; i < 12; i++) {
      const sx = Math.round(20 + R() * 780), sy = Math.round(12 + R() * 70);
      body += `<rect x="${sx}" y="${sy}" width="2" height="2" fill="${P.star}" class="tw" style="animation-delay:${(R() * 3).toFixed(1)}s"/>`;
    }
  } else {
    body += pixCircle(88, 46, 16, 4, P.sun);
    body += `<g fill="${P.sun}"><rect x="86" y="18" width="4" height="8"/><rect x="86" y="66" width="4" height="8"/>
      <rect x="60" y="44" width="8" height="4"/><rect x="108" y="44" width="8" height="4"/>
      <rect x="72" y="30" width="4" height="4"/><rect x="68" y="26" width="4" height="4"/>
      <rect x="100" y="30" width="4" height="4"/><rect x="104" y="26" width="4" height="4"/>
      <rect x="72" y="58" width="4" height="4"/><rect x="68" y="62" width="4" height="4"/>
      <rect x="100" y="58" width="4" height="4"/><rect x="104" y="62" width="4" height="4"/></g>`;
    for (const [cy, dur, off] of [[58, 85, -180], [86, 62, -420]]) {
      body += `<g class="cloud" style="animation-duration:${dur}s;animation-delay:${off / 10}s" transform="translate(0 ${cy})">
        <g fill="${P.cloud}"><rect x="12" y="-4" width="16" height="4"/>
        <rect x="4" y="0" width="32" height="4"/><rect x="0" y="4" width="44" height="4"/></g></g>`;
    }
  }

  // horizon hills (stepped, 4px pixel grid) + ground
  body += `<g fill="${P.hill}">
    <rect x="32" y="${GROUND - 20}" width="44" height="4"/>
    <rect x="16" y="${GROUND - 16}" width="76" height="4"/>
    <rect x="120" y="${GROUND - 16}" width="52" height="4"/>
    <rect x="4" y="${GROUND - 12}" width="184" height="4"/>
    <rect x="-8" y="${GROUND - 8}" width="212" height="4"/>
    <rect x="-16" y="${GROUND - 4}" width="252" height="4"/></g>
    <rect x="0" y="${GROUND}" width="${W}" height="26" fill="${P.dirt}"/>
    <rect x="0" y="${GROUND}" width="${W}" height="2" fill="${P.dirtLine}"/>`;

  // grass tufts along the field and wall base
  for (let i = 0; i < 14; i++) {
    const gx = Math.round(16 + R() * (KEEP_X - 60));
    const lv = 1 + Math.floor(R() * 2);
    body += `<rect x="${gx}" y="${GROUND - 3}" width="3" height="3" fill="${P.greens[lv]}"/>
      <rect x="${gx + 4}" y="${GROUND - 5}" width="2" height="5" fill="${P.greens[lv + 1]}"/>`;
  }

  // enemy camp at the far left
  body += `<g>
    <g fill="${P.enemyDark}">
      <rect x="30" y="${GROUND - 20}" width="8" height="4"/>
      <rect x="26" y="${GROUND - 16}" width="16" height="4"/>
      <rect x="22" y="${GROUND - 12}" width="24" height="4"/>
      <rect x="18" y="${GROUND - 8}" width="32" height="8"/></g>
    <rect x="30" y="${GROUND - 8}" width="8" height="8" fill="${P.enemyEye}"/>
    <rect x="54" y="${GROUND - 32}" width="4" height="32" fill="${P.stoneDark}"/>
    <g fill="${P.enemy}">
      <rect x="58" y="${GROUND - 32}" width="12" height="4"/>
      <rect x="58" y="${GROUND - 28}" width="8" height="4"/>
      <rect x="58" y="${GROUND - 24}" width="12" height="4"/></g>
    <rect x="72" y="${GROUND - 4}" width="12" height="4" fill="${P.enemyDark}"/>
    <g class="f1" fill="${P.flameA}"><rect x="74" y="${GROUND - 12}" width="8" height="8"/><rect x="76" y="${GROUND - 16}" width="4" height="4"/></g>
    <g class="f2" fill="${P.flameB}"><rect x="74" y="${GROUND - 8}" width="8" height="4"/><rect x="76" y="${GROUND - 16}" width="4" height="12"/></g>
  </g>`;

  // monsters — one at a time, drawn behind the wall so they never
  // overlap standing bricks
  monsters.forEach((m, w) => {
    const hopG = `<g class="hop" style="animation-delay:${(w * 0.13).toFixed(2)}s">${goblinSprite(P)}</g>`;
    body += `<g class="mo${w}">
      <g transform="translate(-30 ${GROUND - 18})">
        <g class="ml${w}">${hopG}</g></g></g>`;
  });

  // the wall: contribution cells start at their real graph position,
  // then gravity drops them into stacked bricks per week column.
  // Missile-blasted columns are grouped so the whole column vanishes
  // at impact; melee bricks get individual shatter wrappers.
  for (let wI = 0; wI < nWeeks; wI++) {
    const x = WALL_X + wI * PITCH;
    const bricksArr = colBricks.get(wI);
    let s = 0; // stack height from the ground, bottom-most day lands first
    for (let dI = weeks[wI].length - 1; dI >= 0; dI--) {
      const cell = weeks[wI][dI];
      if (cell.level === 0) continue;
      const yFin = GROUND - CELL - s * 9;
      const yOrig = WALL_TOP + dI * PITCH;
      let rect = `<rect x="${x}" y="${yFin}" width="${CELL}" height="${CELL}" rx="2" fill="${P.greens[cell.level]}"/>`;
      const bObj = bricksArr ? bricksArr[s] : undefined;
      if (bObj && bObj.id >= 0) {
        rect = `<g class="bv${bObj.id}">${rect}</g>`;
      }
      body += `<g class="fall" style="--fd:${yOrig - yFin}px">${rect}</g>`;
      s++;
    }
  }

  // brick fragments, one burst per melee-broken brick
  const pieces = [[-8, -10, 4, 4], [-3, -13, 4, 4], [4, -7, 4, 2]];
  meleeFrags.forEach((f, j) => {
    for (const p of pieces) {
      body += `<g transform="translate(${f.x} ${f.y})"><g class="fk${j}" style="--fx:${p[0]}px;--fy2:${p[1]}px">
        <rect x="-2" y="-2" width="${p[2]}" height="${p[3]}" fill="${f.color}"/></g></g>`;
    }
  });

  // castle keep — built in three stages so missile hits can peel it
  // apart top-down: chA = battlements and flag, chB = upper half,
  // chC = lower half, door, and the HP gauge
  const chA = castleHits.length ? ' class="chA"' : "";
  const chB = castleHits.length ? ' class="chB"' : "";
  const chC = castleHits.length ? ' class="chC"' : "";
  const brickR = rng(seed + "brick");
  let upperDetail = "", lowerDetail = "";
  for (let i = 0; i < 8; i++) {
    const bx = KEEP_X + 4 + Math.floor(brickR() * ((KEEP_W - 16) / 4)) * 4;
    const by = keepTop + 16 + Math.floor(brickR() * 18) * 4;
    const r = `<rect x="${bx}" y="${by}" width="8" height="4" fill="${P.stoneDark}" opacity="0.5"/>`;
    if (by < keepTop + 52) upperDetail += r; else lowerDetail += r;
  }
  body += `<g${chC}>
    <rect x="${KEEP_X}" y="${keepTop + 52}" width="${KEEP_W}" height="48" fill="${P.stone}"/>
    ${lowerDetail}
    <rect x="${KEEP_X + 32}" y="${GROUND - 28}" width="16" height="4" fill="${P.stoneDark}"/>
    <rect x="${KEEP_X + 28}" y="${GROUND - 24}" width="24" height="24" fill="${P.stoneDark}"/>
    <rect x="${KEEP_X + 44}" y="${GROUND - 16}" width="4" height="4" fill="${P.stoneLite}"/>
  </g>
  <g${chB}>
    <rect x="${KEEP_X}" y="${keepTop}" width="${KEEP_W}" height="52" fill="${P.stone}"/>
    <rect x="${KEEP_X}" y="${keepTop}" width="${KEEP_W}" height="4" fill="${P.stoneLite}"/>
    ${upperDetail}
    <rect x="${KEEP_X + 36}" y="${keepTop + 20}" width="8" height="4" fill="${P.windowFill}"/>
    <rect x="${KEEP_X + 32}" y="${keepTop + 24}" width="16" height="16" fill="${P.windowFill}"/>
  </g>
  <g${chA}>`;
  for (let i = 0; i < 5; i++) {
    body += `<rect x="${KEEP_X + 2 + i * 16}" y="${keepTop - 8}" width="12" height="8" fill="${P.stone}"/>`;
  }
  body += `<rect x="${KEEP_X + 36}" y="${keepTop - 52}" width="4" height="44" fill="${P.stoneDark}"/>
    <g class="flag" style="transform-origin:${KEEP_X + 40}px ${keepTop - 52}px">
      <g fill="${P.flag}">
        <rect x="${KEEP_X + 40}" y="${keepTop - 52}" width="24" height="4"/>
        <rect x="${KEEP_X + 40}" y="${keepTop - 48}" width="16" height="4"/>
        <rect x="${KEEP_X + 40}" y="${keepTop - 44}" width="24" height="4"/></g>
    </g></g>`;

  // castle HP — pixel gauge, no text
  const hpCells = Math.max(0, Math.round((state.hp / HP_MAX) * 10));
  body += `<g${chC}>`;
  for (let i = 0; i < 10; i++) {
    body += `<rect x="${KEEP_X + 1 + i * 8}" y="${keepTop - 20}" width="6" height="6" fill="${i < hpCells ? P.hpOn : P.hpOff}"/>`;
  }
  body += `</g>`;

  // arrows
  const launchX = KEEP_X + 14, launchY = keepTop - 12;
  const fallDist = GROUND - 8 - launchY;

  // kill shots + death bursts, one per slain monster
  monsters.forEach((m, w) => {
    if (!m.deathT) return;
    const hitX = m.stopX + 6;
    const dx = launchX - hitX;
    body += `<g transform="translate(${launchX} ${launchY})"><g class="kax${w}" style="--dx:-${dx}px">
      <g class="kay${w}" style="--fy:${fallDist}px">
        <g class="kar${w}">
          ${ARROW_SPRITE(P)}
        </g></g></g></g>`;
    const cxB = m.stopX + 11, cyB = GROUND - 9;
    const parts = [[-16, -18], [-2, -22], [14, -16], [-20, -6], [18, -8], [-12, 0], [10, -2], [4, -12], [-6, -14], [8, -20]];
    parts.forEach((p, j) => {
      const sz = j % 4 === 0 ? 6 : 4;
      body += `<g transform="translate(${cxB} ${cyB})"><g class="db${w}" style="--px:${p[0]}px;--py:${p[1]}px">
        <rect x="${-sz / 2}" y="${-sz / 2}" width="${sz}" height="${sz}" fill="${j % 3 === 1 ? P.enemyDark : P.enemy}"/></g></g>`;
    });
  });

  // missiles in flight and their explosions
  missiles.forEach((ms, k) => {
    body += `<g transform="translate(${ms.fromX} ${ms.fromY})"><g class="msx${k}"><g class="msy${k}">
      <g class="msr${k}" style="transform-box:fill-box;transform-origin:center">
        <rect x="-3" y="-3" width="6" height="6" fill="${P.enemyEye}"/>
        <rect x="-1" y="-6" width="2" height="3" fill="${P.flameB}"/></g></g></g></g>`;
  });
  explosions.forEach((e, k) => {
    const sc = e.big ? 1.6 : 1;
    let ex = `<g transform="translate(${e.x} ${e.y})">`;
    ex += `<g class="ef${k}"><rect x="${-7 * sc}" y="${-7 * sc}" width="${14 * sc}" height="${14 * sc}" fill="${P.flameA}"/></g>`;
    const dirs = [[-18, -14], [0, -20], [16, -12], [-22, 0], [20, -2], [-14, 10], [12, 12], [4, -16], [-8, 16], [22, -14]];
    dirs.forEach((p2, j) => {
      const sz = j % 3 === 0 ? 6 : 4;
      ex += `<g class="ep${k}" style="--px:${Math.round(p2[0] * sc)}px;--py:${Math.round(p2[1] * sc)}px">
        <rect x="${-sz / 2}" y="${-sz / 2}" width="${sz}" height="${sz}" fill="${j % 2 ? P.puff : P.flameB}"/></g>`;
    });
    body += ex + `</g>`;
  });

  // extra volley beyond the kill shots lands in the field
  for (let k = kills; k < volley; k++) {
    const targetX = Math.max(60, Math.round(standX - 40 - R() * 180));
    const dx = launchX - targetX;
    const delay = (k * 0.42).toFixed(2);
    body += `<g transform="translate(${launchX} ${launchY})"><g class="ax" style="--dx:-${dx}px;animation-delay:${delay}s">
      <g class="ay" style="--fy:${fallDist}px;animation-delay:${delay}s">
        <g class="ar" style="animation-delay:${delay}s">
          ${ARROW_SPRITE(P)}
        </g></g></g></g>`;
    body += `<g transform="translate(${targetX} ${GROUND - 8})"><g class="puff" style="animation-delay:${delay}s">
      <g fill="${P.puff}"><rect x="-1" y="-6" width="2" height="4"/><rect x="-1" y="2" width="2" height="4"/>
      <rect x="-6" y="-1" width="4" height="2"/><rect x="2" y="-1" width="4" height="2"/></g></g></g>`;
  }
  if (volley === 0) {
    // alert floats over the castle keep itself — no arrows tonight
    const axx = KEEP_X + 12;
    const by = 20;
    body += `<g${chA}><g class="alert">
      <g fill="${P.hpOn}">
        <rect x="${axx - 6}" y="${by}" width="12" height="4"/>
        <rect x="${axx - 10}" y="${by + 4}" width="20" height="12"/>
        <rect x="${axx - 6}" y="${by + 16}" width="12" height="4"/>
        <rect x="${axx - 4}" y="${by + 20}" width="8" height="4"/>
        <rect x="${axx - 2}" y="${by + 24}" width="4" height="4"/></g>
      <rect x="${axx - 2}" y="${by + 4}" width="4" height="8" fill="#ffffff"/>
      <rect x="${axx - 2}" y="${by + 14}" width="4" height="4" fill="#ffffff"/></g></g>`;
  }

  // siege keyframes generated from the schedule (percent of D seconds)
  let siegeCss = "";
  const AD = `${D}s linear infinite`;
  monsters.forEach((m, w) => {
    let pts = `0%{transform:translateX(0);opacity:0}${PT(m.spawnT)}%{transform:translateX(0);opacity:0}${PT(m.spawnT + 0.05)}%{opacity:1}`;
    let lastX = 0;
    for (const st of m.stops) {
      pts += `${PT(st.tA)}%{transform:translateX(${st.x + 30}px)}${PT(Math.max(st.tA + 0.02, st.tL))}%{transform:translateX(${st.x + 30}px)}`;
      lastX = st.x + 30;
    }
    if (m.deathT) {
      pts += `${PT(m.deathT - 0.02)}%{opacity:1;transform:translateX(${lastX}px)}${PT(m.deathT)}%,100%{opacity:0;transform:translateX(${lastX}px)}`;
    } else {
      pts += `99.9%{opacity:1;transform:translateX(${lastX}px)}100%{opacity:0;transform:translateX(${lastX}px)}`;
    }
    siegeCss += `
    .mo${w}{animation:mok${w} ${AD} backwards}
    @keyframes mok${w}{${pts}}`;
    if (m.lunges.length) {
      let lp = `0%{transform:translateX(0)}`;
      let last = 0;
      for (const lt of m.lunges) {
        const a = Math.max(last + 0.01, lt - 0.3), b2 = Math.max(a + 0.01, lt - 0.12), c2 = Math.max(b2 + 0.01, lt);
        lp += `${PT(a)}%{transform:translateX(0)}${PT(b2)}%{transform:translateX(6px)}${PT(c2)}%{transform:translateX(0)}`;
        last = c2;
      }
      lp += `100%{transform:translateX(0)}`;
      siegeCss += `
    .ml${w}{animation:mlk${w} ${AD}}
    @keyframes mlk${w}{${lp}}`;
    }
    if (m.deathT) {
      const dt = m.deathT, la = dt - 0.8;
      siegeCss += `
    .db${w}{animation:dbk${w} ${AD}}
    @keyframes dbk${w}{0%,${PT(dt - 0.02)}%{opacity:0;transform:translate(0,0)}${PT(dt)}%{opacity:1}${PT(dt + 0.25)}%{transform:translate(var(--px),var(--py))}${PT(dt + 0.5)}%{opacity:1;transform:translate(calc(var(--px)*1.7),10px)}${PT(dt + 0.55)}%,100%{opacity:0;transform:translate(calc(var(--px)*1.7),10px)}}
    .kax${w}{animation:kaxk${w} ${AD}}
    @keyframes kaxk${w}{0%,${PT(la - 0.02)}%{transform:translateX(0);opacity:0}${PT(la)}%{opacity:1}${PT(dt)}%{transform:translateX(var(--dx));opacity:1}${PT(dt + 0.05)}%,100%{transform:translateX(var(--dx));opacity:0}}
    .kay${w}{animation:kayk${w} ${AD}}
    @keyframes kayk${w}{0%,${PT(la)}%{transform:translateY(0)}${PT((la + dt) / 2)}%{transform:translateY(-26px)}${PT(dt)}%,100%{transform:translateY(var(--fy))}}
    .kar${w}{animation:kark${w} ${AD}}
    @keyframes kark${w}{0%,${PT(la)}%{transform:rotate(24deg)}${PT(dt)}%,100%{transform:rotate(-40deg)}}`;
    }
  });
  siegeCss += `
    .fall{animation:fallk ${AD}}
    @keyframes fallk{0%{transform:translateY(var(--fd));animation-timing-function:cubic-bezier(.45,0,1,1)}${PT(0.9)}%{transform:translateY(0);animation-timing-function:ease-out}${PT(1.1)}%{transform:translateY(-3px);animation-timing-function:ease-in}${PT(1.3)}%,100%{transform:translateY(0)}}`;
  animBricks.forEach((b) => {
    let ty = 0;
    let pts = `0%{transform:translate(0,0);opacity:1}`;
    // keyframe percentages must stay monotonic: browsers re-sort
    // out-of-order keyframes, which turns a discrete settle drop into a
    // seconds-long linear drift. A settle that can't finish before this
    // brick's death frames begin is dropped — the brick was destroyed
    // before that fall started.
    const deadline = b.deathT === null ? Infinity : b.deathT - (b.melee ? 0.32 : 0.04);
    for (const mv of b.moves) {
      if (mv.t + 0.25 > deadline) break;
      const from = (b.s0 - mv.from) * 9, to = (b.s0 - mv.to) * 9;
      pts += `${PT(mv.t)}%{transform:translate(0,${from}px)}${PT(mv.t + 0.25)}%{transform:translate(0,${to}px)}`;
      ty = to;
    }
    if (b.deathT !== null) {
      if (b.melee) {
        // hold frame: without it the shake's +2px interpolates linearly all
        // the way from the previous transform keyframe, so the brick slowly
        // slides sideways for seconds before the hit lands.
        pts += `${PT(b.deathT - 0.32)}%{transform:translate(0,${ty}px)}${PT(b.deathT - 0.3)}%{transform:translate(2px,${ty}px)}${PT(b.deathT - 0.15)}%{transform:translate(-2px,${ty}px)}`;
      }
      pts += `${PT(b.deathT - 0.02)}%{opacity:1}${PT(b.deathT)}%,100%{opacity:0;transform:translate(0,${ty}px)}`;
    } else {
      pts += `100%{transform:translate(0,${ty}px);opacity:1}`;
    }
    siegeCss += `
    .bv${b.id}{animation:bvk${b.id} ${AD}}
    @keyframes bvk${b.id}{${pts}}`;
  });
  meleeFrags.forEach((f, j) => {
    const t = f.t;
    siegeCss += `
    .fk${j}{animation:fkk${j} ${AD}}
    @keyframes fkk${j}{0%,${PT(t - 0.02)}%{opacity:0;transform:translate(0,0)}${PT(t)}%{opacity:1}${PT(t + 0.3)}%{transform:translate(var(--fx),var(--fy2))}${PT(t + 0.7)}%,100%{opacity:0;transform:translate(calc(var(--fx)*1.7),10px)}}`;
  });
  missiles.forEach((ms, k) => {
    const f = ms.tFire, h2 = ms.tHit, mdx = ms.toX - ms.fromX, mdy = ms.toY - ms.fromY;
    siegeCss += `
    .msx${k}{animation:msxk${k} ${AD}}
    @keyframes msxk${k}{0%,${PT(f - 0.02)}%{transform:translateX(0);opacity:0}${PT(f)}%{opacity:1}${PT(h2)}%{transform:translateX(${mdx}px);opacity:1}${PT(h2 + 0.03)}%,100%{transform:translateX(${mdx}px);opacity:0}}
    .msy${k}{animation:msyk${k} ${AD}}
    @keyframes msyk${k}{0%,${PT(f)}%{transform:translateY(0)}${PT((f + h2) / 2)}%{transform:translateY(${-ms.peak}px)}${PT(h2)}%,100%{transform:translateY(${mdy}px)}}
    .msr${k}{animation:msrk${k} ${AD}}
    @keyframes msrk${k}{0%,${PT(f)}%{transform:rotate(0deg)}${PT(h2)}%,100%{transform:rotate(220deg)}}`;
  });
  explosions.forEach((e, k) => {
    const t = e.t;
    siegeCss += `
    .ef${k}{animation:efk${k} ${AD}}
    @keyframes efk${k}{0%,${PT(t - 0.02)}%{opacity:0;transform:scale(0.3)}${PT(t)}%{opacity:1;transform:scale(1)}${PT(t + 0.18)}%,100%{opacity:0;transform:scale(1.3)}}
    .ep${k}{animation:epk${k} ${AD}}
    @keyframes epk${k}{0%,${PT(t - 0.02)}%{opacity:0;transform:translate(0,0)}${PT(t)}%{opacity:1}${PT(t + 0.3)}%{transform:translate(var(--px),var(--py))}${PT(t + 0.55)}%{opacity:1;transform:translate(calc(var(--px)*1.5),12px)}${PT(t + 0.6)}%,100%{opacity:0;transform:translate(calc(var(--px)*1.5),12px)}}`;
  });
  castleHits.forEach((h2) => {
    const cls = ["chA", "chB", "chC"][h2.stage - 1];
    siegeCss += `
    .${cls}{animation:${cls}k ${AD}}
    @keyframes ${cls}k{0%,${PT(h2.t - 0.02)}%{opacity:1}${PT(h2.t)}%,100%{opacity:0}}`;
  });

  const css = `
    .cloud{animation-name:drift;animation-timing-function:linear;animation-iteration-count:infinite}
    @keyframes drift{from{transform:translateX(-80px)}to{transform:translateX(${W + 60}px)}}
    .tw{animation:tw 2.4s ease-in-out infinite alternate}
    @keyframes tw{from{opacity:0.15}to{opacity:1}}
    .flag{animation:wave 1.7s ease-in-out infinite alternate}
    @keyframes wave{from{transform:scaleX(1)}to{transform:scaleX(0.82)}}
    .hop{animation:hop 0.42s steps(1) infinite}
    @keyframes hop{0%{transform:translateY(0)}50%{transform:translateY(-2px)}100%{transform:translateY(0)}}
    .ax{animation:ax 4.6s linear infinite}
    @keyframes ax{0%{transform:translateX(0)}22%{transform:translateX(var(--dx))}22.01%,100%{transform:translateX(0)}}
    .ay{animation:ay 4.6s linear infinite}
    @keyframes ay{0%{transform:translateY(0)}10%{transform:translateY(-44px)}15%{transform:translateY(-30px)}22%{transform:translateY(var(--fy))}22.01%,100%{transform:translateY(0)}}
    .ar{animation:ar 4.6s linear infinite;opacity:0}
    @keyframes ar{0%{transform:rotate(22deg);opacity:1}21.5%{transform:rotate(-38deg);opacity:1}22%{opacity:0}100%{opacity:0}}
    .puff{animation:puff 4.6s linear infinite;opacity:0}
    @keyframes puff{0%,21.5%{opacity:0;transform:scale(0.4)}23%{opacity:1;transform:scale(1)}30%{opacity:0;transform:scale(1.4)}100%{opacity:0}}
    .alert{animation:tw 0.9s ease-in-out infinite alternate}
    .f1{animation:fl 0.7s steps(1) infinite}
    .f2{animation:fl 0.7s steps(1) 0.35s infinite}
    @keyframes fl{0%{opacity:1}50%{opacity:0}100%{opacity:1}}
    ${siegeCss}
  `;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" role="img">
  <title>Contribution Defense</title>
  <desc>A year of GitHub contributions falls into a castle wall and defends against monsters. Arrows equal yesterday's commits.</desc>
  <style>${css}</style>
  ${body}
</svg>`;
}

// ---------------------------------------------------------------- main

async function main() {
  if (!TOKEN) {
    console.error("GITHUB_TOKEN (or GH_TOKEN) is required");
    process.exit(1);
  }
  const { total, weeks, days } = await fetchCalendar();
  const state = advanceState(days);

  const today = kstToday();
  const completed = days.filter((d) => d.date < today);
  const yesterdayCount = process.env.DEFENSE_TEST_ARROWS
    ? Number(process.env.DEFENSE_TEST_ARROWS)
    : completed.length ? completed[completed.length - 1].count : 0;

  const scene = { weeks, yesterdayCount, state, seed: today };

  fs.mkdirSync(DIST, { recursive: true });
  for (const theme of ["light", "dark"]) {
    fs.writeFileSync(path.join(DIST, `defense-${theme}.svg`), render(theme, scene));
  }
  console.log(`rendered: day ${daysBetween(state.runStart, today) + 1}, hp ${state.hp}, arrows ${yesterdayCount}, weeks ${weeks.length}, total ${total}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { render };
