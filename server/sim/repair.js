// Door repair: plant kids and the Gardener mend doors for free. Each door has a repair pile (planks and a toolbox) just
// inside it (world.js `repair`). Standing within `range` of a pile and holding E (use) - without moving, jumping or shooting -
// heals that door at `rate` HP/s per repairer; a fully broken door is rebuilt after `rebuildTime` seconds of work and comes
// back with `rebuildHp` of its HP. A hit on the repairer pauses the work (`hurtPause`) and a rebuild starts over. A rebuild
// cannot finish while a zombie stands in the doorway.
import { WORLD, doorBox } from './world.js';
import { dist2D } from './vec.js';

const isFighter = (e) => e.kind === 'player' || e.kind === 'bot';
const PILES = WORLD.repair.map((r) => ({ ...r, box: doorBox(WORLD.doors.find((d) => d.id === r.door)) }));

/** The pile whose door a kid at (x, z) can work on, or null. */
export function pileNear(config, x, z) {
  let best = null;
  let bd = config.repair.range;
  for (const p of PILES) {
    const d = dist2D(x, z, p.x, p.z);
    if (d <= bd) {
      best = p;
      bd = d;
    }
  }
  return best;
}

/** Can this fighter work on a door right now (still, not shooting, not just hit)? */
export function canRepair(game, e) {
  if (!isFighter(e) || e.team !== 'plant' || e.state !== 'alive' || game.phase !== 'playing') return false;
  if (e.kind === 'bot' && !e.isGardener) return false;
  const k = e.input.keys;
  if (k.f || k.b || k.l || k.r || k.jump || e.input.fire || !e.input.use) return false;
  if (e.vy > 0.1 || e.grounded === false) return false;
  if (game.time - (e.hurtAt ?? -1e9) < game.config.repair.hurtPause) return false;
  return true;
}

function zombieInDoorway(game, box) {
  for (const e of game.entities.values()) {
    if (!isFighter(e) || e.team !== 'zombie' || e.state !== 'alive') continue;
    if (e.x > box.minX - 0.6 && e.x < box.maxX + 0.6 && e.z > box.minZ - 0.6 && e.z < box.maxZ + 0.6) return true;
  }
  return false;
}

export function stepRepair(game, dt) {
  const c = game.config.repair;
  const work = new Map(); // pile -> total seconds of work this tick
  for (const e of game.entities.values()) {
    if (!isFighter(e)) continue;
    if (e.repairing !== undefined) {
      e.repairing = undefined;
      e.rebuild = undefined;
    }
    if (e.team !== 'plant' || !canRepair(game, e)) continue;
    const pile = pileNear(game.config, e.x, e.z);
    if (!pile) continue;
    const piece = game.cover.get(`door:${pile.door}`);
    if (!piece) continue;
    if (piece.state === 'alive' && piece.hp >= piece.maxHp) continue; // nothing to mend
    e.repairing = pile.door;
    work.set(pile, (work.get(pile) ?? 0) + dt);
    if (piece.state === 'broken') e.rebuild = Math.min(1, ((piece.rebuildT ?? 0) + dt) / c.rebuildTime);
    e.repairFx = (e.repairFx ?? 0) - dt;
    if (e.repairFx <= 0) {
      e.repairFx = c.fxEvery;
      game.emit('repair', { id: e.id, door: pile.door, x: pile.x, z: pile.z, rebuild: piece.state === 'broken' });
    }
  }
  for (const pile of PILES) {
    const piece = game.cover.get(`door:${pile.door}`);
    if (!piece) continue;
    const t = work.get(pile) ?? 0;
    if (piece.state === 'alive') {
      piece.rebuildT = 0;
      if (t > 0) game.cover.heal(piece, c.rate * (game.scaling?.plant.repair ?? 1) * t);
    } else if (t > 0) {
      piece.rebuildT = (piece.rebuildT ?? 0) + t;
      if (piece.rebuildT >= c.rebuildTime) {
        if (zombieInDoorway(game, pile.box)) piece.rebuildT = c.rebuildTime; // wait for the doorway to clear
        else {
          game.cover.rebuildDoor(piece, piece.maxHp * c.rebuildHp);
          piece.rebuildT = 0;
        }
      }
    } else piece.rebuildT = 0; // the work was interrupted: start over
  }
}
