// The lawnmower: zombies fetch it from the garage, spend a few seconds starting it, then mow the garden.
import { WORLD } from './world.js';
import { dist2D } from './vec.js';
import { creditKill } from './combat.js';

export function createMower(game) {
  const h = WORLD.mowerHome;
  const m = {
    id: 'mower',
    kind: 'mower',
    team: 'zombie',
    x: h.x,
    y: h.y,
    z: h.z,
    yaw: 0, // garage door faces -z
    hp: 1,
    maxHp: 1,
    state: 'idle',
    progress: 0, // 0..1 while starting
    driver: null,
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

/** idle -> starting (3 s) -> driving. Losing the driver leaves the mower idle where it is. */
export function stepMower(game, dt) {
  const m = game.mower;
  if (!m) return;
  const c = game.config;

  if (m.state === 'idle') {
    let best = null;
    let bestDist = c.mowerUseRange;
    for (const e of game.entities.values()) {
      if (!isZombieFighter(e) || !e.input.use) continue;
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
  m.z = driver.z;
  m.yaw = driver.yaw;
  for (const g of [...game.entities.values()]) {
    if (g.kind !== 'garden' || dist2D(g.x, g.z, m.x, m.z) > c.mowerKillRadius) continue;
    game.emit('mow', { id: g.id, plantKind: g.plantKind, x: g.x, z: g.z, by: driver.id });
    game.removeEntity(g);
    creditKill(game, driver);
  }
}
