// Projectiles, damage, conversion (zombies -> plants) and wilting (plants).
import { distPointSegment, forwardVec } from './vec.js';
import { WORLD, insideSolid } from './world.js';
import { getWeapon } from './weapons.js';
import { recordHurt, recordKill } from './upgrades.js';
import { spawnSun } from './garden.js';
import { destroyMower } from './mower.js';
import { barrowBlocks, barrowTakesHit, dropOnConvert } from './equipment.js';

/**
 * Create a projectile entity. `dir` is a unit vector. Optional: gravity (m/s^2), splash (blast radius m),
 * slow ({factor, secs}), life (s).
 */
export function spawnProjectile(game, { team, owner, projKind, damage, speed, x, y, z, dir, gravity, splash, slow, life }) {
  const c = game.config;
  const p = {
    id: game.newId('j'),
    kind: 'projectile',
    team,
    projKind,
    x,
    y,
    z,
    yaw: Math.atan2(-dir.x, -dir.z),
    pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))),
    hp: 1,
    maxHp: 1,
    state: 'alive',
    vx: dir.x * speed,
    vy: dir.y * speed,
    vz: dir.z * speed,
    speed,
    life: life ?? c.projectileLife,
    damage,
    owner: owner ?? null,
    radius: c.projectileRadius[projKind] ?? c.projectileRadius.pea,
  };
  if (gravity > 0) p.gravity = gravity;
  if (splash > 0) p.splash = splash;
  if (slow) p.slow = slow;
  game.entities.set(p.id, p);
  return p;
}

/** Fire the shooter's current weapon along its yaw/pitch from eye height. Returns pellets fired. */
export function fireWeapon(game, shooter) {
  const w = getWeapon(shooter.weapon);
  if (!w) return 0;
  const c = game.config;
  const damage = w.damage * (shooter.damageScale ?? 1);
  for (let i = 0; i < w.pellets; i++) {
    let yaw = shooter.yaw;
    let pitch = shooter.pitch + (w.lob ?? 0);
    if (w.spread > 0) {
      yaw += (game.rng() * 2 - 1) * w.spread;
      pitch += (game.rng() * 2 - 1) * w.spread;
    }
    const dir = forwardVec(yaw, pitch);
    spawnProjectile(game, {
      team: shooter.team,
      owner: shooter.id,
      projKind: w.projKind,
      damage,
      speed: w.speed,
      x: shooter.x + dir.x * c.muzzleForward,
      y: shooter.y + c.eyeHeight + dir.y * c.muzzleForward,
      z: shooter.z + dir.z * c.muzzleForward,
      dir,
      gravity: w.gravity,
      splash: w.splash,
      slow: w.slow,
      life: w.life,
    });
  }
  return w.pellets;
}

/** Living things shots can hit. A mower with a driver in it is the target instead of the driver. */
function isTargetable(game, e) {
  if (e.kind === 'mower') return e.state === 'driving' || e.state === 'starting';
  return e.state === 'alive' && (e.kind === 'player' || e.kind === 'bot' || e.kind === 'garden') && !game.isDriving(e);
}

function projectileHits(p, t) {
  const r = t.radius;
  const y0 = t.y + r;
  const y1 = Math.max(y0, t.y + t.height - r);
  return distPointSegment(p.x, p.y, p.z, t.x, y0, t.z, t.x, y1, t.z) < r + p.radius;
}

const isFighter = (e) => e.kind === 'player' || e.kind === 'bot';

/** Move projectiles (substepped so fast shots can't tunnel), resolve hits. */
export function stepProjectiles(game, dt) {
  const c = game.config;
  const ext = WORLD.extent;
  const projectiles = [];
  const targets = [];
  const barrows = [];
  for (const e of game.entities.values()) {
    if (e.kind === 'projectile') projectiles.push(e);
    else if (isTargetable(game, e)) {
      targets.push(e);
      if (e.item === 'wheelbarrow') barrows.push(e);
    }
  }
  for (const p of projectiles) {
    const steps = Math.max(1, Math.ceil((p.speed * dt) / c.projectileStep));
    const sdt = dt / steps;
    let dead = false;
    for (let s = 0; s < steps && !dead; s++) {
      if (p.gravity) {
        p.vy -= p.gravity * sdt;
        p.pitch = Math.atan2(p.vy, Math.hypot(p.vx, p.vz));
      }
      p.x += p.vx * sdt;
      p.y += p.vy * sdt;
      p.z += p.vz * sdt;
      if (p.y <= 0 || p.x < ext.minX || p.x > ext.maxX || p.z < ext.minZ || p.z > ext.maxZ || insideSolid(p.x, p.y, p.z)) {
        if (p.splash && p.y <= 0) {
          p.y = 0.05;
          explode(game, p);
        }
        dead = true;
        break;
      }
      const barrow = barrows.find((b) => b.item === 'wheelbarrow' && barrowBlocks(game, b, p));
      if (barrow) {
        barrowTakesHit(game, barrow, p);
        if (p.splash) explode(game, p);
        dead = true;
        break;
      }
      for (const t of targets) {
        if (t.team === p.team || !isTargetable(game, t) || !projectileHits(p, t)) continue;
        const owner = game.entities.get(p.owner) ?? null;
        if (p.splash) {
          explode(game, p);
        } else {
          // Headshots: only shots fired by players and bots (not garden turrets) at the head zone of a player or bot.
          const head = isFighter(t) && owner !== null && isFighter(owner) && p.y >= t.y + t.height - c.headHeight;
          applyDamage(game, t, p.damage * (head ? c.headshotMultiplier : 1), owner, { head });
          if (p.slow && isFighter(t) && t.state === 'alive') applySlow(t, p.slow);
        }
        dead = true;
        break;
      }
    }
    p.life -= dt;
    if (dead || p.life <= 0) {
      p.state = 'dead';
      game.entities.delete(p.id);
    }
  }
}

