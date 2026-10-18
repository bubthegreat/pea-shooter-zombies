// Headless balance harness: plays full seeded rounds (30 Hz sim, no network) and prints win / mower / tool stats.
//
//   node scripts/balance.mjs [seeds=20] [scenario ...]
//
// Scenarios (default: all)
//   afk-easy / afk-normal   a plant kid who never moves or shoots (the worst case for the plants)
//   active-normal           a scripted plant kid who stands behind the front row, shoots, plants unlocked plants and levels them up
//   zdirect-normal          a scripted zombie kid who zig-zags straight at the garden shooting it
//   zmower-normal           a zombie kid who runs the right flank to the garage and mows
//   zweed-normal            a zombie kid who grabs the weed eater and shreds the garden
//   zafk-normal             a zombie kid who never moves (plants have only turrets + the Gardener against the bots)
//
// Overrides: BAL_CFG='{"mowerBotChance":0.4,"plantTypes":{"cactus":{"range":30}},"botItemChance":{"weed_eater":0.2}}'
// (top level shallow-merged; nested objects merged one level deep). The wall clock may jump in some sandboxes, so
// everything here is simulated time.
import { Game } from '../server/sim/game.js';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { dist2D, yawTo } from '../server/sim/vec.js';
import { WORLD } from '../server/sim/world.js';

// BAL_MOWER_Z=38 moves the mower's parking spot (world layout experiments)
if (process.env.BAL_MOWER_Z) WORLD.mowerHome.z = Number(process.env.BAL_MOWER_Z);

function rngFor(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeConfig() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  const over = process.env.BAL_CFG ? JSON.parse(process.env.BAL_CFG) : {};
  const merge = (dst, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') merge(dst[k], v);
      else dst[k] = v;
    }
  };
  merge(cfg, over);
  return cfg;
}

const NO_KEYS = () => ({ f: false, b: false, l: false, r: false, jump: false });

/** Walk toward (tx, tz); returns true once within `stop`. */
function walk(kid, inp, tx, tz, stop = 0.6) {
  const dx = tx - kid.x;
  const dz = tz - kid.z;
  const d = Math.hypot(dx, dz);
  kid.yaw = yawTo(dx, dz);
  if (d > stop) inp.keys.f = true;
  return d <= stop;
}

function nearestOf(g, pred, x, z) {
  let best = null;
  for (const e of g.entities.values()) {
    if (!pred(e)) continue;
    if (!best || dist2D(x, z, e.x, e.z) < dist2D(x, z, best.x, best.z)) best = e;
  }
  return best;
}

const isGarden = (e) => e.kind === 'garden';

/** Where a clever zombie kid heads to reach the garage: out to the right-hand flank, up it, in through the door. */
function flankWaypoint(me, goal) {
  if (me.x < 24 && me.z < -12) return [27, -22];
  if (me.z < 22) return [27, 24];
  return [Math.abs(me.x - 20) > 3 && me.z < 29 ? 20 : goal.x, me.z < 29 ? 31 : goal.z];
}

// ---- scripted humans ---------------------------------------------------------------------------

// Best-first shopping list for the scripted plant kid (wall-nuts are left out: they do not shoot).
const PLANT_PREF = ['houseplant', 'gatling', 'melonpult', 'spikesquash', 'snowpea', 'repeater', 'cactus', 'peashooter'];

/**
 * Plant kid who stays near the garden, shoots the nearest zombie, and spends sunshine: it plants the best unlocked plant it can
 * afford in the nearest empty slot, and once the garden is full it levels plants up (weakest first).
 */
