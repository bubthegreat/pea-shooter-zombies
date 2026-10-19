// Headless balance harness: plays full seeded rounds (30 Hz sim, no network) and prints win rates and route / door / fridge stats.
//
//   node scripts/balance.mjs [seeds=20] [scenario ...]
//
// Scenarios (default: all)
//   afk-easy / afk-normal      a plant kid who never moves (nothing planted: the fridge falls)
//   clumsy-normal              a plant kid who only ever plants and guards the front lawn
//   decent-easy / decent-normal  a scripted plant kid who plants every plot, collects sun, shoots, levels plants up and builds hedges
//   zraid-normal               a zombie kid on autopilot (the bot brain, full fire rate) against the Gardener
//   versus-normal              decent plant kid vs the zombie autopilot kid (bots on both sides)
//   versus-easy                the same on easy bots
//
// Overrides: BAL_CFG='{"fridge":{"fillSeconds":12},"doorHp":{"front":200}}' (top level shallow-merged; nested objects merged
// one level deep). Everything here is simulated time.
//
// This file is the library (scripted kids, scenarios, runRound); scripts/balance.mjs is the command line and
// test/balance.test.js uses the same scenarios as guard-rails.
import { Game } from '../server/sim/game.js';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { dist2D, yawTo } from '../server/sim/vec.js';
import { WORLD } from '../server/sim/world.js';
import { planRoute, itineraryFor } from '../server/sim/nav.js';
import { ensureAI } from '../server/sim/bots.js';

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
const isZombieFighter = (e) => (e.kind === 'bot' || e.kind === 'player') && e.team === 'zombie' && e.state === 'alive';

/** Turn a wanted world direction into f/b/l/r keys relative to the kid's yaw. */
function steer(me, inp, dx, dz) {
  const fwd = { x: -Math.sin(me.yaw), z: -Math.cos(me.yaw) };
  const right = { x: Math.cos(me.yaw), z: -Math.sin(me.yaw) };
  const f = dx * fwd.x + dz * fwd.z;
  const r = dx * right.x + dz * right.z;
  if (f > 0.35) inp.keys.f = true;
  else if (f < -0.35) inp.keys.b = true;
  if (r > 0.35) inp.keys.r = true;
  else if (r < -0.35) inp.keys.l = true;
}

/** Walk to (tx, tz) along the nav graph. Returns true once within `stop`. `face` = keep looking at a target while walking. */
function goTo(g, me, inp, st, tx, tz, stop = 0.8, face = null) {
  if (dist2D(me.x, me.z, tx, tz) <= stop) return true;
  st.replan = (st.replan ?? 0) - 1 / 30;
  if (!st.goal || Math.abs(st.goal.x - tx) > 1.2 || Math.abs(st.goal.z - tz) > 1.2 || st.replan <= 0) {
    st.path = planRoute(g.field, me.x, me.z, tx, tz, 'plant');
    st.pi = 0;
    st.goal = { x: tx, z: tz };
    st.replan = 1.5;
  }
  while (st.pi < st.path.length - 1 && dist2D(me.x, me.z, st.path[st.pi].x, st.path[st.pi].z) < 0.9) st.pi++;
  const wp = st.path[Math.min(st.pi, st.path.length - 1)];
  const dx = wp.x - me.x;
  const dz = wp.z - me.z;
  if (!face) me.yaw = yawTo(dx, dz);
  steer(me, inp, dx, dz);
  // unstick: hop if we are not getting anywhere
  st.lastX ??= me.x;
  st.lastZ ??= me.z;
  st.stuck = dist2D(me.x, me.z, st.lastX, st.lastZ) < 0.02 ? (st.stuck ?? 0) + 1 : 0;
  st.lastX = me.x;
  st.lastZ = me.z;
  if (st.stuck > 8) {
    inp.keys.jump = st.stuck % 12 < 3;
    if (st.stuck > 40) st.replan = 0;
  }
  return false;
}

