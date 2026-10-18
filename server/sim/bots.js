// Bot brains. Bots act exactly like players: each tick a brain writes yaw/pitch and bot.input (keys, fire, use) and the
// normal movement/weapon code does the rest.
//
// Zombie bots pick one of three routes at spawn (front lawn, left gravel path, right hedge path), walk its waypoints to a
// door, and then head for the fridge with the nav graph. Whatever destructible thing blocks the way (a closed door, a
// gravestone, a fort wall) they shoot until it is gone. The Gardener (the computer plant kid) walks the plots with the
// same graph.
import { WORLD } from './world.js';
import { tryPlant, tryUpgrade, upgradeCost } from './garden.js';
import { planRoute, chooseItinerary } from './nav.js';
import { dist2D, rightVec, forwardVec, yawTo } from './vec.js';

const isFighter = (e) => e.kind === 'player' || e.kind === 'bot';
const EYE_LOS = 1.4;

/** Create the brain for a bot that has none (new spawns). Plant-team bots other than the Gardener are inert. */
export function ensureAI(game, bot) {
  if (bot.ai) return bot.ai;
  const c = game.config;
  const base = {
    think: game.rng() * c.botThinkInterval,
    targetId: null,
    react: 0,
    errYaw: 0,
    errPitch: 0,
    errTimer: 0,
    path: [],
    pi: 0,
    replan: 0,
    lx: bot.x,
    lz: bot.z,
    stuck: 0,
    side: 0,
    sideT: 0,
    blocker: null,
    moving: false,
  };
  if (bot.team === 'zombie') {
    bot.fireScale = bot.kind === 'player' ? bot.autopilotFireScale ?? 1 : game.difficultyConfig().fireScale; // an autopilot kid shoots at its own rate
    const itin = chooseItinerary(game.rng);
    const errand = game.rng() < c.parts.botChance ? {} : null; // fetch a part, install it, use what it powers
    bot.ai = { ...base, role: 'zombie', itin, mode: 'route', errand, coin: game.rng(), goal: null, goalKey: null };
    bot.ai.path = itin.nodes.slice();
  } else {
    bot.fireScale = c.gardener.fireScale;
    bot.ai = { ...base, role: bot.isGardener ? 'gardener' : 'inert', slotIdx: -1, upId: null, upTimer: c.gardener.upgradeInterval, dest: null };
  }
  return bot.ai;
}

function findGardener(game) {
  for (const e of game.entities.values()) if (e.kind === 'bot' && e.isGardener) return e;
  return null;
}

export function spawnGardener(game) {
  const c = game.config;
  const spawn = WORLD.plantSpawn;
  const bot = game.spawnBot('plant', spawn.x + (game.rng() * 2 - 1) * 1.5, spawn.z);
  bot.isGardener = true;
  bot.name = c.gardener.name;
  bot.sunshine = c.gardener.startSunshine;
  ensureAI(game, bot);
  return bot;
}

/** Exactly one Gardener while no human plays plants; none otherwise. It comes back a while after it wilts. */
function stepGardenerSpawn(game, dt) {
  const gardener = findGardener(game);
  const plantHumans = game.humans().some((h) => h.team === 'plant');
  if (plantHumans) {
    if (gardener) game.removeEntity(gardener);
    game.gardenerTimer = 0;
    return;
  }
  if (gardener) return;
  if (game.gardenerTimer > 0) {
    game.gardenerTimer -= dt;
    if (game.gardenerTimer > 0) return;
  }
  spawnGardener(game);
}

/** Nearest living entity of `list` within maxDist that the bot can see (up to the 4 closest are line-of-sight checked). */
function nearestVisible(game, b, list, maxDist) {
  const near = [];
  for (const e of list) {
    if (e.state !== 'alive') continue;
    const d = dist2D(b.x, b.z, e.x, e.z);
    if (d <= maxDist) near.push([d, e]);
  }
  near.sort((p, q) => p[0] - q[0]);
  for (let i = 0; i < Math.min(4, near.length); i++) {
    const t = near[i][1];
    if (game.field.clearLine(b.x, b.y + EYE_LOS, b.z, t.x, t.y + t.height * game.config.turretAimHeight, t.z, b.team)) return t;
  }
  return null;
}

