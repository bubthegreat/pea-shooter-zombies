// Bot brains. Bots act exactly like players: each tick a brain writes yaw/pitch and bot.input
// (keys, fire, use) and the normal movement/weapon code does the rest. Steering is simple:
// walk straight at a goal, detouring through the garage door when the mower is involved.
import { WORLD } from './world.js';
import { dist2D, rightVec, forwardVec, yawTo } from './vec.js';

const isFighter = (e) => e.kind === 'player' || e.kind === 'bot';

function pickPost(game) {
  const c = game.config;
  return { x: (game.rng() * 2 - 1) * c.guardLineHalfWidth, z: c.guardLineZ };
}

/** Create the brain for a bot that has none (new spawns and freshly converted zombies). */
export function ensureAI(game, bot) {
  if (bot.ai) return bot.ai;
  const c = game.config;
  const base = {
    defender: false,
    think: game.rng() * c.botThinkInterval,
    targetId: null,
    react: 0,
    errYaw: 0,
    errPitch: 0,
    errTimer: 0,
  };
  if (bot.team === 'zombie') {
    bot.fireScale = game.difficultyConfig().fireScale;
    bot.ai = { ...base, role: 'zombie', goalId: null, seeksMower: game.rng() < c.mowerBotChance, strafe: 0, strafeTimer: 0 };
  } else {
    bot.fireScale = c.plantBotFireScale;
    bot.ai = { ...base, role: 'plant', post: pickPost(game) };
  }
  return bot.ai;
}

export function spawnDefender(game) {
  const spawn = WORLD.plantSpawn;
  const bot = game.spawnBot('plant', spawn.x + (game.rng() * 2 - 1) * 3, spawn.z);
  ensureAI(game, bot).defender = true;
  return bot;
}

function livingDefenders(game) {
  let n = 0;
  for (const e of game.entities.values()) if (e.kind === 'bot' && e.team === 'plant' && e.ai?.defender) n++;
  return n;
}

/** Keep the plant team's computer defenders topped up (when no human plays plants, and a few in versus). */
function stepDefenders(game, dt) {
  const c = game.config;
  const plantHumans = game.humans().filter((h) => h.team === 'plant').length;
  const desired = plantHumans === 0 ? c.defenderCount : game.mode === 'versus' ? c.versusDefenderCount : 0;
  if (!game.defendersSpawned) {
    game.defendersSpawned = true;
    for (let i = 0; i < desired; i++) spawnDefender(game);
  }
  if (game.defenderTimers.length === 0) return;
  let due = 0;
  game.defenderTimers = game.defenderTimers
    .map((t) => t - dt)
    .filter((t) => {
      if (t > 0) return true;
      due++;
      return false;
    });
  for (let i = 0; i < due && livingDefenders(game) < desired; i++) spawnDefender(game);
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

/** First waypoint toward (gx, gz): the garage is only reachable through its door. */
function route(b, gx, gz) {
  const edge = WORLD.bounds.maxZ;
  const doorX = (WORLD.garage.doorMinX + WORLD.garage.doorMaxX) / 2;
  const inGarage = b.z > edge - 0.3;
  const goalInGarage = gz > edge;
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

function zombieBrain(game, b, ai, ctx, dt) {
  const c = game.config;
  const diff = ctx.diff;
  const inp = b.input;
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
  } else if (goalPlant && goalPlant.state === 'alive') {
    goal = goalPlant;
  }

  // Walk.
  let dir = { x: 0, z: 0 };
  let moving = false;
  if (goal && !hold && dist2D(b.x, b.z, goal.x, goal.z) > stop) {
    const wp = route(b, goal.x, goal.z);
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

function plantBrain(game, b, ai, ctx, dt) {
  const c = game.config;
  const inp = b.input;
  inp.fire = false;
  inp.use = false;
  inp.keys.jump = false;

  ai.think -= dt;
  if (ai.think <= 0) {
    ai.think += c.botThinkInterval;
    const t = nearest(ctx.zombieSide, b.x, b.z, c.plantBotShootRange);
    const id = t ? t.id : null;
    if (id !== ai.targetId) {
      ai.targetId = id;
      ai.react = c.plantBotReaction;
    }
  }
  let target = ai.targetId ? game.entities.get(ai.targetId) : null;
  if (!target || target.state !== 'alive' || target.team !== 'zombie') {
    target = null;
    ai.targetId = null;
  }

  let dir = { x: 0, z: 0 };
  let moving = false;
  if (dist2D(b.x, b.z, ai.post.x, ai.post.z) > c.mowerBotStopDistance) {
    dir = walkToward(b, ai.post.x, ai.post.z);
    moving = true;
  }
  if (target) {
    aimAt(game, b, ai, target, c.plantBotAimError, dt);
    ai.react -= dt;
    inp.fire = ai.react <= 0;
  } else if (moving) {
    b.yaw = yawTo(dir.x, dir.z);
    b.pitch = 0;
  } else {
    b.yaw = 0; // face the gate
    b.pitch = 0;
  }
  setMoveKeys(b, dir.x, dir.z);
}

export function stepBots(game, dt) {
  const c = game.config;
  if (c.features.defenders) stepDefenders(game, dt);
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
    else plantBrain(game, b, ai, ctx, dt);
  }
}
