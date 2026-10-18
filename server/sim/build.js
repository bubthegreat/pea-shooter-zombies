// Fortifications: both teams can wall things up. A build is a box on the 1 m grid (rotatable by 90 degrees) with HP that
// blocks walking and shots like cover. Plants pay sunshine (Hedge Wall, Wooden Fence; the Wall-nut stays a garden plant),
// zombie kids pay brains (Tombstone Wall, Junk Barricade, Trash-can Tower). Placement is validated here; the client
// shows a ghost with its own copy of the rules.
import { WORLD, inRect } from './world.js';
import { MAP } from './map.js';
import { terrainHeight } from './terrain.js';
import { rulesOf, potProblem, insideHouse } from './pots.js';
import { addPotSlot } from './garden.js';

/** Footprint of a build kind in whole metres for a rotation (0 or 1). */
export function footprint(def, rot) {
  return rot ? { w: def.d, d: def.w } : { w: def.w, d: def.d };
}

/** The build list a team can use (index n in the input is list[n - 1]). */
export function buildList(config, team) {
  return config.builds[team === 'zombie' ? 'zombie' : 'plant'];
}

function rectCircle(r, x, z, rad) {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return dx * dx + dz * dz < rad * rad;
}

/**
 * Can `player` put build `def` on the footprint at grid cell (gx, gz) with rotation `rot`? Returns
 * { ok: true, rect, lo, hi } or { ok: false, reason } with reason 'spot' | 'far' | 'cost' | 'cap' | 'blocked' | 'busy'.
 * Pots (def.pot) add 'house' (not on the interior floor, or the builder is outdoors), 'lane' (a walkway, door, pile or the
 * fridge front would be blocked) and 'crowd' (too close to another pot); they have their own cap and their own ground.
 */
export function checkBuild(game, player, def, gx, gz, rot, { free = false } = {}) {
  const c = game.config.builds;
  if (!Number.isInteger(gx) || !Number.isInteger(gz) || Math.abs(gx) > 200 || Math.abs(gz) > 200) return { ok: false, reason: 'spot' };
  const f = footprint(def, rot ? 1 : 0);
  const rect = { minX: gx, maxX: gx + f.w, minZ: gz, maxZ: gz + f.d };
  const B = WORLD.bounds;
  if (rect.minX < B.minX + 1 || rect.maxX > B.maxX - 1 || rect.minZ < B.minZ + 1 || rect.maxZ > B.maxZ - 1) return { ok: false, reason: 'spot' };
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  if (Math.hypot(player.x - cx, player.z - cz) > c.reach) return { ok: false, reason: 'far' };
  const pot = Boolean(def.pot);
  if (!free) {
    const cur = def.team === 'zombie' ? player.brains ?? 0 : player.sunshine ?? 0;
    if (cur < def.cost) return { ok: false, reason: 'cost' };
    if (pot ? game.cover.buildsOf(player.id, 'pot') >= game.config.pots.max : game.cover.buildsOf(player.id, 'fort') >= c.maxPerPlayer) return { ok: false, reason: 'cap' };
  }
  let lo = Infinity;
  let hi = -Infinity;
  if (pot) {
    // the interior floor: map rules, the builder indoors, room between pots, flat floor (the living room floor is a slab over the cellar)
    const rules = rulesOf(game.config);
    const why = potProblem(rules, gx, gz);
    if (why) return { ok: false, reason: why };
    if (!insideHouse(rules, player.x, player.z)) return { ok: false, reason: 'house' };
    for (const p of game.cover.pieces.values()) {
      if (p.state === 'alive' && p.build?.kind === 'pot' && Math.hypot(p.x - cx, p.z - cz) < rules.spacing) return { ok: false, reason: 'crowd' };
    }
    lo = hi = inRect(WORLD.cellar.slab, cx, cz) ? 0 : terrainHeight(cx, cz); // (the living room floor is a slab over the cellar pit)
  } else {
    for (const z of MAP.noBuild) if (rect.minX < z.maxX && rect.maxX > z.minX && rect.minZ < z.maxZ && rect.maxZ > z.minZ) return { ok: false, reason: 'blocked' };
    // ground: not a ditch, not a cliff
    for (const [x, z] of [[rect.minX, rect.minZ], [rect.maxX, rect.minZ], [rect.minX, rect.maxZ], [rect.maxX, rect.maxZ], [cx, cz]]) {
      const h = terrainHeight(x, z);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    if (lo < -0.45 || hi - lo > 0.9) return { ok: false, reason: 'spot' };
  }
  // other solid things (walls, cover, builds, doors): anything standing there whose top is above the ground
  let hit = false;
  game.field.each(rect.minX - 0.1, rect.maxX + 0.1, rect.minZ - 0.1, rect.maxZ + 0.1, (col) => {
    if (hit || col.blocks === false) return;
    if (col.y1 <= lo + 0.3 || col.y0 >= hi + def.h) return; // low things are stepped over; roofs and lintels are above
    if (col.s === 'box') hit = col.minX < rect.maxX && col.maxX > rect.minX && col.minZ < rect.maxZ && col.maxZ > rect.minZ;
    else hit = rectCircle(rect, col.x, col.z, col.r);
  });
  if (hit) return { ok: false, reason: 'blocked' };
  // people and turrets in the way
  for (const e of game.entities.values()) {
    if (e.kind !== 'player' && e.kind !== 'bot' && e.kind !== 'garden') continue;
    if (e.state === 'dead') continue;
    if (rectCircle(rect, e.x, e.z, (e.radius ?? 0.5) + 0.1)) return { ok: false, reason: 'busy' };
  }
  return { ok: true, rect, lo, hi };
}

/**
 * Place a build. Returns the piece, or null (nothing changes; a `buildFail` event tells the player why).
 * `kind` is the 1-based index into the player's team list.
 */
export function tryBuild(game, player, kind, gx, gz, rot) {
  if (!player || (player.kind !== 'player' && !player.isGardener) || player.state !== 'alive' || game.phase !== 'playing') return null;
  const list = buildList(game.config, player.team);
  const def = list[kind - 1];
  if (!def) return null;
  const fail = (reason) => {
    game.emit('buildFail', { by: player.id, reason });
    return null;
  };
  if (game.isHeld(player)) return fail('busy');
  const chk = checkBuild(game, player, { ...def, team: player.team }, gx, gz, rot ? 1 : 0);
  if (!chk.ok) return fail(chk.reason);
  if (player.team === 'zombie') player.brains -= def.cost;
  else player.sunshine -= def.cost;
  const piece = game.cover.addBuild(def, player, gx, gz, rot ? 1 : 0, chk);
  if (def.pot) addPotSlot(game, piece, chk.lo);
  return piece;
}