/** Convert a world-space walking direction into f/b/l/r keys relative to the bot's yaw. */
function setMoveKeys(b, dx, dz) {
  const k = b.input.keys;
  k.f = k.b = k.l = k.r = false;
  if (dx === 0 && dz === 0) return;
  const fwd = forwardVec(b.yaw);
  const right = rightVec(b.yaw);
  const f = dx * fwd.x + dz * fwd.z;
  const r = dx * right.x + dz * right.z;
  if (f > 0.35) k.f = true;
  else if (f < -0.35) k.b = true;
  if (r > 0.35) k.r = true;
  else if (r < -0.35) k.l = true;
}

/** Aim at a target (anything with x, y, z, height) with the bot's current (periodically re-rolled) error. */
function aimAt(game, b, ai, t, aimError, dt) {
  const c = game.config;
  ai.errTimer -= dt;
  if (ai.errTimer <= 0) {
    ai.errTimer = c.botAimRerollInterval;
    ai.errYaw = (game.rng() * 2 - 1) * aimError;
    ai.errPitch = (game.rng() * 2 - 1) * aimError;
  }
  const dx = t.x - b.x;
  const dz = t.z - b.z;
  const dy = t.y + t.height * c.turretAimHeight - (b.y + c.eyeHeight);
  b.yaw = yawTo(dx, dz) + ai.errYaw;
  b.pitch = Math.atan2(dy, Math.hypot(dx, dz)) + ai.errPitch;
}

/** The next point of the bot's path it still has to reach, or null when the path is done. */
function nextPoint(b, ai, stop) {
  while (ai.pi < ai.path.length) {
    const wp = ai.path[ai.pi];
    const last = ai.pi === ai.path.length - 1;
    if (Math.hypot(wp.x - b.x, wp.z - b.z) < (last ? stop : 0.8)) {
      ai.pi++;
      continue;
    }
    return wp;
  }
  return null;
}

function setPath(ai, pts) {
  ai.path = pts;
  ai.pi = 0;
}

/** A pseudo-target for aiming at a destructible piece (a door, a gravestone). */
function pieceTarget(piece) {
  const mid = Math.min(piece.y1, piece.y0 + 1.4);
  return { x: piece.x, z: piece.z, y: piece.y0, height: Math.max(0.5, (mid - piece.y0) / 0.6) };
}

/**
 * Stuck detection (every think tick): a bot that wants to move but isn't making progress shoots the destructible thing in
 * front of it, or else sidesteps and jumps.
 */
function checkStuck(game, b, ai, dir, speed) {
  const c = game.config;
  const dt = c.botThinkInterval;
  const moved = Math.hypot(b.x - ai.lx, b.z - ai.lz);
  ai.lx = b.x;
  ai.lz = b.z;
  if (!ai.moving || ai.blocker) {
    ai.stuck = 0;
    return;
  }
  if (moved < speed * dt * 0.3) ai.stuck += dt;
  else {
    ai.stuck = 0;
    return;
  }
  if (ai.stuck < c.botStuckTime) return;
  const hit = dir ? game.field.segment(b.x, b.y + 1.0, b.z, b.x + dir.x * 2.6, b.y + 1.0, b.z + dir.z * 2.6, 0.1, b.team) : null;
  const piece = hit ? game.cover.pieceOf(hit.c) : null;
  if (piece && game.cover.canHurt(piece, b.team)) {
    ai.blocker = piece.id;
    ai.stuck = 0;
    return;
  }
  ai.side = ai.side === 0 ? (game.rng() < 0.5 ? -1 : 1) : -ai.side;
  ai.sideT = 0.9;
  ai.jump = true;
  if (ai.stuck > 2.5) {
    ai.replan = 0; // find another way
    ai.stuck = 0;
  }
}

