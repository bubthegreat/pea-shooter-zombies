// The Fridge Meter: zombies win by raiding the fridge. Every living zombie within `radius` of the spot in front of the
// open fridge (in the kitchen) fills 1 / fillSeconds of the meter per second, up to `maxZombies` at once. It never
// drains, so every snack counts. A full meter is a zombie win (rules.js).
import { WORLD, inRect } from './world.js';

export function createFridge() {
  return { meter: 0, n: 0 };
}

/** Living zombie fighters standing at the fridge. */
export function zombiesAtFridge(game) {
  const f = WORLD.fridge;
  const kitchen = WORLD.rooms.kitchen;
  const out = [];
  for (const e of game.entities.values()) {
    if ((e.kind !== 'player' && e.kind !== 'bot') || e.team !== 'zombie' || e.state !== 'alive') continue;
    if (Math.hypot(e.x - f.stand.x, e.z - f.stand.z) > f.radius || !inRect(kitchen, e.x, e.z)) continue;
    if (Math.abs(e.y) > 1.5) continue; // not on the roof of something
    out.push(e);
  }
  return out;
}

export function stepFridge(game, dt) {
  const fr = game.fridge;
  const c = game.config.fridge;
  const n = game.config.features.fridge && game.headStart <= 0 ? zombiesAtFridge(game).length : 0;
  if (n > 0 && fr.n === 0) game.emit('fridgeAlarm', { x: WORLD.fridge.x, z: WORLD.fridge.z });
  fr.n = n;
  if (n > 0) fr.meter = Math.min(1, fr.meter + (Math.min(n, c.maxZombies) * dt) / c.fillSeconds);
}