function nearestOf(g, pred, x, z) {
  let best = null;
  let bd = Infinity;
  for (const e of g.entities.values()) {
    if (!pred(e)) continue;
    const d = dist2D(x, z, e.x, e.z);
    if (d < bd) {
      best = e;
      bd = d;
    }
  }
  return best;
}

// ---- scripted plant kid -----------------------------------------------------------------------------------------------

const PLANT_PREF = ['houseplant', 'gatling', 'melonpult', 'spikesquash', 'snowpea', 'repeater', 'cactus', 'peashooter']; // wall-nuts are left out
// How the kid spreads its turrets over the four plots (front, side, back, garage): about where the zombies come from.
const PLOT_WEIGHT = [0.3, 0.2, 0.2, 0.3];

function upgradeCostOf(c, e) {
  return Math.round(c.plantTypes[e.plantKind].cost * c.plantLevels.cost[(e.level ?? 1) - 1]);
}

/**
 * A kid who plants the best turret it can afford in the plot that has the fewest for its share, collects sunshine, shoots whatever
 * zombie it can see, defends the fridge, levels plants up with spare sunshine and now and then builds a hedge wall.
 * opts.plots limits which plots it plants in (a clumsy kid only does the front).
 */
export function decentPlant(opts = {}) {
  const plots = opts.plots ?? [0, 1, 2, 3];
  const aim = opts.aim ?? 0.08;
  const wall = opts.wall ?? true;
  const shootRange = opts.range ?? 30; // a kid does not snipe at the edge of the map
  const sunRange = opts.sunRange ?? 16;
  const repair = opts.repair ?? true; // mends doors at the repair piles
  const lapse = opts.lapse ?? 4; // seconds in every 25 the kid is not paying attention (looks around, talks, drinks juice)
  return (g, me, st) => {
    const inp = { keys: NO_KEYS(), fire: false, use: false, drop: false, upgrade: false };
    if (me.state !== 'alive') {
      st.path = null;
      st.goal = null;
      return inp;
    }
    const c = g.config;
    st.plantSeq ??= 0;
    st.buildSeq ??= 0;
    if ((g.roundTime + (st.phase ??= (me.id.charCodeAt(0) * 7) % 25)) % 25 < lapse) return inp;
    // who is near and visible
    let target = null;
    let td = 45;
    for (const e of g.entities.values()) {
      if (!isZombieFighter(e)) continue;
      const d = dist2D(me.x, me.z, e.x, e.z);
      if (d < td && d < shootRange && g.field.clearLine(me.x, me.y + c.eyeHeight, me.z, e.x, e.y + 1.0, e.z, 'plant')) {
        target = e;
        td = d;
      }
    }
    const fridge = WORLD.fridge.stand;
    const raider = nearestOf(g, (e) => isZombieFighter(e) && dist2D(e.x, e.z, fridge.x, fridge.z) < 6, me.x, me.z);

    // what to do
    let dest = null;
    let stop = 0.8;
    let doing = 'guard';
    const sun = nearestOf(g, (e) => e.kind === 'sun' && e.y <= (e.ground ?? 0) + c.sunRestHeight + 0.01, me.x, me.z);
    const unlocked = PLANT_PREF.filter((k) => c.plantTypes[k].tier <= me.tier);
    const kind = unlocked.slice(0, 3).find((k) => me.sunshine >= c.plantTypes[k].cost) ?? (me.sunshine >= c.plantTypes.peashooter.cost ? 'peashooter' : null);
    if (raider) {
      doing = 'fridge';
      dest = { x: fridge.x, z: fridge.z - 3 };
      stop = 2.5;
    } else if (kind) {
      // the plot furthest below its share, then its best empty slot (inner rows first)
      const counts = [0, 0, 0, 0];
      for (const e of g.entities.values()) if (e.kind === 'garden') counts[g.slots[e.slot]?.plot ?? 0]++;
      let plot = plots[0];
      let bestScore = Infinity;
      for (const p of plots) {
        const score = counts[p] / PLOT_WEIGHT[p];
        if (score < bestScore) {
          bestScore = score;
          plot = p;
        }
      }
      let slotI = -1;
      let bs = Infinity;
      g.slots.forEach((s, i) => {
        if (s.plot !== plot || s.plantId) return;
        const sc = (3 - s.row) * 100 + dist2D(me.x, me.z, s.x, s.z);
        if (sc < bs) {
          bs = sc;
          slotI = i;
        }
      });
      if (slotI >= 0) {
        const s = g.slots[slotI];
        doing = 'plant';
        dest = s;
        stop = 2.2;
        if (dist2D(me.x, me.z, s.x, s.z) < 3.4) {
          inp.plant = g.plantOrder.indexOf(kind) + 1;
          inp.plantSeq = ++st.plantSeq;
        }
      }
    }
    // a door that is GONE with nobody anywhere near: rebuild it at its pile (stand still, hold E) and carry on to half health (mending partly hurt doors costs more defence than it saves)
    let mend = null;
    if (doing === 'guard' && repair && !target) {
      for (const p of WORLD.repair) {
        const piece = g.cover.get(`door:${p.door}`);
        if (!piece) continue;
        const frac = piece.state === 'alive' ? piece.hp / piece.maxHp : 0;
        const going = st.mending === p.door;
        if (going ? frac >= (opts.mendTo ?? 0.5) : frac >= (opts.mendBelow ?? 0.01)) continue;
        if (nearestOf(g, (e) => isZombieFighter(e) && (dist2D(e.x, e.z, p.x, p.z) < 22 || dist2D(e.x, e.z, me.x, me.z) < 22), p.x, p.z)) continue;
        if (!mend || frac < mend.frac) mend = { p, frac };
      }
    }
    st.mending = mend ? mend.p.door : null;
    if (mend) {
      doing = 'repair';
      dest = mend.p;
      stop = 0.5;
      if (dist2D(me.x, me.z, mend.p.x, mend.p.z) < 1.2) {
        inp.use = true;
        dest = null; // stand still
      }
    } else if (doing === 'guard') {
      // spare sunshine: a hedge wall now and then in front of the house, else level plants up, else grab suns, else wait in the kitchen
      const ups = [...g.entities.values()].filter((e) => e.kind === 'garden' && (e.level ?? 1) < c.plantLevels.max && !c.plantTypes[e.plantKind].noAttack && me.sunshine >= upgradeCostOf(c, e) + 60);
      if (ups.length && !target) {
        const t = ups.reduce((a, b) => (dist2D(me.x, me.z, a.x, a.z) < dist2D(me.x, me.z, b.x, b.z) ? a : b));
        doing = 'upgrade';
        dest = { x: t.x, z: t.z + 1.2 };
        stop = 1.6;
        if (dist2D(me.x, me.z, t.x, t.z) < 2.6) {
          st.upTap = !st.upTap;
          inp.upgrade = st.upTap;
          if (st.upTap) me.yaw = yawTo(t.x - me.x, t.z - me.z);
        }
      } else if (sun && dist2D(me.x, me.z, sun.x, sun.z) < sunRange) {
        doing = 'sun';
        dest = sun;
        stop = 0.5;
      } else {
        dest = { x: -2, z: 15 };
        stop = 1.5;
      }
    } else if (doing === 'plant' && sun && dist2D(me.x, me.z, sun.x, sun.z) < 6) {
      dest = sun; // a sun right next to us first
      stop = 0.4;
    }
    // hedge walls: with plenty of sunshine, wall in front of the front door now and then (one per ~25 s)
    if (wall && me.sunshine > 220 && g.roundTime > (st.nextWall ?? 30) && dist2D(me.x, me.z, 5, -4) < 9) {
      st.nextWall = g.roundTime + 25;
      st.buildSeq++;
      inp.build = 1;
      inp.buildSeq = st.buildSeq;
      inp.bx = Math.round(me.x - 1.5 + (st.buildSeq % 3) * 3);
      inp.bz = Math.round(me.z - 3);
      inp.br = 0;
    } else if (!inp.build) {
      inp.build = 0;
      inp.buildSeq = st.buildSeq;
    }

    // shoot and move
    if (target && !inp.use) {
      const dx = target.x - me.x;
      const dz = target.z - me.z;
      me.yaw = yawTo(dx, dz) + (g.rng() - 0.5) * aim * 2;
      me.pitch = Math.atan2(target.y + 1.0 - (me.y + c.eyeHeight), Math.hypot(dx, dz)) + (g.rng() - 0.5) * aim;
      inp.fire = td < shootRange;
    }
    if (dest) {
      const arrived = goTo(g, me, inp, st, dest.x, dest.z, stop, target);
      if (arrived && !target) me.yaw = me.yaw;
    }
    return inp;
  };
}