/** The piece a bot is shooting its way through, if it is still standing. */
function blockerPiece(game, ai) {
  if (!ai.blocker) return null;
  const p = game.cover.get(ai.blocker);
  if (!p || p.state !== 'alive') {
    ai.blocker = null;
    return null;
  }
  return p;
}

/** Walk-and-shoot step shared by every roaming bot. `target` is the thing to shoot (entity or piece pseudo-target) or null. */
function moveAndShoot(game, b, ai, dt, { target, aimError, stop, canMove = true, noFire = false }) {
  const inp = b.input;
  const wp = canMove ? nextPoint(b, ai, stop) : null;
  let dir = { x: 0, z: 0 };
  ai.moving = false;
  ai.dir = null;
  if (wp) {
    const dx = wp.x - b.x;
    const dz = wp.z - b.z;
    const d = Math.hypot(dx, dz) || 1;
    dir = { x: dx / d, z: dz / d };
    ai.moving = true;
    ai.dir = dir;
  }
  if (ai.sideT > 0) {
    // stuck: shuffle sideways (and hop) for a moment
    ai.sideT -= dt;
    const r = { x: -dir.z, z: dir.x };
    dir = { x: dir.x * 0.4 + r.x * ai.side * 0.9, z: dir.z * 0.4 + r.z * ai.side * 0.9 };
    if (ai.jump) {
      inp.keys.jump = true;
      ai.jump = false;
    }
  }
  if (target) {
    aimAt(game, b, ai, target, aimError, dt);
    ai.react -= dt;
    inp.fire = ai.react <= 0;
  } else if (ai.moving) {
    b.yaw = yawTo(dir.x, dir.z);
    b.pitch = 0;
  }
  setMoveKeys(b, dir.x, dir.z);
}

/** Where a bot carrying a part should install it: the mower or a rack hook that needs it. */
function installSpot(game, b) {
  const c = game.config;
  const kind = b.carry;
  const m = game.mower;
  const rackNeed = [...game.racks.values()].filter((r) => c.equipment[r.itemId].needs === kind && !r.powered && r.available);
  const mowerNeed = m && m.state !== 'destroyed' && !m.parts[kind];
  // spark plugs only fit the mower; gas goes to the weed eater first; batteries split between the mower and the tools
  let useMower = mowerNeed && (kind === 'plug' || !rackNeed.length || (kind === 'battery' && (b.ai.coin ?? 0) < 0.5));
  if (!mowerNeed) useMower = false;
  if (useMower) return { type: 'mower', x: m.x, z: m.z, range: c.mowerUseRange - 0.4 };
  let best = null;
  for (const r of rackNeed) if (!best || dist2D(b.x, b.z, r.x, r.z) < dist2D(b.x, b.z, best.x, best.z)) best = r;
  return best ? { type: 'rack', rack: best, x: best.x, z: best.z, range: c.rackUseRange - 0.5 } : null;
}

