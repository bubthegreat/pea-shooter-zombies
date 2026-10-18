// Bot brains. Bots act exactly like players: each tick a brain writes yaw/pitch and bot.input
// (keys, fire, use) and the normal movement/weapon code does the rest. Steering is simple:
// walk straight at a goal, detouring through the garage door when the mower is involved.
import { WORLD } from './world.js';
import { tryPlant } from './garden.js';
import { dist2D, rightVec, forwardVec, yawTo } from './vec.js';

const isFighter = (e) => e.kind === 'player' || e.kind === 'bot';

/** Some zombie bots head for a garage tool instead of using their gun (botItemChance is per item). */
function rollItem(game) {
  const r = game.rng();
  let acc = 0;
  for (const [item, chance] of Object.entries(game.config.botItemChance ?? {})) {
    acc += chance;
    if (r < acc) return item;
  }
  return null;
}

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
  };
  if (bot.team === 'zombie') {
    bot.fireScale = game.difficultyConfig().fireScale;
    const seeksMower = game.rng() < c.mowerBotChance;
    bot.ai = { ...base, role: 'zombie', goalId: null, seeksMower, seeksItem: seeksMower ? null : rollItem(game), strafe: 0, strafeTimer: 0 };
  } else {
    bot.fireScale = c.gardener.fireScale;
    bot.ai = { ...base, role: bot.isGardener ? 'gardener' : 'inert', slotIdx: -1 };
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
  const bot = game.spawnBot('plant', spawn.x + (game.rng() * 2 - 1) * 3, spawn.z);
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

function nearest(list, x, z, maxDist) {
  let best = null;
  let bestDist = maxDist;
  for (const e of list) {
    if (e.state !== 'alive') continue;
    const d = dist2D(x, z, e.x, e.z);
    if (d <= bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

/** First waypoint toward (gx, gz): the garage is only reachable through its door, via the right-hand flank. */
function route(game, b, gx, gz) {
  const edge = WORLD.bounds.maxZ;
  const doorX = (WORLD.garage.doorMinX + WORLD.garage.doorMaxX) / 2;
  const inGarage = b.z > edge - 0.3;
  const goalInGarage = gz > edge;
  const flank = game.config.mowerFlank;
  if (goalInGarage && !inGarage && flank && b.z < flank.endZ) {
    if (b.x < flank.x - 2) return { x: flank.x, z: Math.max(b.z, flank.startZ) };
    return { x: flank.x, z: flank.endZ };
  }
  if (goalInGarage && !inGarage && Math.abs(b.x - doorX) > 3) return { x: doorX, z: edge - 3 };
  if (!goalInGarage && inGarage) return { x: doorX, z: edge - 3 };
  return { x: gx, z: gz };
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

/** Aim at a target with the bot's current (periodically re-rolled) error. */
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

function walkToward(b, wx, wz) {
  const dx = wx - b.x;
  const dz = wz - b.z;
  const d = Math.hypot(dx, dz) || 1;
  return { x: dx / d, z: dz / d };
}

/** A zombie bot holding a garage tool: walk up to prey and use it (the wheelbarrow just rolls toward the garden). */
function armedBrain(game, b, ai, ctx, dt) {
  const c = game.config;
  const def = c.equipment[b.item];
  const inp = b.input;
  inp.fire = false;
  inp.use = false;
  inp.keys.jump = false;
  ai.armed = true;

  ai.think -= dt;
  if (ai.think <= 0) {
    ai.think += c.botThinkInterval;
    // Trimmers and blowers go for plant kids first (they shred / shove them); everything else for the garden.
    const wantsKids = b.item === 'hedge_trimmer' || b.item === 'leaf_blower';
    const kids = ctx.plantSide.filter((e) => e.kind !== 'garden' && e.state === 'alive');
    ai.preyId = (wantsKids ? nearest(kids, b.x, b.z, 30) : null)?.id ?? nearest(ctx.gardenPlants, b.x, b.z, Infinity)?.id ?? null;
  }
  let prey = ai.preyId ? game.entities.get(ai.preyId) : null;
  if (!prey || prey.state !== 'alive') {
    prey = null;
    ai.preyId = null;
  }
  let dir = { x: 0, z: 0 };
  if (prey) {
    const reach = b.item === 'wheelbarrow' ? 4 : b.item === 'leaf_blower' ? def.range * 0.6 : def.range * 0.6;
    const d = dist2D(b.x, b.z, prey.x, prey.z);
    if (d > reach) dir = walkToward(b, prey.x, prey.z);
    aimAt(game, b, ai, prey, 0, dt);
    b.pitch = 0;
    inp.fire = b.item !== 'wheelbarrow' && d <= def.range + (prey.radius ?? 0);
  }
  setMoveKeys(b, dir.x, dir.z);
}

function zombieBrain(game, b, ai, ctx, dt) {
  const c = game.config;
  const diff = ctx.diff;
  const inp = b.input;
  if (b.item) {
    armedBrain(game, b, ai, ctx, dt);
    return;
  }
  if (ai.armed) {
    ai.armed = false; // lost the tool: back to plain shooting
    ai.seeksItem = null;
  }
  inp.fire = false;
  inp.use = false;
  inp.keys.jump = false;

  ai.think -= dt;
  if (ai.think <= 0) {
    ai.think += c.botThinkInterval;
    const t = nearest(ctx.plantSide, b.x, b.z, c.zombieBotShootRange);
    const id = t ? t.id : null;
    if (id !== ai.targetId) {
      ai.targetId = id;
      ai.react = diff.reaction;
    }
    ai.goalId = nearest(ctx.gardenPlants, b.x, b.z, Infinity)?.id ?? null;
  }
  let target = ai.targetId ? game.entities.get(ai.targetId) : null;
  if (!target || target.state !== 'alive' || target.team !== 'plant') {
    target = null;
    ai.targetId = null;
  }
  const goalPlant = ai.goalId ? game.entities.get(ai.goalId) : null;

  // Decide where to go.
  const m = game.mower;
  let goal = null;
  let stop = c.zombieBotStopDistance;
  let hold = false;
  if (ai.seeksMower && (!m || (m.state !== 'idle' && m.driver !== b.id))) ai.seeksMower = false; // lost the race
  if (ai.seeksMower) {
    if (m.state === 'idle') {
      goal = m;
      stop = c.mowerBotStopDistance;
      if (dist2D(b.x, b.z, m.x, m.z) <= c.mowerUseRange - 0.3) inp.use = true;
    } else if (m.state === 'starting') {
      hold = true; // stand by the mower while it warms up
    } else {
      goal = goalPlant && goalPlant.state === 'alive' ? goalPlant : null;
      stop = 0; // drive right over it
    }
  } else if (ai.seeksItem) {
    const rack = game.racks?.get(ai.seeksItem);
    if (!rack || !rack.available) {
      ai.seeksItem = null; // somebody got there first
    } else {
      goal = rack;
      stop = c.mowerBotStopDistance;
      if (dist2D(b.x, b.z, rack.x, rack.z) <= c.rackUseRange - 0.4) b.usePressed = true;
    }
  }
  if (!goal && !ai.seeksMower && goalPlant && goalPlant.state === 'alive' && !ai.seeksItem) goal = goalPlant;

  // Walk.
  let dir = { x: 0, z: 0 };
  let moving = false;
  if (goal && !hold && dist2D(b.x, b.z, goal.x, goal.z) > stop) {
    const wp = route(game, b, goal.x, goal.z);
    dir = walkToward(b, wp.x, wp.z);
    moving = true;
  } else if (!hold && target) {
    // parked and shooting: shuffle side to side now and then
    ai.strafeTimer -= dt;
    if (ai.strafeTimer <= 0) {
      ai.strafeTimer = 1 + game.rng() * 2;
      ai.strafe = Math.floor(game.rng() * 3) - 1;
    }
    const r = rightVec(b.yaw);
    dir = { x: r.x * ai.strafe, z: r.z * ai.strafe };
  }

  // Look and shoot.
  const driving = m && m.state === 'driving' && m.driver === b.id;
  if (target && !driving) {
    aimAt(game, b, ai, target, diff.aimError, dt);
    ai.react -= dt;
    inp.fire = ai.react <= 0;
  } else if (moving) {
    b.yaw = yawTo(dir.x, dir.z);
    b.pitch = 0;
  }
  setMoveKeys(b, dir.x, dir.z);
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
    const t = nearest(ctx.zombieSide, b.x, b.z, gc.shootRange);
    const id = t ? t.id : null;
    if (id !== ai.targetId) {
      ai.targetId = id;
      ai.react = gc.reaction;
    }
    // Nearest empty slot it can afford.
    ai.slotIdx = -1;
    let best = Infinity;
    game.slots.forEach((s, i) => {
      if (s.plantId || !(b.sunshine >= c.plantTypes[s.kind].cost)) return;
      const d = dist2D(b.x, b.z, s.x, s.z);
      if (d < best) {
        best = d;
        ai.slotIdx = i;
      }
    });
  }
  let target = ai.targetId ? game.entities.get(ai.targetId) : null;
  if (!target || target.state !== 'alive' || target.team !== 'zombie') {
    target = null;
    ai.targetId = null;
  }

  // Walk to the slot it wants to fill (or rest behind the garden) and plant when close enough.
  let dest = { x: 0, z: gc.restZ };
  const slot = ai.slotIdx >= 0 ? game.slots[ai.slotIdx] : null;
  if (slot && !slot.plantId) {
    dest = slot;
    if (dist2D(b.x, b.z, slot.x, slot.z) <= gc.plantReach) {
      tryPlant(game, b, slot.kind);
      ai.slotIdx = -1;
    }
  }
  let dir = { x: 0, z: 0 };
  let moving = false;
  const reach = slot ? gc.plantReach * 0.6 : 1.5;
  if (dist2D(b.x, b.z, dest.x, dest.z) > reach) {
    dir = walkToward(b, dest.x, dest.z);
    moving = true;
  }
  if (target) {
    aimAt(game, b, ai, target, gc.aimError, dt);
    ai.react -= dt;
    inp.fire = ai.react <= 0;
  } else if (moving) {
    b.yaw = yawTo(dir.x, dir.z);
    b.pitch = 0;
  }
  setMoveKeys(b, dir.x, dir.z);
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
      if (e.kind === 'bot' && e.state === 'alive') bots.push(e);
    }
  }
  for (const b of bots) {
    const ai = ensureAI(game, b);
    if (ai.role === 'zombie') zombieBrain(game, b, ai, ctx, dt);
    else if (ai.role === 'gardener') gardenerBrain(game, b, ai, ctx, dt);
  }
}