// ---- scenarios ---------------------------------------------------------------------------------------------------------

/** A superhuman zombie kid (for the top of the Gardener ladder): 1.2x fire rate, very sharp aim, instant reactions, full lead. */
const PRO_KID = { kidFire: 1.2, autopilot: { aimError: 0.03, reaction: 0.1, lead: 1, shootScale: 1.3 } };

/** A good zombie kid: full fire rate, sharp aim, quick reactions. */
const STRONG_KID = { kidFire: 1, autopilot: { aimError: 0.07, reaction: 0.2, lead: 0.5 } };

/** A good plant kid: the Gardener's planner with a human's gun (full fire rate, decent aim), forts and repairs, no flower pots. */
const GOOD_KID = { brain: 'smart', maxSunshine: 9999, aimError: 0.08, fireScale: 1, reaction: 0.3, head: 0.2, lead: 0.4, strafe: 0.3, forts: 4, pots: 0, retreat: false, collect: 45, repair: 0.5, rebuild: true, upgradeInterval: 15, think: 0.25, shootRange: 25 };

export const LEVEL_IDS = Object.keys(DEFAULT_CONFIG.difficulties);

/** The scenario shapes, for any level: afk (a plant kid who never plants), decent (the scripted kid), versus, zraid (zombie autopilot kid vs the Gardener(s)). */
export function scenarioFor(kind, level) {
  switch (kind) {
    case 'afk': return { difficulty: level, mode: 'coop', humans: [{ team: 'plant' }] };
    case 'decent': return { difficulty: level, mode: 'coop', humans: [{ team: 'plant', script: decentPlant() }] };
    case 'good': return { difficulty: level, mode: 'coop', humans: [{ team: 'plant', autoPlant: {} }] }; // the planner as a kid, against the level's bots
    case 'zraid': return { difficulty: level, mode: 'coop', humans: [{ team: 'zombie', auto: true }] };
    case 'zpro': return { difficulty: level, mode: 'coop', ...PRO_KID, humans: [{ team: 'zombie', auto: true }] }; // a superhuman kid + the Normal bots vs the Gardener(s)
    case 'zsolo': return { difficulty: level, mode: 'coop', features: { waves: false }, ...STRONG_KID, humans: [{ team: 'zombie', auto: true }] }; // the kid alone against the Gardener(s): no zombie bots
    case 'versus': return { difficulty: level, mode: 'versus', humans: [{ team: 'plant', script: decentPlant() }, { team: 'zombie', auto: true }] };
    default: throw new Error(`unknown scenario kind ${kind}`);
  }
}

