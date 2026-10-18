// Mower parts: the powered garage tools and the lawn mower start out unpowered. Glowing parts lie around the map at random
// spots each round (garage, basement, shed, yard). A zombie kid presses E near one to carry it (one at a time), and E at a
// rack hook or at the mower to install it:
//   Battery   -> Leaf Blower or Hedge Trimmer (the hook you stand at), or the mower
//   Gas Can   -> Weed Eater, or the mower
//   Spark Plug-> the mower (it needs Battery + Gas Can + Spark Plug)
// An installed part stays for the round. Shooting a carrier makes him drop the part (and he cannot pick anything up for
// a moment). Q drops it too.
import { MAP } from './map.js';
import { terrainHeight } from './terrain.js';
import { dist2D } from './vec.js';

export const PART_KINDS = ['battery', 'gas', 'plug'];

const isZombieFighter = (e) => (e.kind === 'player' || e.kind === 'bot') && e.team === 'zombie';

export function partsMask(parts) {
  return (parts.battery ? 1 : 0) | (parts.gas ? 2 : 0) | (parts.plug ? 4 : 0);
}

export function mowerComplete(m) {
  return Boolean(m && m.parts.battery && m.parts.gas && m.parts.plug);
}

/** Put the round's parts on the map: config.parts.counts of each kind at distinct random spots. */
export function spawnParts(game) {
  const c = game.config.parts;
  const spots = MAP.partSpots.map((s) => ({ ...s }));
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(game.rng() * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  let k = 0;
  for (const kind of PART_KINDS) {
    for (let n = 0; n < (c.counts[kind] ?? 0) && k < spots.length; n++) createPart(game, kind, spots[k].x, spots[k++].z);
  }
}

export function createPart(game, kind, x, z, y = null) {
  const gy = y ?? game.field.groundAt(x, z, terrainHeight(x, z) + 1.0);
  const e = {
    id: game.newId('t'),
    kind: 'part',
    team: 'zombie',
    partKind: kind,
    x,
    y: gy,
    z,
    yaw: 0,
    hp: 1,
    maxHp: 1,
    state: 'alive',
  };
  game.entities.set(e.id, e);
  return e;
}

/** The carrier lets go: the part lies where he stands. reason: 'drop' | 'shot' | 'converted' | 'left'. */
export function dropCarried(game, e, reason) {
  const kind = e.carry;
  if (!kind) return null;
  e.carry = undefined;
  const part = createPart(game, kind, e.x, e.z, e.y);
  if (reason === 'shot') e.carryLock = game.time + game.config.parts.lockSecs;
  game.emit('partDrop', { id: e.id, part: kind, x: Math.round(e.x * 100) / 100, y: Math.round(e.y * 100) / 100, z: Math.round(e.z * 100) / 100, reason });
  return part;
}

/** Where the carried part would go if the carrier pressed E here: { type: 'mower' } | { type: 'rack', rack } | null. */
export function installTarget(game, e) {
  const c = game.config;
  const kind = e.carry;
  const m = game.mower;
  if (m && m.state !== 'destroyed' && !m.parts[kind] && dist2D(e.x, e.z, m.x, m.z) <= c.mowerUseRange + 0.3) return { type: 'mower' };
  let best = null;
  let bestD = c.rackUseRange;
  for (const rack of game.racks?.values() ?? []) {
    if (c.equipment[rack.itemId]?.needs !== kind || rack.powered) continue;
    const d = dist2D(e.x, e.z, rack.x, rack.z);
    if (d <= bestD) {
      best = rack;
      bestD = d;
    }
  }
  return best ? { type: 'rack', rack: best } : null;
}

function install(game, e, target) {
  const kind = e.carry;
  e.carry = undefined;
  if (target.type === 'mower') {
    game.mower.parts[kind] = true;
    game.emit('install', { id: e.id, part: kind, target: 'mower', x: game.mower.x, z: game.mower.z, mask: partsMask(game.mower.parts) });
  } else {
    target.rack.powered = true;
    game.emit('install', { id: e.id, part: kind, target: target.rack.itemId, x: target.rack.x, z: target.rack.z });
  }
}

/** Per tick: pick up / install / drop. Runs before the mower and the rack so a press that did one of these is spent. */
export function stepParts(game) {
  const c = game.config.parts;
  const parts = [];
  for (const e of game.entities.values()) if (e.kind === 'part' && e.state === 'alive') parts.push(e);
  for (const e of game.entities.values()) {
    if (!isZombieFighter(e) || e.state !== 'alive') continue;
    if (e.carry && (e.dropPressed || game.isHeld(e))) {
      if (e.dropPressed) {
        dropCarried(game, e, 'drop');
        e.dropPressed = false;
        e.mountLatch = true;
      }
      continue;
    }
    if (!e.usePressed || game.isDriving(e) || game.phase !== 'playing') continue;
    if (e.carry) {
      const target = installTarget(game, e);
      if (target) {
        install(game, e, target);
        e.usePressed = false;
        e.mountLatch = true; // a held E must not go on to start the mower
      }
      continue;
    }
    if (e.item || (e.carryLock ?? 0) > game.time || game.isHeld(e)) continue;
    let best = null;
    let bd = c.pickRange;
    for (const p of parts) {
      if (p.state !== 'alive' || Math.abs(p.y - e.y) > 1.8) continue;
      const d = dist2D(e.x, e.z, p.x, p.z);
      if (d <= bd) {
        best = p;
        bd = d;
      }
    }
    if (best) {
      e.carry = best.partKind;
      best.state = 'dead';
      game.entities.delete(best.id);
      parts.splice(parts.indexOf(best), 1);
      e.usePressed = false;
      e.mountLatch = true;
      game.emit('partTake', { id: e.id, part: e.carry });
    }
  }
}