function activePlant(g, me, st) {
  const inp = { keys: NO_KEYS(), fire: false, use: false, drop: false, upgrade: false };
  if (me.state !== 'alive') return inp;
  const c = g.config;
  // collect sunshine lying around, otherwise hold the line just behind the garden
  const sun = nearestOf(g, (e) => e.kind === 'sun' && e.y <= c.sunRestHeight + 0.01, me.x, me.z);
  const zed = nearestOf(g, (e) => (e.kind === 'bot' || e.kind === 'player') && e.team === 'zombie' && e.state === 'alive', me.x, me.z);
  // buys from its three best unlocked plants (saving up rather than spamming peashooters), else levels plants up
  const unlocked = PLANT_PREF.filter((k) => c.plantTypes[k].tier <= me.tier);
  const kind = unlocked.slice(0, 3).find((k) => me.sunshine >= c.plantTypes[k].cost);
  const empty = kind ? g.slots.map((s, i) => ({ s, i })).filter(({ s }) => !s.plantId) : [];
  const nearestTo = (list, pos) => list.reduce((a, b) => (dist2D(me.x, me.z, pos(a).x, pos(a).z) < dist2D(me.x, me.z, pos(b).x, pos(b).z) ? a : b));
  let dest = { x: 0, z: 14 };
  const ups = [...g.entities.values()].filter((e) => {
    if (e.kind !== 'garden' || (e.level ?? 1) >= c.plantLevels.max || c.plantTypes[e.plantKind].noAttack) return false;
    return me.sunshine >= upgradeCostOf(c, e);
  });
  if (empty.length) {
    const e = nearestTo(empty, (q) => q.s);
    dest = { x: e.s.x, z: e.s.z + 2 };
    if (dist2D(me.x, me.z, e.s.x, e.s.z) < 3) {
      st.plantSeq = (st.plantSeq ?? 0) + 1;
      inp.plant = g.plantOrder.indexOf(kind) + 1;
      inp.plantSeq = st.plantSeq;
    }
  } else if (ups.length) {
    // level up the weakest plant first, strongest type among equals, closest wins ties
    const rank = (e) => (e.level ?? 1) * 100 - c.plantTypes[e.plantKind].tier * 10 + dist2D(me.x, me.z, e.x, e.z) * 0.1;
    const t = ups.reduce((a, b) => (rank(a) <= rank(b) ? a : b));
    dest = { x: t.x, z: t.z + 1.5 };
    if (dist2D(me.x, me.z, t.x, t.z) < 2.4) {
      st.upTap = !st.upTap;
      inp.upgrade = st.upTap; // alternate so there is a rising edge
    }
  } else if (sun && dist2D(me.x, me.z, sun.x, sun.z) < 25) dest = sun;
  const moving = dist2D(me.x, me.z, dest.x, dest.z) > 0.8;
  if (zed && dist2D(me.x, me.z, zed.x, zed.z) < 45) {
    const dx = zed.x - me.x;
    const dz = zed.z - me.z;
    me.yaw = yawTo(dx, dz) + (g.rng() - 0.5) * 0.04;
    me.pitch = Math.atan2(zed.y + 1.0 - (me.y + g.config.eyeHeight), Math.hypot(dx, dz));
    inp.fire = true;
    if (moving) {
      const wx = dest.x - me.x;
      const wz = dest.z - me.z;
      // strafe toward the destination using keys relative to yaw
      const fwd = { x: -Math.sin(me.yaw), z: -Math.cos(me.yaw) };
      const right = { x: Math.cos(me.yaw), z: -Math.sin(me.yaw) };
      const f = wx * fwd.x + wz * fwd.z;
      const r = wx * right.x + wz * right.z;
      if (f > 0.5) inp.keys.f = true;
      else if (f < -0.5) inp.keys.b = true;
      if (r > 0.5) inp.keys.r = true;
      else if (r < -0.5) inp.keys.l = true;
    }
  } else if (moving) walk(me, inp, dest.x, dest.z, 0.8);
  return inp;
}

/** Zombie kid who zig-zags at the nearest garden plant and shoots it. */
function zombieDirect(g, me) {
  const inp = { keys: NO_KEYS(), fire: false, use: false, drop: false };
  if (me.state !== 'alive') return inp;
  const plant = nearestOf(g, isGarden, me.x, me.z);
  if (!plant) return inp;
  const dx = plant.x - me.x;
  const dz = plant.z - me.z;
  const d = Math.hypot(dx, dz);
  me.yaw = yawTo(dx, dz);
  me.pitch = Math.atan2(plant.y + 0.6 - (me.y + g.config.eyeHeight), d);
  if (d > 12) inp.keys.f = true;
  if (Math.floor(g.time / 0.9) % 2 === 0) inp.keys.l = true;
  else inp.keys.r = true;
  if (g.time % 1.5 < 0.05) inp.keys.jump = true;
  inp.fire = d < 30;
  return inp;
}

