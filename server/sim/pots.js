// Flower pots: where one may stand. A pot is a build kind (config.builds.plant 'pot') that lives on the INTERIOR floor of the
// house (living room, kitchen, hall) and is also a garden slot (garden.js addPotSlot). The map rules here are pure and
// mirrored for the ghost preview in client/map.js (potProblem); who stands where (other pots, people, furniture) is checked
// by build.js. A pot never blocks the way: every waypoint edge that touches the house (the bots' walkways, the doorways and
// the way to the fridge), the repair piles and the spot in front of the fridge keep a clear band, and two pots stay a
// couple of metres apart, so no layout of pots can wall a room off.
import { WORLD } from './world.js';
import { MAP } from './map.js';

const H = WORLD.house;
const r2 = (v) => Math.round(v * 100) / 100;
const inHouse = (x, z) => x > H.minX && x < H.maxX && z > H.minZ && z < H.maxZ;

/** Rooms with pots: the footprint (1 x 1) must lie inside one, `inset` m from its nominal walls. */
export const POT_ROOMS = ['living', 'kitchen', 'hall'].map((id) => ({ ...WORLD.rooms[id], id }));

/** Walkway segments [x0, z0, x1, z1] kept clear: every waypoint edge with an end inside the house (the basement path excluded). */
export const POT_LANES = MAP.edges
  .filter(([a, b]) => !a.startsWith('cel_') && !b.startsWith('cel_'))
  .map(([a, b]) => [...MAP.nodes[a], ...MAP.nodes[b]])
  .filter(([ax, az, bx, bz]) => inHouse(ax, az) || inHouse(bx, bz))
  .map((s) => s.map(r2));

/** The rule numbers and shapes the client needs for the ghost (sent in config.map.pots). */
export function potRules(config) {
  const p = config.pots;
  return {
    rooms: POT_ROOMS.map((r) => ({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ })),
    inset: p.inset,
    lanes: POT_LANES,
    laneClear: p.laneClear,
    fridge: { x: WORLD.fridge.stand.x, z: WORLD.fridge.stand.z, clear: p.fridgeClear },
    piles: WORLD.repair.map((r) => ({ x: r.x, z: r.z, clear: p.pileClear })),
    spacing: p.spacing,
    house: { minX: H.minX, maxX: H.maxX, minZ: H.minZ, maxZ: H.maxZ },
  };
}

function distSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * Map-only pot rules for the 1 x 1 cell at grid corner (gx, gz): null when fine, 'house' (not on the interior floor) or
 * 'lane' (a walkway, doorway, repair pile or the fridge front would be blocked). `rules` = potRules().
 */
export function potProblem(rules, gx, gz) {
  const cx = gx + 0.5;
  const cz = gz + 0.5;
  const i = rules.inset;
  let inside = false;
  for (const r of rules.rooms) {
    if (gx >= r.minX + i && gx + 1 <= r.maxX - i && gz >= r.minZ + i && gz + 1 <= r.maxZ - i) {
      inside = true;
      break;
    }
  }
  if (!inside) return 'house';
  for (const [ax, az, bx, bz] of rules.lanes) if (distSeg(cx, cz, ax, az, bx, bz) < rules.laneClear) return 'lane';
  if (Math.hypot(cx - rules.fridge.x, cz - rules.fridge.z) < rules.fridge.clear) return 'lane';
  for (const p of rules.piles) if (Math.hypot(cx - p.x, cz - p.z) < p.clear) return 'lane';
  return null;
}

/** Is a builder at (x, z) inside the house (pots are placed from indoors)? */
export function insideHouse(rules, x, z) {
  const h = rules.house;
  return x >= h.minX - 0.5 && x <= h.maxX + 0.5 && z >= h.minZ - 0.5 && z <= h.maxZ + 0.5;
}

let rulesCache = null;
let rulesFor = null;
/** potRules(config), cached per config object. */
export function rulesOf(config) {
  if (rulesFor !== config) {
    rulesCache = potRules(config);
    rulesFor = config;
  }
  return rulesCache;
}