/** Slow a fighter (snow peas): the strongest, longest slow wins. */
export function applySlow(target, { factor, secs }) {
  target.slowTimer = Math.max(target.slowTimer ?? 0, secs);
  target.slowFactor = Math.min(target.slowFactor ?? 1, factor);
}

/** Blast at the projectile's position: everything hostile in reach takes damage that falls off to 40% at the rim. */
function explode(game, p) {
  const owner = game.entities.get(p.owner) ?? null;
  game.emit('explode', { x: p.x, y: p.y, z: p.z, radius: p.splash, projKind: p.projKind, team: p.team });
  for (const t of [...game.entities.values()]) {
    if (!isTargetable(game, t) || t.team === p.team || (t.kind !== 'mower' && t.state !== 'alive')) continue;
    const y0 = t.y + t.radius;
    const y1 = Math.max(y0, t.y + t.height - t.radius);
    const d = Math.max(0, distPointSegment(p.x, p.y, p.z, t.x, y0, t.z, t.x, y1, t.z) - t.radius);
    if (d > p.splash) continue;
    applyDamage(game, t, p.damage * (1 - 0.6 * (d / p.splash)), owner);
    if (p.slow && isFighter(t) && t.state === 'alive') applySlow(t, p.slow);
  }
}

/** Damage a living target. Handles conversion / wilting when hp reaches 0. Returns true if damage landed. */
export function applyDamage(game, target, amount, attacker, { head = false } = {}) {
  if (!target || !(amount > 0)) return false;
  if (target.kind === 'mower') {
    if (target.state !== 'driving' && target.state !== 'starting') return false;
  } else if (target.state !== 'alive' || game.isDriving(target)) {
    return false; // the mower shields its driver completely
  }
  target.hp -= amount;
  const hit = {
    id: target.id,
    by: attacker?.id ?? null,
    x: target.x,
    y: target.y + target.height * 0.6,
    z: target.z,
    dmg: amount,
    hp: Math.max(0, target.hp),
  };
  if (head) hit.head = true;
  game.emit('hit', hit);
  recordHurt(target);
  if (target.hp > 0) return true;
  target.hp = 0;
  if (target.kind === 'mower') destroyMower(game, attacker);
  else if (target.kind === 'garden') destroyGardenPlant(game, target, attacker);
  else if (target.team === 'zombie') convertZombie(game, target, attacker, head);
  else wiltPlantFighter(game, target, attacker, head);
  return true;
}

/** Display name for the kill feed: kids by their name, bots and turrets by what they are. */
export function nameOf(e) {
  if (!e) return null;
  if (typeof e.name === 'string' && e.name !== '') return e.name;
  if (e.kind === 'garden') return e.label || (e.plantKind ? e.plantKind[0].toUpperCase() + e.plantKind.slice(1) : 'Plant');
  if (e.kind === 'bot') return e.team === 'zombie' ? 'Zombie' : 'Plant';
  return null;
}

/** Who did it and to whom, for events the client turns into kill-feed lines. */
export function feedInfo(attacker, target, head = false) {
  const info = {
    by: attacker?.id ?? null,
    byName: nameOf(attacker),
    byKind: attacker?.kind ?? null,
    targetName: nameOf(target),
    targetKind: target?.kind ?? null,
  };
  if (head) info.head = true;
  return info;
}

function convertZombie(game, target, attacker, head = false) {
  const c = game.config;
  const human = target.kind === 'player';
  dropOnConvert(game, target);
  game.emit('convert', { id: target.id, x: target.x, y: target.y, z: target.z, human, ...feedInfo(attacker, target, head) });
  if (human) {
    // A converted kid becomes a little sprout, then digs back up as a zombie at the gate.
    target.state = 'sprout';
    target.timer = c.sproutTime;
    game.clearInput(target);
    creditKill(game, attacker, c.sunPerConversion);
  } else {
    // A converted bot bursts into a flower poof and leaves a sunshine pickup behind.
    game.removeEntity(target);
    spawnSun(game, target.x, target.z, { landed: true });
    creditKill(game, attacker);
  }
}

function wiltPlantFighter(game, target, attacker, head = false) {
  const c = game.config;
  game.emit('wilt', { id: target.id, x: target.x, y: target.y, z: target.z, ...feedInfo(attacker, target, head) });
  if (target.kind === 'player') {
    target.state = 'wilted';
    target.timer = c.wiltRespawn;
    game.clearInput(target);
  } else {
    target.state = 'dead';
    game.entities.delete(target.id);
    if (target.isGardener) game.gardenerTimer = c.gardener.respawn;
  }
  creditKill(game, attacker);
}

function destroyGardenPlant(game, target, attacker) {
  game.emit('wilt', { id: target.id, x: target.x, y: target.y, z: target.z, plantKind: target.plantKind, ...feedInfo(attacker, target) });
  game.removeEntity(target);
  creditKill(game, attacker);
}

/** Progress toward the next gun for human attackers, plus optional sunshine for plant humans. */
export function creditKill(game, attacker, sunshine = 0) {
  if (!attacker || attacker.kind !== 'player') return;
  recordKill(game, attacker);
  if (attacker.team === 'plant') attacker.sunshine += sunshine;
}