/** Zombie kid who runs the flank to the garage; `want` = 'mower' | 'weed_eater'. */
function zombieErrand(g, me, want, st) {
  const inp = { keys: NO_KEYS(), fire: false, use: false, drop: false };
  if (me.state !== 'alive') return inp;
  const m = g.mower;
  const zig = () => {
    if (Math.floor(g.time / 0.9) % 2 === 0) inp.keys.l = true;
    else inp.keys.r = true;
  };
  if (want === 'mower') {
    if (g.isDriving(me)) {
      const plant = nearestOf(g, isGarden, me.x, me.z);
      if (plant) walk(me, inp, plant.x, plant.z, 0);
      return inp;
    }
    if (m.state === 'starting' && m.driver === me.id) {
      inp.use = true;
      return inp;
    }
    if (m.state !== 'idle') return zombieDirect(g, me); // wrecked or taken: shoot the garden instead
    if (dist2D(me.x, me.z, m.x, m.z) > 2) {
      walk(me, inp, ...flankWaypoint(me, m), 1.5);
      if (me.z < 22) zig();
    } else inp.use = true;
    return inp;
  }
  // weed eater / other tool: grab it, then go and use it on the nearest plant
  const rack = g.racks.get(want);
  if (me.item === want) {
    const plant = nearestOf(g, isGarden, me.x, me.z);
    if (!plant) return inp;
    const d = dist2D(me.x, me.z, plant.x, plant.z);
    walk(me, inp, plant.x, plant.z, 1.5);
    inp.fire = d < 3.2;
    if (d > 4) zig();
    return inp;
  }
  if (me.item) return inp;
  if (!rack.available) return zombieDirect(g, me);
  if (dist2D(me.x, me.z, rack.x, rack.z) > 1.4) {
    walk(me, inp, ...flankWaypoint(me, rack), 1.2);
    if (me.z < 22) zig();
  } else {
    st.tap = !st.tap;
    inp.use = st.tap; // alternate so there is a rising edge
  }
  return inp;
}

function upgradeCostOf(c, e) {
  return Math.round(c.plantTypes[e.plantKind].cost * c.plantLevels.cost[(e.level ?? 1) - 1]);
}

// humans[0] is 'h'; a second human is 'k'. script(g, me, st) returns an input (or null = idle).
const SCENARIOS = {
  'afk-easy': { difficulty: 'easy', mode: 'coop', humans: [{ team: 'plant' }] },
  'afk-normal': { difficulty: 'normal', mode: 'coop', humans: [{ team: 'plant' }] },
  'active-normal': { difficulty: 'normal', mode: 'coop', humans: [{ team: 'plant', script: activePlant }] },
  'zdirect-normal': { difficulty: 'normal', mode: 'versus', humans: [{ team: 'zombie', script: zombieDirect }] },
  'zmower-normal': { difficulty: 'normal', mode: 'versus', humans: [{ team: 'zombie', script: (g, me, st) => zombieErrand(g, me, 'mower', st) }] },
  'zweed-normal': { difficulty: 'normal', mode: 'versus', humans: [{ team: 'zombie', script: (g, me, st) => zombieErrand(g, me, 'weed_eater', st) }] },
  'zafk-normal': { difficulty: 'normal', mode: 'coop', humans: [{ team: 'zombie' }] },
  'versus-normal': { difficulty: 'normal', mode: 'versus', humans: [{ team: 'plant', script: activePlant }, { team: 'zombie', script: zombieDirect }] },
  'versus-mower': { difficulty: 'normal', mode: 'versus', humans: [{ team: 'plant', script: activePlant }, { team: 'zombie', script: (g, me, st) => zombieErrand(g, me, 'mower', st) }] },
};

