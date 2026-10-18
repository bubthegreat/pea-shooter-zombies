// Garage equipment rack: lawn tools zombies can grab instead of their gun. One instance of each item;
// it respawns on its rack slot rackRespawn seconds after it is dropped, destroyed or its holder is converted.
// Everything is data-driven from config.equipment / config.rack.
import { dist2D, forwardVec, rightVec } from './vec.js';
import { applyDamage } from './combat.js';

const isFighter = (e) => e.kind === 'player' || e.kind === 'bot';
const isZombieFighter = (e) => isFighter(e) && e.team === 'zombie';

/** Build the rack entities (called when a round starts). */
export function createRack(game) {
  const c = game.config;
  game.racks = new Map();
  for (const slot of c.rack) {
    if (!c.equipment[slot.item]) continue;
    const e = {
      id: `rack_${slot.item}`,
      kind: 'rack_item',
      team: 'zombie',
      itemId: slot.item,
      x: slot.x,
      y: 0,
      z: slot.z,
      yaw: 0, // hangs on the back wall of the garage
      hp: 1,
      maxHp: 1,
      state: 'alive',
      available: true,
      heldBy: null,
      timer: 0,
      powered: !c.equipment[slot.item].needs, // battery / gas tools need their part first
    };
    game.entities.set(e.id, e);
    game.racks.set(slot.item, e);
  }
}

function nearRack(game, e, rack, range = game.config.rackUseRange) {
  return dist2D(e.x, e.z, rack.x, rack.z) <= range;
}

/** Hand an item to a zombie (no checks). */
function giveItem(game, holder, rack) {
  const c = game.config;
  holder.item = rack.itemId;
  const def = c.equipment[rack.itemId];
  if (def.hp) holder.itemHp = def.hp;
  else delete holder.itemHp;
  holder.itemTimer = 0;
  rack.available = false;
  rack.heldBy = holder.id;
  rack.timer = 0;
  game.emit('item_take', { id: holder.id, itemId: rack.itemId });
}

/**
 * The holder lets go of the item. reason: 'drop' | 'converted' | 'destroyed' | 'left' | 'returned'.
 * It reappears on the rack after rackRespawn seconds ('returned' = put straight back).
 */
export function releaseItem(game, holder, reason) {
  const id = holder.item;
  if (!id) return;
  const rack = game.racks?.get(id);
  holder.item = null;
  holder.using = false;
  holder.itemTimer = 0;
  delete holder.itemHp;
  if (!rack) return;
  rack.heldBy = null;
  if (reason === 'returned') {
    rack.available = true;
    rack.timer = 0;
  } else {
    rack.available = false;
    rack.timer = game.config.rackRespawn;
  }
  game.emit('item_drop', { id: holder.id, itemId: id, x: holder.x, z: holder.z, reason });
}

/** A holder was converted/removed: the tool goes back to the rack (after the delay). */
export function dropOnConvert(game, holder) {
  if (holder.item) releaseItem(game, holder, 'converted');
}

/** The wheelbarrow soaked up `amount` damage. */
function damageBarrow(game, holder, amount) {
  holder.itemHp -= amount;
  if (holder.itemHp <= 0) releaseItem(game, holder, 'destroyed');
}

/**
 * Does a plant-team projectile run into the wheelbarrow `holder` is pushing? The barrow is a small box
 * ahead of the holder. Returns true if the shot was absorbed.
 */
export function barrowBlocks(game, holder, p) {
  if (holder.item !== 'wheelbarrow' || holder.state !== 'alive' || p.team === holder.team) return false;
  const sh = game.config.equipment.wheelbarrow.shield;
  const f = forwardVec(holder.yaw, 0);
  const r = rightVec(holder.yaw);
  const cx = holder.x + f.x * sh.forward;
  const cz = holder.z + f.z * sh.forward;
  const dx = p.x - cx;
  const dz = p.z - cz;
  const along = dx * f.x + dz * f.z;
  const across = dx * r.x + dz * r.z;
  if (Math.abs(across) > sh.halfWidth + p.radius || Math.abs(along) > sh.depth / 2 + p.radius) return false;
  if (p.y < holder.y || p.y > holder.y + sh.height) return false;
  game.emit('block', { x: p.x, y: p.y, z: p.z, itemId: 'wheelbarrow' });
  return true;
}

/** Damage the barrow for a blocked shot (separate so splash shots can explode first). */
export function barrowTakesHit(game, holder, p) {
  damageBarrow(game, holder, p.damage);
}

/** Enemies (plant team) of a zombie that sit in a cone in front of it. */
function* coneTargets(game, holder, def) {
  const f = forwardVec(holder.yaw, 0);
  for (const t of game.entities.values()) {
    if (t.team !== 'plant' || t.state !== 'alive') continue;
    if (t.kind !== 'garden' && !isFighter(t)) continue;
    const dx = t.x - holder.x;
    const dz = t.z - holder.z;
    const d = Math.hypot(dx, dz);
    if (d - t.radius > def.range) continue;
    if (d > 0.01) {
      const cos = (dx * f.x + dz * f.z) / d;
      const ang = Math.acos(Math.max(-1, Math.min(1, cos)));
      const slack = Math.asin(Math.min(1, t.radius / Math.max(d, t.radius)));
      if (ang > def.halfAngle + slack) continue;
    }
    yield { t, dx, dz, d };
  }
}

