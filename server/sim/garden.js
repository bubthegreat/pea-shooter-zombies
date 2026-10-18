// The garden: slots, planting, auto-firing turrets, and falling sunshine.
import { gardenSlots } from './world.js';
import { spawnProjectile } from './combat.js';
import { dist2D, forwardVec } from './vec.js';

/** Fresh, empty slot list: [{x, z, kind, plantId}]. */
export function emptySlots() {
  return gardenSlots().map((s) => ({ ...s, plantId: null }));
}

/** Put a plant in slot `idx` (no cost, no checks besides the slot being free). */
export function plantAt(game, idx) {
  const c = game.config;
  const slot = game.slots[idx];
  if (!slot || slot.plantId) return null;
  const type = c.plantTypes[slot.kind];
  const e = {
    id: game.newId('g'),
    kind: 'garden',
    team: 'plant',
    plantKind: slot.kind,
    x: slot.x,
    y: 0,
    z: slot.z,
    yaw: 0,
    pitch: 0,
    hp: c.gardenPlantHp,
    maxHp: c.gardenPlantHp,
    state: 'alive',
    radius: c.gardenPlantRadius,
    height: c.gardenPlantHeight,
    slot: idx,
    cooldown: (game.rng() / type.rate) * 2, // desynchronize turrets
  };
  slot.plantId = e.id;
  game.entities.set(e.id, e);
  return e;
}

/** Pre-plant every other column (0, 2, 4, 6, 8) of every row. Skips occupied slots. */
export function initGarden(game) {
  const cols = game.slots.length / 4;
  game.slots.forEach((_, idx) => {
    if (idx % cols % 2 === 0) plantAt(game, idx);
  });
}

/**
 * A plant player spends sunshine to plant `kind` ("peashooter" | "cactus") in the nearest empty slot
 * of that kind within plantRange. Returns the new plant, or null (and changes nothing).
 */
export function tryPlant(game, player, kind) {
  const c = game.config;
  const type = c.plantTypes[kind];
  if (!type || !player || player.kind !== 'player' || player.team !== 'plant') return null;
  if (player.state !== 'alive' || game.phase !== 'playing') return null;
  if (!(player.sunshine >= type.cost)) return null;
  let best = -1;
  let bestDist = Infinity;
  game.slots.forEach((s, i) => {
    if (s.plantId || s.kind !== kind) return;
    const d = dist2D(player.x, player.z, s.x, s.z);
    if (d <= c.plantRange && d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  if (best < 0) return null;
  const plant = plantAt(game, best);
  player.sunshine -= type.cost;
  game.emit('plant', { id: plant.id, plantKind: kind, x: plant.x, z: plant.z, by: player.id });
  return plant;
}

/** Turrets: each garden plant shoots the nearest living zombie in range. */
export function stepGarden(game, dt) {
  const c = game.config;
  const zombies = [];
  const plants = [];
  for (const e of game.entities.values()) {
    if (e.kind === 'garden') plants.push(e);
    else if ((e.kind === 'player' || e.kind === 'bot') && e.team === 'zombie' && e.state === 'alive') zombies.push(e);
  }
  for (const g of plants) {
    const type = c.plantTypes[g.plantKind];
    g.cooldown -= dt;
    let target = null;
    let best = type.range;
    for (const z of zombies) {
      const d = dist2D(g.x, g.z, z.x, z.z);
      if (d <= best) {
        best = d;
        target = z;
      }
    }
    if (!target) {
      if (g.cooldown < 0) g.cooldown = 0;
      continue;
    }
    const ox = g.x;
    const oy = g.y + c.turretMuzzleHeight;
    const oz = g.z;
    let dx = target.x - ox;
    let dy = target.y + target.height * c.turretAimHeight - oy;
    let dz = target.z - oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    g.yaw = Math.atan2(-dx, -dz);
    g.pitch = Math.asin(dy);
    if (g.cooldown > 0) continue;
    const dir = forwardVec(
      g.yaw + (game.rng() * 2 - 1) * type.aimError,
      g.pitch + (game.rng() * 2 - 1) * type.aimError,
    );
    spawnProjectile(game, {
      team: 'plant',
      owner: g.id,
      projKind: type.projKind,
      damage: type.damage,
      speed: type.speed,
      x: ox,
      y: oy,
      z: oz,
      dir,
    });
    g.cooldown += 1 / type.rate;
  }
}

/** Create a sun pickup. It falls from the sky unless `landed`. */
export function spawnSun(game, x, z, { landed = false } = {}) {
  const c = game.config;
  const e = {
    id: game.newId('s'),
    kind: 'sun',
    team: 'plant',
    x,
    y: landed ? c.sunRestHeight : c.sunDropHeight,
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
        const [x0, x1] = c.sunDropX;
        const [z0, z1] = c.sunDropZ;
        suns.push(spawnSun(game, x0 + game.rng() * (x1 - x0), z0 + game.rng() * (z1 - z0)));
      }
    }
  } else if (game.sunTimer < c.sunDropInterval) {
    game.sunTimer = c.sunDropInterval;
  }
  for (const sun of suns) {
    if (sun.y > c.sunRestHeight) sun.y = Math.max(c.sunRestHeight, sun.y - c.sunFallSpeed * dt);
    sun.life -= dt;
    if (sun.life <= 0) {
      game.removeEntity(sun);
      continue;
    }
    if (sun.y > c.sunRestHeight) continue; // still falling
    for (const p of collectors) {
      if (dist2D(p.x, p.z, sun.x, sun.z) <= c.sunPickupRadius) {
        p.sunshine += c.sunValue;
        game.removeEntity(sun);
        break;
      }
    }
  }
}