function runRound(seed, sc) {
  const cfg = makeConfig();
  const g = new Game(cfg, rngFor(seed * 7919 + 13));
  const humans = sc.humans.map((spec, i) => {
    const id = i === 0 ? 'h' : 'k';
    g.addPlayer(id, { team: spec.team, mode: sc.mode, difficulty: sc.difficulty });
    return { id, me: g.entities.get(id), script: spec.script ?? null, st: { tap: false } };
  });
  const me = humans.find((h) => h.me.team === 'zombie')?.me ?? humans[0].me; // the stats follow the zombie kid if there is one
  const r = {
    minGarden: 99, destroyed: 0, mows: 0, mowerStarted: false, mowerDrove: false, mowerWrecked: 0,
    takes: {}, toolKills: {}, humanConverts: 0, humanAlive: 0, humanTier: 0, kidNearGarden: false, planted: 0, ups: 0, avgLevel: 0, kinds: {},
  };
  const dt = 1 / 30;
  while (g.phase === 'playing' && g.roundTime < 600) {
    const holders = new Map();
    for (const e of g.entities.values()) if (e.item) holders.set(e.id, e.item);
    for (const h of humans) {
      if (!h.script) continue;
      const inp = h.script(g, h.me, h.st);
      g.handleInput(h.id, { ...inp, yaw: h.me.yaw, pitch: h.me.pitch });
    }
    g.tick(dt);
    for (const e of g.drainEvents()) {
      if (e.type === 'mow') {
        r.mows++;
        r.toolKills.mower = (r.toolKills.mower ?? 0) + 1;
      }
      if (e.type === 'wilt' && e.plantKind && e.by) {
        r.destroyed++;
        const item = holders.get(e.by);
        if (item) r.toolKills[item] = (r.toolKills[item] ?? 0) + 1;
      }
      if (e.type === 'plant' && e.by === 'h') {
        r.planted++;
        r.kinds[e.plantKind] = (r.kinds[e.plantKind] ?? 0) + 1;
      }
      if (e.type === 'plantUp' && e.by === 'h') r.ups++;
      if (e.type === 'item_take') r.takes[e.itemId] = (r.takes[e.itemId] ?? 0) + 1;
      if (e.type === 'mower_destroyed') r.mowerWrecked++;
      if (e.type === 'convert' && e.id === me.id) r.humanConverts++;
    }
    r.minGarden = Math.min(r.minGarden, g.gardenCount());
    if (g.mower.state === 'starting' || g.mower.state === 'driving') r.mowerStarted = true;
    if (g.mower.state === 'driving') r.mowerDrove = true;
    if (me.state === 'alive') r.humanAlive += dt;
    if (me.team === 'zombie' && me.state === 'alive') {
      for (const e of g.entities.values()) if (e.kind === 'garden' && dist2D(me.x, me.z, e.x, e.z) < 10) r.kidNearGarden = true;
    }
  }
  r.winner = g.winner;
  r.t = g.roundTime;
  r.humanTier = me.tier;
  const kid = humans.find((h) => h.me.team === 'plant' && h.script)?.me;
  if (kid) {
    r.kidTier = kid.tier;
    r.kidKills = kid.progress;
    r.kidSun = kid.sunshine;
  }
  const plants = [...g.entities.values()].filter((e) => e.kind === 'garden');
  r.avgLevel = plants.length ? plants.reduce((a, e) => a + (e.level ?? 1), 0) / plants.length : 0;
  return r;
}

const nSeeds = Number(process.argv[2]) || 20;
const wanted = process.argv.slice(3);
const fmt = (x, d = 1) => x.toFixed(d);
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const rs = [];
  for (let s = 1; s <= nSeeds; s++) rs.push(runRound(s, sc));
  const n = rs.length;
  const sum = (f) => rs.reduce((a, r) => a + f(r), 0);
  const count = (f) => rs.filter(f).length;
  const takes = {};
  const toolKills = {};
  for (const r of rs) {
    for (const [k, v] of Object.entries(r.takes)) takes[k] = (takes[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.toolKills)) toolKills[k] = (toolKills[k] ?? 0) + v;
  }
  const per = (o) => Object.entries(o).map(([k, v]) => `${k}:${fmt(v / n)}`).join(' ') || '-';
  const line = [
    name.padEnd(15),
    `zombieWins ${count((r) => r.winner === 'zombie')}/${n}`,
    `endT ${fmt(sum((r) => r.t) / n, 0)}s`,
    `minGarden ${fmt(sum((r) => r.minGarden) / n)}/20`,
    `destroyed ${fmt(sum((r) => r.destroyed) / n)}`,
    `mowerUsed ${count((r) => r.mowerStarted)}/${n}`,
    `mows/rd ${fmt(sum((r) => r.mows) / n)}`,
    `mowerWrecked/rd ${fmt(sum((r) => r.mowerWrecked) / n)}`,
    `toolTakes/rd {${per(takes)}}`,
    `plantsKilledBy/rd {${per(toolKills)}}`,
  ];
  if (sc.humans.some((h) => h.team === 'plant' && h.script)) {
    const kinds = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.kinds)) kinds[k] = (kinds[k] ?? 0) + v;
    line.push(`planted/rd ${fmt(sum((r) => r.planted) / n)} {${per(kinds)}}`, `plantUps/rd ${fmt(sum((r) => r.ups) / n)}`, `avgLevel@end ${fmt(sum((r) => r.avgLevel) / n, 2)}`, `kidTier ${fmt(sum((r) => r.kidTier ?? 0) / n)}`, `kidKills ${fmt(sum((r) => r.kidKills ?? 0) / n)}`, `kidSun@end ${fmt(sum((r) => r.kidSun ?? 0) / n, 0)}`);
  }
  if (sc.humans.some((h) => h.team === 'zombie')) {
    line.push(`humanConverts ${fmt(sum((r) => r.humanConverts) / n)}`, `humanLife ${fmt(sum((r) => r.humanAlive) / Math.max(1, sum((r) => r.humanConverts) + n))}s`, `nearGarden ${count((r) => r.kidNearGarden)}/${n}`, `topTier ${fmt(sum((r) => r.humanTier) / n)}`);
  }
  console.log(line.join(' | '));
}