/** Part errands: fetch the nearest part, install it, take the tool it powered. Returns the walking goal (or null when done). */
function errandGoal(game, b, ai) {
  const c = game.config;
  const er = ai.errand;
  if (b.carry) {
    const tgt = installSpot(game, b);
    if (!tgt) {
      ai.errand = null;
      return null;
    }
    if (dist2D(b.x, b.z, tgt.x, tgt.z) <= tgt.range) {
      b.usePressed = true; // installs (parts.js); the press is spent there
      if (tgt.type === 'rack') er.take = tgt.rack.itemId;
    }
    return { x: tgt.x, z: tgt.z, stop: tgt.range * 0.7 };
  }
  if (er.take) {
    const rack = game.racks.get(er.take);
    if (!rack || !rack.available || !rack.powered) {
      ai.errand = null;
      return null;
    }
    if (dist2D(b.x, b.z, rack.x, rack.z) <= c.rackUseRange - 0.4) b.usePressed = true; // takes the tool
    else return { x: rack.x, z: rack.z, stop: c.rackUseRange - 0.8 };
    return { x: rack.x, z: rack.z, stop: 1 };
  }
  let part = null;
  for (const e of game.entities.values()) {
    if (e.kind !== 'part' || e.state !== 'alive') continue;
    if (!part || dist2D(b.x, b.z, e.x, e.z) < dist2D(b.x, b.z, part.x, part.z)) part = e;
  }
  if (!part) {
    ai.errand = null;
    return null;
  }
  if (dist2D(b.x, b.z, part.x, part.z) <= c.parts.pickRange - 0.4 && Math.abs(part.y - b.y) < 1.5) b.usePressed = true;
  return { x: part.x, z: part.z, stop: 0.6 };
}

function nearestAlive(list, x, z) {
  let best = null;
  let bd = Infinity;
  for (const e of list) {
    if (e.state !== 'alive') continue;
    const d = dist2D(x, z, e.x, e.z);
    if (d < bd) {
      best = e;
      bd = d;
    }
  }
  return best;
}

/** The intent for this think tick: { x, z, stop } to walk to (planned with the nav graph), or null for the route / fridge default. */
function zombieGoal(game, b, ai, ctx) {
  const c = game.config;
  const m = game.mower;
  if (game.isDriving(b)) {
    const plant = nearestAlive(ctx.gardenPlants, b.x, b.z);
    return plant ? { x: plant.x, z: plant.z, stop: 0 } : null;
  }
  if (b.item) {
    // a garage tool in hand: go for plant kids (trimmer, blower) or the turrets
    const kidsFirst = b.item === 'hedge_trimmer' || b.item === 'leaf_blower';
    const kids = ctx.plantSide.filter((e) => e.kind !== 'garden');
    const prey = (kidsFirst ? nearestAlive(kids, b.x, b.z) : null) ?? nearestAlive(ctx.gardenPlants, b.x, b.z) ?? nearestAlive(kids, b.x, b.z);
    ai.preyId = prey ? prey.id : null;
    const def = c.equipment[b.item];
    return prey ? { x: prey.x, z: prey.z, stop: Math.max(0.8, def.range * 0.6) } : null;
  }
  ai.preyId = null;
  if (ai.errand) {
    const g = errandGoal(game, b, ai);
    if (g) return g;
  }
  if (m && m.parts && m.parts.battery && m.parts.gas && m.parts.plug) {
    if (ai.seeksMower === undefined) ai.seeksMower = game.rng() < c.mowerBotChance;
    if (ai.seeksMower && m.state === 'idle') {
      if (dist2D(b.x, b.z, m.x, m.z) <= c.mowerUseRange - 0.3) b.input.use = true; // hold E: starts the engine
      return { x: m.x, z: m.z, stop: c.mowerBotStopDistance };
    }
    if (ai.seeksMower && m.state === 'starting' && m.driver === b.id) return { x: b.x, z: b.z, stop: 99 }; // stand by while it warms up
    if (ai.seeksMower && m.state !== 'idle' && m.driver !== b.id) ai.seeksMower = false; // lost the race
  }
  return null;
}