export const SCENARIOS = {
  'clumsy-normal': { difficulty: 'normal', mode: 'coop', humans: [{ team: 'plant', script: decentPlant({ plots: [0], aim: 0.1, wall: false }) }] },
};
// afk-easy, decent-hard, zraid-insane, versus-normal ... one per kind and level
for (const kind of ['afk', 'decent', 'good', 'zraid', 'zpro', 'zsolo', 'versus']) for (const level of LEVEL_IDS) SCENARIOS[`${kind}-${level}`] = scenarioFor(kind, level);

export function runRound(seed, sc, overrides = {}) {
  const base = makeConfig();
  const cfg = { ...base, ...overrides, features: { ...base.features, ...(overrides.features ?? {}), ...(sc.features ?? {}) } };
  if (sc.autopilot) cfg.autopilot = { ...cfg.autopilot, ...sc.autopilot }; // a different kid
  const g = new Game(cfg, rngFor(seed * 7919 + 13));
  // like a lobby: everybody is seated first, so the level knows which side the kids are on when the round's doors and bots are made
  g.startMatch({ mode: sc.mode, difficulty: sc.difficulty, players: sc.humans.map((spec, i) => ({ id: i === 0 ? 'h' : 'k', name: i === 0 ? 'Kid' : 'Kid2', team: spec.team })) });
  const humans = sc.humans.map((spec, i) => {
    const id = i === 0 ? 'h' : 'k';
    const me = g.entities.get(id);
    if (spec.autoPlant) {
      // a plant kid played by the Gardener's planner (bots.js autopilotPlant), with a human's gun and its own profile
      me.autopilot = true;
      me.autopilotPlant = true;
      me.gardenerCfg = { ...GOOD_KID, ...spec.autoPlant };
      ensureAI(g, me);
    } else if (spec.auto) {
      me.autopilot = true;
      me.autopilotFireScale = sc.kidFire ?? Number(process.env.BAL_KIDFIRE ?? 0.5);
      ensureAI(g, me);
    }
    return { id, me, script: spec.script ?? null, st: {} };
  });
  const r = {
    doorsBroken: 0, fridgeMax: 0, planted: 0, turretsLost: 0, spawned: { front: 0, left: 0, right: 0 }, reached: { front: 0, left: 0, right: 0 },
    seen: new Set(), at: new Set(), kidKills: 0, kidSun: 0, minGarden: 99, maxGarden: 0, forts: 0, doorAt: {}, firstDoorT: null, firstFridgeT: null,
  };
  const dt = 1 / 30;
  while (g.phase === 'playing' && g.roundTime < 600) {
    for (const h of humans) {
      if (!h.script) continue;
      const inp = h.script(g, h.me, h.st);
      g.handleInput(h.id, { ...inp, yaw: h.me.yaw, pitch: h.me.pitch });
    }
    g.tick(dt);
    for (const e of g.drainEvents()) {
      if (e.type === 'coverBreak' && String(e.id).startsWith('door:')) {
        r.doorsBroken++;
        r.doorAt[e.id] = Math.round(g.roundTime);
        r.firstDoorT ??= g.roundTime;
      }
      if (e.type === 'plant') r.planted++;
      if (e.type === 'build') r.forts++;
      if (e.type === 'wilt' && e.plantKind) r.turretsLost++;
      if (e.type === 'fridgeAlarm') r.firstFridgeT ??= g.roundTime;
    }
    r.fridgeMax = Math.max(r.fridgeMax, g.fridge.meter);
    const n = g.gardenCount();
    r.minGarden = Math.min(r.minGarden, n);
    r.maxGarden = Math.max(r.maxGarden, n);
    for (const e of g.entities.values()) {
      if (!isZombieFighter(e) || !e.ai || !e.ai.itin) continue;
      const it = e.ai.itin;
      if (!r.seen.has(e.id)) {
        r.seen.add(e.id);
        r.spawned[it.route]++;
      }
      const last = it.nodes[it.nodes.length - 1];
      if (!r.at.has(e.id) && dist2D(e.x, e.z, last.x, last.z) < 6) {
        r.at.add(e.id);
        r.reached[it.route]++;
      }
    }
  }
  r.winner = g.winner;
  r.t = g.roundTime;
  const kid = humans.find((h) => h.me.team === 'plant')?.me;
  if (kid) {
    r.kidKills = kid.progress;
    r.kidSun = kid.sunshine;
    r.kidTier = kid.tier;
  }
  return r;
}

