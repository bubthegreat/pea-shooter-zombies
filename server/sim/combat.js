// Projectiles, damage, conversion (zombies -> plants) and wilting (plants).
import { distPointSegment, forwardVec } from './vec.js';
import { WORLD, insideSolid } from './world.js';
import { getWeapon, weaponFor } from './weapons.js';
import { recordHurt, recordKill } from './upgrades.js';

/** Create a projectile entity. `dir` is a unit vector. */
export function spawnProjectile(game, { team, owner, projKind, damage, speed, x, y, z, dir }) {
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
    life: c.projectileLife,
    damage,
    owner: owner ?? null,
    radius: c.projectileRadius[projKind] ?? c.projectileRadius.pea,
  };
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
    let pitch = shooter.pitch;
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
    });
  }
  return w.pellets;
}

function isTargetable(e) {
  return e.state === 'alive' && (e.kind === 'player' || e.kind === 'bot' || e.kind === 'garden');
}

function projectileHits(p, t) {
  const r = t.radius;
  const y0 = t.y + r;
  const y1 = Math.max(y0, t.y + t.height - r);
  return distPointSegment(p.x, p.y, p.z, t.x, y0, t.z, t.x, y1, t.z) < r + p.radius;
}

/** Move projectiles (substepped so fast shots can't tunnel), resolve hits. */
export function stepProjectiles(game, dt) {
  const c = game.config;
  const ext = WORLD.extent;
  const projectiles = [];
  const targets = [];
  for (const e of game.entities.values()) {
    if (e.kind === 'projectile') projectiles.push(e);
    else if (isTargetable(e)) targets.push(e);
  }
  for (const p of projectiles) {
    const steps = Math.max(1, Math.ceil((p.speed * dt) / c.projectileStep));
    const sdt = dt / steps;
    let dead = false;
    for (let s = 0; s < steps && !dead; s++) {
      p.x += p.vx * sdt;
      p.y += p.vy * sdt;
      p.z += p.vz * sdt;
      if (p.y <= 0 || p.x < ext.minX || p.x > ext.maxX || p.z < ext.minZ || p.z > ext.maxZ || insideSolid(p.x, p.y, p.z)) {
        dead = true;
        break;
      }
      for (const t of targets) {
        if (t.team === p.team || t.state !== 'alive' || !projectileHits(p, t)) continue;
        applyDamage(game, t, p.damage, game.entities.get(p.owner) ?? null);
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

/** Damage a living target. Handles conversion / wilting when hp reaches 0. Returns true if damage landed. */
export function applyDamage(game, target, amount, attacker) {
  if (!target || target.state !== 'alive' || !(amount > 0)) return false;
  target.hp -= amount;
  game.emit('hit', {
    id: target.id,
    by: attacker?.id ?? null,
    x: target.x,
    y: target.y + target.height * 0.6,
    z: target.z,
    dmg: amount,
    hp: Math.max(0, target.hp),
  });
  recordHurt(target);
  if (target.hp > 0) return true;
  target.hp = 0;
  if (target.kind === 'garden') destroyGardenPlant(game, target, attacker);
  else if (target.team === 'zombie') convertZombie(game, target, attacker);
  else wiltPlantFighter(game, target, attacker);
  return true;
}

function convertZombie(game, target, attacker) {
  const c = game.config;
  const human = target.kind === 'player';
  game.emit('convert', { id: target.id, x: target.x, y: target.y, z: target.z, by: attacker?.id ?? null, human });
  if (human) {
    // A converted kid becomes a little sprout, then digs back up as a zombie at the gate.
    target.state = 'sprout';
    target.timer = c.sproutTime;
    game.clearInput(target);
  } else {
    // A converted bot joins the plant team for good as a walking plant bot.
    target.team = 'plant';
    target.maxHp = c.plantHp;
    target.hp = c.plantHp;
    target.weapon = weaponFor('plant', 0).id;
    target.cooldown = 0;
    target.ai = null;
    game.clearInput(target);
  }
  creditKill(game, attacker, c.sunPerConversion);
}

function wiltPlantFighter(game, target, attacker) {
  const c = game.config;
  game.emit('wilt', { id: target.id, x: target.x, y: target.y, z: target.z, by: attacker?.id ?? null });
  if (target.kind === 'player') {
    target.state = 'wilted';
    target.timer = c.wiltRespawn;
    game.clearInput(target);
  } else {
    target.state = 'dead';
    game.entities.delete(target.id);
  }
  creditKill(game, attacker);
}

function destroyGardenPlant(game, target, attacker) {
  game.emit('wilt', { id: target.id, x: target.x, y: target.y, z: target.z, by: attacker?.id ?? null, plantKind: target.plantKind });
  game.removeEntity(target);
  creditKill(game, attacker);
}

/** Progress toward the next gun for human attackers, plus optional sunshine for plant humans. */
export function creditKill(game, attacker, sunshine = 0) {
  if (!attacker || attacker.kind !== 'player') return;
  recordKill(game, attacker);
  if (attacker.team === 'plant') attacker.sunshine += sunshine;
}