function zombieBrain(game, b, ai, ctx, dt) {
  const c = game.config;
  const diff = ctx.diff;
  const inp = b.input;
  inp.fire = false;
  inp.use = false;
  inp.keys.jump = false;
  if (game.headStart > 0) {
    setMoveKeys(b, 0, 0); // held at the gate while the plants plant
    return;
  }

  ai.think -= dt;
  let goal = ai.goal ?? null;
  if (ai.think <= 0) {
    ai.think += c.botThinkInterval;
    // who to shoot: the closest plant-side thing in sight (a tool in hand just swings at what it walks up to)
    const t = b.item ? null : nearestVisible(game, b, ctx.plantSide, c.zombieBotShootRange);
    const id = t ? t.id : null;
    if (id !== ai.targetId) {
      ai.targetId = id;
      ai.react = diff.reaction;
    }
    // where to go: an errand / tool prey / the mower, else the route's waypoints and then the fridge
    goal = zombieGoal(game, b, ai, ctx);
    if (goal) {
      const key = `${Math.round(goal.x)},${Math.round(goal.z)}`;
      ai.replan -= c.botThinkInterval;
      if (ai.goalKey !== key || ai.replan <= 0) {
        ai.goalKey = key;
        setPath(ai, planRoute(game.field, b.x, b.z, goal.x, goal.z, b.team));
        ai.replan = 1.6;
      }
      ai.mode = 'goal';
    } else {
      if (ai.mode === 'goal') {
        ai.mode = 'inside'; // errand over: on to the fridge
        ai.replan = 0;
        ai.goalKey = null;
      }
      if (ai.mode === 'route' && ai.pi >= ai.path.length) ai.mode = 'inside';
      if (ai.mode === 'inside') {
        ai.replan -= c.botThinkInterval;
        if (ai.replan <= 0) {
          const f = WORLD.fridge.stand;
          setPath(ai, planRoute(game.field, b.x, b.z, f.x, f.z, b.team));
          ai.replan = 1.6;
        }
      }
    }
    ai.goal = goal;
    const hadBlocker = ai.blocker;
    checkStuck(game, b, ai, ai.dir, game.moveSpeedFor(b));
    if (ai.blocker && ai.blocker !== hadBlocker) ai.react = Math.min(ai.react, 0.3);
  }

  const blocker = blockerPiece(game, ai);
  let target = null;
  let fire = null; // set for tool holders: swing when something is in reach
  if (blocker) target = pieceTarget(blocker); // a closed door / fort wall in the way beats everything else
  else if (b.item) {
    const prey = ai.preyId ? game.entities.get(ai.preyId) : null;
    if (prey && prey.state === 'alive') {
      const def = c.equipment[b.item];
      target = { x: prey.x, z: prey.z, y: b.y, height: 0 }; // aim level
      fire = b.item !== 'wheelbarrow' && dist2D(b.x, b.z, prey.x, prey.z) <= def.range + (prey.radius ?? 0.5);
    }
  } else {
    target = ai.targetId ? game.entities.get(ai.targetId) : null;
    if (!target || target.state !== 'alive' || target.team !== 'plant') {
      target = null;
      ai.targetId = null;
    }
  }
  const f = WORLD.fridge.stand;
  const atFridge = ai.mode === 'inside' && !goal && dist2D(b.x, b.z, f.x, f.z) < 1.0;
  const stop = goal ? goal.stop : ai.mode === 'route' ? 1.2 : 0.8;
  const standBy = Boolean(goal && goal.stop >= 99);
  moveAndShoot(game, b, ai, dt, { target, aimError: b.item ? 0 : diff.aimError, stop, canMove: !atFridge && !blocker && !standBy, noFire: fire === false });
  if (b.item && target && !blocker) {
    b.pitch = 0;
    inp.fire = fire === true;
  }
}