/** Doors, cover and builds in the cone: [{ piece, d }] (d = distance to the nearest point of the piece). */
function* pieceTargets(game, holder, def) {
  const f = forwardVec(holder.yaw, 0);
  const reach = def.range;
  const found = [];
  game.field.each(holder.x - reach, holder.x + reach, holder.z - reach, holder.z + reach, (c) => {
    const p = c._piece;
    if (!p || !game.cover.canHurt(p, holder.team)) return;
    if (p.y1 < holder.y || p.y0 > holder.y + 2) return;
    let px;
    let pz;
    if (c.s === 'box') {
      px = Math.max(c.minX, Math.min(holder.x, c.maxX));
      pz = Math.max(c.minZ, Math.min(holder.z, c.maxZ));
    } else {
      const dx = c.x - holder.x;
      const dz = c.z - holder.z;
      const d = Math.hypot(dx, dz) || 1;
      px = c.x - (dx / d) * c.r;
      pz = c.z - (dz / d) * c.r;
    }
    const dx = px - holder.x;
    const dz = pz - holder.z;
    const d = Math.hypot(dx, dz);
    if (d > reach) return;
    if (d > 0.9) {
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * f.x + dz * f.z) / d)));
      if (ang > def.halfAngle + 0.35) return;
    }
    found.push({ piece: p, d });
  });
  yield* found;
}

function swing(game, holder, def, tick) {
  const f = forwardVec(holder.yaw, 0);
  if (def.dpsStruct > 0) for (const { piece } of pieceTargets(game, holder, def)) game.cover.damage(piece, def.dpsStruct * tick, holder, holder.team);
  for (const { t } of [...coneTargets(game, holder, def)]) {
    const dps = t.kind === 'garden' ? def.dpsGarden : def.dpsFighter;
    if (dps > 0) applyDamage(game, t, dps * tick, holder);
    if (def.knock && isFighter(t) && t.state === 'alive') {
      t.x += f.x * def.knock * tick;
      t.z += f.z * def.knock * tick;
      game.field.resolve(t, t.radius, t.y, t.y + t.height, t.team);
    }
  }
  if (def.blowSun) {
    for (const sun of game.entities.values()) {
      if (sun.kind !== 'sun') continue;
      const dx = sun.x - holder.x;
      const dz = sun.z - holder.z;
      const d = Math.hypot(dx, dz);
      if (d > def.range || d < 0.01) continue;
      const cos = (dx * f.x + dz * f.z) / d;
      if (Math.acos(Math.max(-1, Math.min(1, cos))) > def.halfAngle) continue;
      sun.x += (dx / d) * def.blowSun * tick;
      sun.z += (dz / d) * def.blowSun * tick;
      game.field.resolve(sun, 0, 0, 1, null);
    }
  }
  if (def.deflect) {
    for (const p of [...game.entities.values()]) {
      if (p.kind !== 'projectile' || p.team === holder.team || p.blowRolled || p.splash || p.damage > def.deflectMaxDamage) continue;
      const dx = p.x - holder.x;
      const dz = p.z - holder.z;
      const d = Math.hypot(dx, dz);
      if (d > def.range) continue;
      const cos = d > 0.01 ? (dx * f.x + dz * f.z) / d : 1;
      if (Math.acos(Math.max(-1, Math.min(1, cos))) > def.halfAngle) continue;
      p.blowRolled = true; // one roll per shot
      if (game.rng() < def.deflect) {
        game.emit('deflect', { x: p.x, y: p.y, z: p.z });
        game.entities.delete(p.id);
      }
    }
  }
}

/** Per-tick equipment logic: take / drop / put back, tools in use, rack respawns. */
export function stepEquipment(game, dt) {
  const c = game.config;
  if (!game.racks) return;

  // keep every rack's holder honest (disconnects, conversions, round changes)
  for (const rack of game.racks.values()) {
    if (rack.heldBy === null) continue;
    const holder = game.entities.get(rack.heldBy);
    if (!holder || holder.item !== rack.itemId) {
      rack.heldBy = null;
      rack.available = false;
      rack.timer = c.rackRespawn;
      game.emit('item_drop', { id: rack.id, itemId: rack.itemId, x: rack.x, z: rack.z, reason: 'left' });
    } else if (holder.state !== 'alive' || holder.team !== 'zombie') {
      releaseItem(game, holder, 'converted');
    }
  }

  for (const rack of game.racks.values()) {
    if (rack.available || rack.heldBy !== null) continue;
    rack.timer -= dt;
    if (rack.timer <= 0) {
      rack.timer = 0;
      rack.available = true;
      game.emit('item_respawn', { itemId: rack.itemId });
    }
  }

  for (const e of game.entities.values()) {
    if (!isZombieFighter(e) || e.state !== 'alive') continue;
    const driving = game.isDriving(e);
    // swapping: E at a rack takes, Q or E away from the rack drops, E at the rack puts it back
    if (e.item) {
      const own = game.racks.get(e.item);
      if (e.dropPressed || e.usePressed) {
        releaseItem(game, e, own && nearRack(game, e, own) ? 'returned' : 'drop');
        e.mountLatch = true; // a held E must not go on to start the mower: it needs a fresh press
      }
    } else if (e.usePressed && !driving && game.mower?.driver !== e.id) {
      let best = null;
      let bestD = c.rackUseRange;
      for (const rack of game.racks.values()) {
        if (!rack.available || !rack.powered) continue;
        const d = dist2D(e.x, e.z, rack.x, rack.z);
        if (d <= bestD) {
          best = rack;
          bestD = d;
        }
      }
      if (best) giveItem(game, e, best);
    }

    // using the tool: hold fire
    const def = e.item ? c.equipment[e.item] : null;
    e.using = false;
    if (!def || !def.range || driving || game.phase !== 'playing' || !e.input.fire) {
      e.itemTimer = 0;
      continue;
    }
    e.using = true;
    e.itemTimer = (e.itemTimer ?? 0) + dt;
    while (e.itemTimer >= def.tick) {
      e.itemTimer -= def.tick;
      swing(game, e, def, def.tick);
    }
  }
}
