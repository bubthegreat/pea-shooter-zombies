// The lawnmower: zombies fetch it from the garage, spend a few seconds starting it, then mow the garden.
import { WORLD } from './world.js';
import { dist2D } from './vec.js';
import { creditKill, feedInfo } from './combat.js';

export function createMower(game) {
  const h = WORLD.mowerHome;
  const c = game.config;
  const m = {
    id: 'mower',
    kind: 'mower',
    team: 'zombie',
    x: h.x,
    y: h.y,
    z: h.z,
    yaw: 0, // garage door faces -z
    hp: c.mowerHp,
    maxHp: c.mowerHp,
    radius: c.mowerRadius,
    height: c.mowerHeight,
    state: 'idle', // idle | starting | driving | destroyed
    progress: 0, // 0..1 while starting
    driver: null,
    timer: 0, // seconds until a wrecked mower respawns
  };
  game.entities.set(m.id, m);
  game.mower = m;
  return m;
}

function isZombieFighter(e) {
  return e && (e.kind === 'player' || e.kind === 'bot') && e.team === 'zombie' && e.state === 'alive';
}

function release(m) {
  m.state = 'idle';
  m.driver = null;
  m.progress = 0;
}

/**
 * The mower ran out of HP: it sputters out where it stands (the driver, unhurt, is simply on foot again) and
 * a fresh one appears in the garage after mowerRespawn seconds.
 */
export function destroyMower(game, attacker) {
  const m = game.mower;
  const c = game.config;
  game.emit('mower_destroyed', { x: m.x, y: m.y, z: m.z, ...feedInfo(attacker, m) });
  creditKill(game, attacker);
  m.state = 'destroyed';
  m.driver = null;
  m.progress = 0;
  m.hp = 0;
  m.timer = c.mowerRespawn;
  const h = WORLD.mowerHome; // the wreck is hidden: park it at home until it respawns
  m.x = h.x;
  m.y = h.y;
  m.z = h.z;
}

/**
 * idle -> starting (3 s) -> driving. Losing the driver (or a fresh press of use) leaves the mower idle where it is.
 * At 0 HP it is destroyed and comes back after a while.
 */
export function stepMower(game, dt) {
  const m = game.mower;
  if (!m) return;
  const c = game.config;

  if (m.state === 'destroyed') {
    m.timer -= dt;
    if (m.timer <= 0) {
      m.state = 'idle';
      m.hp = m.maxHp;
      m.timer = 0;
      game.emit('mower_respawn', { x: m.x, y: m.y, z: m.z });
    }
    return;
  }

  if (m.state === 'idle') {
    let best = null;
    let bestDist = c.mowerUseRange;
    for (const e of game.entities.values()) {
      if (!isZombieFighter(e)) continue;
      if (e.mountLatch && !e.input.use) e.mountLatch = false;
      if (!e.input.use || e.mountLatch || e.item) continue; // hands full of lawn equipment
      const d = dist2D(e.x, e.z, m.x, m.z);
      if (d <= bestDist) {
        best = e;
        bestDist = d;
      }
    }
    if (best) {
      m.state = 'starting';
      m.driver = best.id;
      m.progress = 0;
    }
    return;
  }

  const driver = game.entities.get(m.driver);
  if (!isZombieFighter(driver)) {
    release(m);
    return;
  }

  if (m.state === 'driving' && driver.usePressed) {
    // A fresh press of use hops off. (Presses while the engine was still starting don't count.)
    driver.mountLatch = true; // holding the key must not instantly remount
    driver.usePressed = false; // this press is spent
    release(m);
    return;
  }

  if (m.state === 'starting') {
    if (dist2D(driver.x, driver.z, m.x, m.z) > c.mowerUseRange) {
      release(m);
      return;
    }
    m.progress = Math.min(1, m.progress + dt / c.mowerStartTime);
    if (m.progress < 1) return;
    m.state = 'driving';
  }

  // driving: the mower rides along with its driver and flattens every garden plant it touches
  m.x = driver.x;
  m.y = driver.y;
  m.z = driver.z;
  m.yaw = driver.yaw;
  for (const g of [...game.entities.values()]) {
    if (g.kind !== 'garden' || dist2D(g.x, g.z, m.x, m.z) > c.mowerKillRadius) continue;
    game.emit('mow', { id: g.id, plantKind: g.plantKind, x: g.x, z: g.z, ...feedInfo(driver, g) });
    game.removeEntity(g);
    creditKill(game, driver);
  }
}