function gardenerBrain(game, b, ai, ctx, dt) {
  const c = game.config;
  const gc = c.gardener;
  const inp = b.input;
  inp.fire = false;
  inp.use = false;
  inp.keys.jump = false;
  b.sunshine = Math.min(gc.maxSunshine, (b.sunshine ?? 0) + gc.income * dt);

  ai.think -= dt;
  if (ai.think <= 0) {
    ai.think += c.botThinkInterval;
    const t = nearestVisible(game, b, ctx.zombieSide, gc.shootRange);
    const id = t ? t.id : null;
    if (id !== ai.targetId) {
      ai.targetId = id;
      ai.react = gc.reaction;
    }
    // Nearest empty slot (to its resting place, so plots fill from the house outward) it can afford.
    ai.slotIdx = -1;
    let best = Infinity;
    game.slots.forEach((s, i) => {
      if (s.plantId || s.disabled || s.pot || !(b.sunshine >= c.plantTypes[s.kind].cost)) return; // (pots are for the smart Gardener)
      const d = dist2D(gc.rest.x, gc.rest.z, s.x, s.z);
      if (d < best) {
        best = d;
        ai.slotIdx = i;
      }
    });
    // Nothing to replant: spend the spare sunshine now and then on levelling up the plant it is closest to.
    ai.upId = null;
    if (ai.slotIdx < 0 && ai.upTimer <= 0) {
      let bestUp = Infinity;
      for (const g of ctx.gardenPlants) {
        const cost = upgradeCost(c, g.plantKind, g.level ?? 1);
        if (g.state !== 'alive' || cost === null || b.sunshine < cost + gc.upgradeReserve) continue;
        const d = dist2D(b.x, b.z, g.x, g.z);
        if (d < bestUp) {
          bestUp = d;
          ai.upId = g.id;
        }
      }
    }
  }
  ai.upTimer -= dt;
  let target = ai.targetId ? game.entities.get(ai.targetId) : null;
  if (!target || target.state !== 'alive' || target.team !== 'zombie') {
    target = null;
    ai.targetId = null;
  }

  // Walk to the slot it wants to fill (or rest in the hall) and plant when close enough.
  let dest = gc.rest;
  const slot = ai.slotIdx >= 0 ? game.slots[ai.slotIdx] : null;
  const upPlant = ai.upId ? game.entities.get(ai.upId) : null;
  if (slot && !slot.plantId) {
    dest = slot;
    if (dist2D(b.x, b.z, slot.x, slot.z) <= gc.plantReach) {
      tryPlant(game, b, slot.kind, ai.slotIdx);
      ai.slotIdx = -1;
    }
  } else if (upPlant && upPlant.state === 'alive') {
    dest = upPlant;
    if (dist2D(b.x, b.z, upPlant.x, upPlant.z) <= gc.plantReach) {
      if (tryUpgrade(game, b, upPlant)) ai.upTimer = gc.upgradeInterval;
      ai.upId = null;
    }
  }
  const reach = slot || upPlant ? gc.plantReach * 0.6 : 1.5;
  ai.replan -= dt;
  if (!ai.dest || Math.hypot(ai.dest.x - dest.x, ai.dest.z - dest.z) > 0.5 || ai.replan <= 0) {
    ai.dest = { x: dest.x, z: dest.z };
    setPath(ai, planRoute(game.field, b.x, b.z, dest.x, dest.z, b.team));
    ai.replan = 2;
  }
  moveAndShoot(game, b, ai, dt, { target, aimError: gc.aimError, stop: reach });
}

export function stepBots(game, dt) {
  const c = game.config;
  if (c.features.gardener) stepGardenerSpawn(game, dt);
  if (!c.features.botAI) return;

  const ctx = { diff: game.difficultyConfig(), plantSide: [], zombieSide: [], gardenPlants: [] };
  const bots = [];
  for (const e of game.entities.values()) {
    if (e.kind === 'garden') {
      ctx.gardenPlants.push(e);
      ctx.plantSide.push(e);
    } else if (isFighter(e)) {
      (e.team === 'plant' ? ctx.plantSide : ctx.zombieSide).push(e);
      // bots, and zombie kids flagged `autopilot` (the balance harness's scripted kids use the bot brain)
      if ((e.kind === 'bot' || (e.autopilot && e.team === 'zombie')) && e.state === 'alive') bots.push(e);
    }
  }
  for (const b of bots) {
    const ai = ensureAI(game, b);
    if (ai.role === 'zombie') zombieBrain(game, b, ai, ctx, dt);
    else if (ai.role === 'gardener') gardenerBrain(game, b, ai, ctx, dt);
  }
}

