// The garden: slots, planting, auto-firing turrets, and falling sunshine.
import { WORLD, gardenSlots, inRect } from './world.js';
import { terrainHeight } from './terrain.js';
import { spawnProjectile } from './combat.js';
import { dist2D, forwardVec } from './vec.js';

/** Fresh, empty slot list: [{x, z, kind, plantId}]. */
export function emptySlots() {
  return gardenSlots().map((s) => ({ ...s, plantId: null }));
}

/** Stat multipliers for a plant level (1 = base): +damage, +fire rate, +max HP per level above 1. */
export function levelScale(c, level = 1) {
  const L = c.plantLevels;
  const k = Math.max(0, Math.min(L.max, level) - 1);
  return { damage: 1 + k * L.damage, rate: 1 + k * L.rate, hp: 1 + k * L.hp };
}

/** Max HP of a plant kind at a level. */
export function plantMaxHp(c, kind, level = 1) {
  const base = c.plantTypes[kind]?.hp ?? c.gardenPlantHp;
  return Math.round(base * levelScale(c, level).hp);
}

/** Sunshine to raise a plant of `kind` from `level` to level + 1, or null at the top level. */
export function upgradeCost(c, kind, level = 1) {
  const type = c.plantTypes[kind];
  const mult = c.plantLevels.cost[level - 1];
  if (!type || level >= c.plantLevels.max || mult === undefined) return null;
  return Math.round(type.cost * mult);
}

/**
 * Put a plant in slot `idx` (no cost, no checks besides the slot being free). `kind` defaults to the slot's own kind
 * (used by the pre-planted garden and the Gardener); any kind fits any slot.
 */
export function plantAt(game, idx, kind) {
  const c = game.config;
  const slot = game.slots[idx];
  if (!slot || slot.plantId) return null;
  kind = kind ?? slot.kind;
  const type = c.plantTypes[kind];
  if (!type) return null;
  const hp = plantMaxHp(c, kind, 1);
  const e = {
    id: game.newId('g'),
    kind: 'garden',
    team: 'plant',
    plantKind: kind,
    label: type.name ?? kind, // kill-feed name (not sent in snapshots)
    level: 1,
    x: slot.x,
    y: terrainHeight(slot.x, slot.z),
    z: slot.z,
    yaw: 0,
    pitch: 0,
    hp,
    maxHp: hp,
    state: 'alive',
    radius: type.radius ?? c.gardenPlantRadius,
    height: type.height ?? c.gardenPlantHeight,
    slot: idx,
    cooldown: type.rate ? (game.rng() / type.rate) * 2 : 0, // desynchronize turrets
  };
  if (type.blocks) e.blocks = true;
  slot.plantId = e.id;
  game.entities.set(e.id, e);
  return e;
}

/** Pre-plant every other column (0 and 2) of every row of every plot. Skips occupied slots. */
export function initGarden(game) {
  game.slots.forEach((s, idx) => {
    if (s.col % 2 === 0) plantAt(game, idx);
  });
}

/**
 * A plant player spends sunshine to plant `kind` in the nearest empty slot within plantRange (any kind fits any slot).
 * Plant kids may only plant what their kill-meter tier has unlocked; the Gardener plants tier-0 kinds. `only` limits
 * the choice to one slot index. Returns the new plant, or null (and changes nothing).
 */
export function tryPlant(game, player, kind, only = -1) {
  const c = game.config;
  const type = c.plantTypes[kind];
  if (!type || !player || player.team !== 'plant') return null;
  if (player.kind !== 'player' && !player.isGardener) return null;
  if (player.state !== 'alive' || game.phase !== 'playing') return null;
  if ((type.tier ?? 0) > (player.kind === 'player' ? player.tier ?? 0 : 0)) return null;
  if (!(player.sunshine >= type.cost)) return null;
  let best = -1;
  let bestDist = Infinity;
  game.slots.forEach((s, i) => {
    if (s.plantId || (only >= 0 && i !== only)) return;
    const d = dist2D(player.x, player.z, s.x, s.z);
    if (d <= c.plantRange && d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  if (best < 0) return null;
  const plant = plantAt(game, best, kind);
  player.sunshine -= type.cost;
  game.emit('plant', { id: plant.id, plantKind: kind, x: plant.x, z: plant.z, by: player.id });
  return plant;
}

/**
 * The garden plant a kid would upgrade: within `reach` metres, preferring the one they look at (inside the look cone,
 * smallest angle), otherwise the nearest. Client prompts use the same rule (client/plants.js).
 */
export function pickUpgradeTarget(game, player) {
  const L = game.config.plantLevels;
  const fx = -Math.sin(player.yaw);
  const fz = -Math.cos(player.yaw);
  let looked = null;
  let lookAngle = L.lookCone;
  let nearest = null;
  let nearestDist = L.reach;
  for (const g of game.entities.values()) {
    if (g.kind !== 'garden' || g.state !== 'alive') continue;
    const d = dist2D(player.x, player.z, g.x, g.z);
    if (d > L.reach) continue;
    if (d < nearestDist) {
      nearest = g;
      nearestDist = d;
    }
    if (d < 0.05) continue;
    const angle = Math.acos(Math.max(-1, Math.min(1, (fx * (g.x - player.x) + fz * (g.z - player.z)) / d)));
    if (angle <= lookAngle) {
      looked = g;
      lookAngle = angle;
    }
  }
  return looked ?? nearest;
}

/**
 * Spend sunshine to raise a garden plant one level (max 3): the one the kid looks at or is nearest to, or `target`.
 * Heals it to its new full HP. Returns the plant, or null (and changes nothing).
 */
export function tryUpgrade(game, player, target = null) {
  const c = game.config;
  if (!player || player.team !== 'plant') return null;
  if (player.kind !== 'player' && !player.isGardener) return null;
  if (player.state !== 'alive' || game.phase !== 'playing') return null;
  const plant = target ?? pickUpgradeTarget(game, player);
  if (!plant || plant.kind !== 'garden' || plant.state !== 'alive') return null;
  if (dist2D(player.x, player.z, plant.x, plant.z) > c.plantLevels.reach) return null;
  const cost = upgradeCost(c, plant.plantKind, plant.level ?? 1);
  if (cost === null || !(player.sunshine >= cost)) return null;
  player.sunshine -= cost;
  plant.level = (plant.level ?? 1) + 1;
  plant.maxHp = plantMaxHp(c, plant.plantKind, plant.level);
  plant.hp = plant.maxHp;
  game.emit('plantUp', { id: plant.id, plantKind: plant.plantKind, level: plant.level, x: plant.x, z: plant.z, by: player.id });
  return plant;
}

/** Pitch (rad) that lobs a shot of `speed` under `gravity` onto a point `d` metres away and `dy` higher (low arc). */
function lobPitch(speed, gravity, d, dy) {
  const v2 = speed * speed;
  const disc = v2 * v2 - gravity * (gravity * d * d + 2 * dy * v2);
  if (disc < 0 || d < 1e-6) return Math.PI / 4; // out of reach: throw as far as it goes
  return Math.atan((v2 - Math.sqrt(disc)) / (gravity * d));
}

/** Turrets: each garden plant shoots the nearest living zombie in range (wall-nuts just stand there). */
export function stepGarden(game, dt) {
  const c = game.config;
  const zombies = [];
  const plants = [];
  for (const e of game.entities.values()) {
    if (e.kind === 'garden') plants.push(e);
    else if ((e.kind === 'player' || e.kind === 'bot') && e.team === 'zombie' && e.state === 'alive' && !game.isHeld(e)) zombies.push(e);
  }
  for (const g of plants) {
    const type = c.plantTypes[g.plantKind];
    if (!type || type.noAttack) continue;
    const scale = levelScale(c, g.level ?? 1);
    const rate = type.rate * scale.rate;
    g.cooldown -= dt;
    // the nearest zombie it can see (walls, doors, hills and cover block the view)
    const muzzleY = g.y + (type.muzzle ?? c.turretMuzzleHeight);
    const near = [];
    for (const z of zombies) {
      const d = dist2D(g.x, g.z, z.x, z.z);
      if (d <= type.range) near.push([d, z]);
    }
    near.sort((p, q) => p[0] - q[0]);
    let target = null;
    for (let i = 0; i < Math.min(3, near.length); i++) {
      const z = near[i][1];
      if (game.field.clearLine(g.x, muzzleY, g.z, z.x, z.y + z.height * c.turretAimHeight, z.z, 'plant')) {
        target = z;
        break;
      }
    }
    if (!target) {
      if (g.cooldown < 0) g.cooldown = 0;
      continue;
    }
    const ox = g.x;
    const oy = g.y + (type.muzzle ?? c.turretMuzzleHeight);
    const oz = g.z;
    // Turrets are a bit slow on the draw: they aim where the target was a moment ago.
    let dx = target.x - (target.vx ?? 0) * c.turretLag - ox;
    let dy = target.y + target.height * c.turretAimHeight - oy;
    let dz = target.z - (target.vz ?? 0) * c.turretLag - oz;
    const horiz = Math.hypot(dx, dz);
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    g.yaw = Math.atan2(-dx, -dz);
    g.pitch = type.gravity > 0 ? lobPitch(type.speed, type.gravity, horiz, (len * dy)) : Math.asin(dy);
    if (g.cooldown > 0) continue;
    const yaw = g.yaw + (game.rng() * 2 - 1) * type.aimError;
    const pitch = g.pitch + (game.rng() * 2 - 1) * type.aimError;
    for (let i = 0; i < (type.pellets ?? 1); i++) {
      const spread = type.spread ?? 0;
      const dir = spread > 0
        ? forwardVec(yaw + (game.rng() * 2 - 1) * spread, pitch + (game.rng() * 2 - 1) * spread)
        : forwardVec(yaw, pitch);
      spawnProjectile(game, {
        team: 'plant',
        owner: g.id,
        projKind: type.projKind,
        damage: type.damage * scale.damage,
        speed: type.speed,
        x: ox,
        y: oy,
        z: oz,
        dir,
        gravity: type.gravity,
        splash: type.splash,
        slow: type.slow,
        life: type.life,
      });
    }
    g.cooldown += 1 / rate;
  }
}

/** Create a sun pickup. It falls from the sky unless `landed`. */
export function spawnSun(game, x, z, { landed = false } = {}) {
  const c = game.config;
  const ground = terrainHeight(x, z);
  const e = {
    id: game.newId('s'),
    kind: 'sun',
    team: 'plant',
    x,
    y: ground + (landed ? c.sunRestHeight : c.sunDropHeight),
    ground,
    z,
    yaw: 0,
    hp: 1,
    maxHp: 1,
    state: 'alive',
    life: c.sunLifetime,
  };
  game.entities.set(e.id, e);
  return e;
}

const NO_SUN = [WORLD.house, WORLD.garage, WORLD.pen, WORLD.cellar.ramp, WORLD.cellar.slab, WORLD.shed, WORLD.deck];

/** A random spot in the yard where a sun can land (not inside buildings, not on top of cover). */
function sunDropPoint(game) {
  const c = game.config;
  const [x0, x1] = c.sunDropX;
  const [z0, z1] = c.sunDropZ;
  let x = 0;
  let z = 0;
  for (let i = 0; i < 16; i++) {
    x = x0 + game.rng() * (x1 - x0);
    z = z0 + game.rng() * (z1 - z0);
    if (NO_SUN.some((r) => inRect(r, x, z, 0.8))) continue;
    if (game.field.groundAt(x, z, 10) > terrainHeight(x, z) + 0.3) continue;
    break;
  }
  return { x, z };
}

/** Drop suns on a timer, let them fall, expire, and be collected by plant players. */
export function stepSun(game, dt) {
  const c = game.config;
  const collectors = [];
  const suns = [];
  for (const e of game.entities.values()) {
    if (e.kind === 'sun') suns.push(e);
    else if (e.kind === 'player' && e.team === 'plant' && e.state === 'alive') collectors.push(e);
  }
  if (c.features.sunDrops && collectors.length > 0) {
    game.sunTimer -= dt;
    if (game.sunTimer <= 0) {
      game.sunTimer += c.sunDropInterval;
      if (suns.length < c.sunMaxActive) {
        const p = sunDropPoint(game);
        suns.push(spawnSun(game, p.x, p.z));
      }
    }
  } else if (game.sunTimer < c.sunDropInterval) {
    game.sunTimer = c.sunDropInterval;
  }
  for (const sun of suns) {
    const rest = (sun.ground ?? 0) + c.sunRestHeight;
    if (sun.y > rest) sun.y = Math.max(rest, sun.y - c.sunFallSpeed * dt);
    sun.life -= dt;
    if (sun.life <= 0) {
      game.removeEntity(sun);
      continue;
    }
    if (sun.y > rest) continue; // still falling
    for (const p of collectors) {
      if (dist2D(p.x, p.z, sun.x, sun.z) <= c.sunPickupRadius) {
        p.sunshine += c.sunValue;
        game.removeEntity(sun);
        break;
      }
    }
  }
}
