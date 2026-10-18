// The static map: collider shapes (walls, furniture, deck, terraces, bridge, cellar), the four doors, the destructible
// cover layout, part spots and the bot waypoint graph with its routes. Pure data built once at import; deterministic.
//
// Collider shapes: { s:'box', minX, maxX, minZ, maxZ, y0, y1 } or { s:'cyl', x, z, r, y0, y1 }. Flags: blocks (default
// true: stops walking when its top is above feet + STEP), shots (default true: stops projectiles), passTeam (that team
// walks and shoots through it), style (how the client draws it).
import { WORLD, PLOTS, doorBox, doorZone, inRect } from './world.js';
import { terrainHeight } from './terrain.js';
import { makeCover } from './cover-layout.js';

const H = WORLD.house;
const GA = WORLD.garage;
const WALL = H.wall;
const IN = H.inner;
const LOW = -0.5; // wall bases sit a little under the ground

const statics = [];

function box(minX, maxX, minZ, maxZ, y0, y1, style, extra = {}) {
  const c = { s: 'box', minX, maxX, minZ, maxZ, y0, y1, style, ...extra };
  statics.push(c);
  return c;
}

function cyl(x, z, r, y0, y1, style, extra = {}) {
  const c = { s: 'cyl', x, z, r, y0, y1, style, ...extra };
  statics.push(c);
  return c;
}

/** A wall along z (varying z, fixed x) or along x, with gaps [[a, b], ...] left open. */
function wall(axis, fixed, from, to, thick, y0, y1, style, gaps = []) {
  const cuts = [...gaps].sort((p, q) => p[0] - q[0]);
  let a = from;
  const seg = (s, e) => {
    if (e - s < 0.05) return;
    if (axis === 'z') box(fixed - thick / 2, fixed + thick / 2, s, e, y0, y1, style);
    else box(s, e, fixed - thick / 2, fixed + thick / 2, y0, y1, style);
  };
  for (const [g0, g1] of cuts) {
    seg(a, g0);
    a = g1;
  }
  seg(a, to);
}

const gapOf = (center, w) => [center - w / 2, center + w / 2];
const doorsById = Object.fromEntries(WORLD.doors.map((d) => [d.id, d]));

// ---- house shell ------------------------------------------------------------------------------------------------------
const DH = H.height;
// front (z = minZ, faces the gate) and back walls, door gaps cut out
wall('x', H.minZ + WALL / 2, H.minX, H.maxX, WALL, LOW, H.roofTop, 'wall', [gapOf(doorsById.front.x, doorsById.front.w)]);
wall('x', H.maxZ - WALL / 2, H.minX, H.maxX, WALL, LOW, H.roofTop, 'wall', [gapOf(doorsById.back.x, doorsById.back.w)]);
// lintels over the doors keep shots from sneaking over a broken door
for (const id of ['front', 'back']) {
  const b = doorBox(doorsById[id]);
  box(b.minX, b.maxX, b.minZ, b.maxZ, DH, H.roofTop, 'wall');
}
// west wall: side door and the cellar opening
const CL = WORLD.cellar;
const westX = H.minX + WALL / 2;
wall('z', westX, H.minZ, H.maxZ, WALL, LOW, H.roofTop, 'wall', [gapOf(doorsById.side.z, doorsById.side.w), [CL.ramp.minZ + 0.2, CL.ramp.maxZ - 0.2]]);
{
  const b = doorBox(doorsById.side);
  box(b.minX, b.maxX, b.minZ, b.maxZ, DH, H.roofTop, 'wall');
  box(westX - WALL / 2, westX + WALL / 2, CL.ramp.minZ + 0.2, CL.ramp.maxZ - 0.2, -0.2, H.roofTop, 'wall'); // lintel over the cellar stairs
}
// east wall of the house / west wall of the garage (shared), with the hall-garage doorway open
const dwHG = WORLD.doorways.find((d) => d.id === 'hall-garage');
wall('z', H.maxX, H.minZ, H.maxZ, WALL, LOW, H.roofTop, 'wall', [gapOf(dwHG.z, dwHG.w)]);
// garage
wall('x', GA.minZ + WALL / 2, GA.minX, GA.maxX, WALL, LOW, GA.roofTop, 'wall');
wall('x', GA.maxZ - WALL / 2, GA.minX, GA.maxX, WALL, LOW, GA.roofTop, 'wall');
wall('z', GA.maxX - WALL / 2, GA.minZ, GA.maxZ, WALL, LOW, GA.roofTop, 'wall', [gapOf(doorsById.garage.z, doorsById.garage.w)]);
{
  const b = doorBox(doorsById.garage);
  box(b.minX, b.maxX, b.minZ, b.maxZ, DH, GA.roofTop, 'wall');
}
// roofs / ceilings (block lobbed shots too)
box(H.minX, H.maxX, H.minZ, H.maxZ, DH, H.roofTop, 'roof');
box(GA.minX, GA.maxX, GA.minZ, GA.maxZ, DH, GA.roofTop, 'roof');
// interior walls with doorways
for (const dw of WORLD.doorways.filter((d) => d.id !== 'hall-garage')) {
  wall('z', dw.x, H.minZ + WALL, H.maxZ - WALL, IN, 0, DH, 'inner', [gapOf(dw.z, dw.w)]);
}

// ---- furniture (low-poly cover, never destroyed) ------------------------------------------------------------------------
// Keep every doorway corridor (z 13..17) and the kitchen's fridge front (x -4..0, z 20..23) clear.
box(-13.2, -9.6, 6.6, 7.9, 0, 0.95, 'couch');
box(-12.2, -10.6, 9.6, 11.0, 0, 0.45, 'coffeetable');
box(-9.2, -6.5, 22.9, 23.6, 0, 2.0, 'bookshelf');
box(-13.6, -12.5, 17.2, 19.0, 0, 0.9, 'tvstand');
box(-5.85, -5.0, 18.0, 23.0, 0, 0.95, 'counter');
box(1.0, 1.85, 18.0, 23.0, 0, 0.95, 'counter');
box(-4.4, -3.0, 17.9, 19.9, 0, 0.95, 'island');
box(-3.6, -0.4, 8.6, 10.4, 0, 0.8, 'table');
{
  const f = WORLD.fridge;
  box(f.x - f.w / 2, f.x + f.w / 2, f.z - f.d / 2, f.z + f.d / 2, 0, f.h, 'fridge');
}
box(2.15, 3.0, 8.4, 10.4, 0, 1.0, 'cabinet');
cyl(7.3, 22.8, 0.4, 0, 0.8, 'pot');
cyl(7.4, 8.9, 0.25, 0, 1.7, 'rack');
box(17.0, 19.6, 8.5, 9.4, 0, 1.8, 'shelf'); // garage
box(8.6, 9.8, 20.4, 21.5, 0, 0.9, 'crate');
box(9.0, 10.2, 8.6, 9.8, 0, 0.9, 'crate');

// ---- deck, terraces, bridge, cellar -------------------------------------------------------------------------------------
const DK = WORLD.deck;
box(DK.minX, DK.maxX, DK.minZ, DK.maxZ, -1, DK.top, 'deck');
box(3.2, 6.8, DK.maxZ, DK.maxZ + 0.6, -1, 0.6, 'step');
box(3.2, 6.8, DK.maxZ + 0.6, DK.maxZ + 1.2, -1, 0.3, 'step');
// stone terraces: ~1 m ledges you jump onto
box(-26, -19, -5, 0, -4, 1.0, 'terrace');
box(22, 28, -20, -14, -4, 1.0, 'terrace');
box(-24, -17, 31, 37, -4, 0.9, 'terrace');
const BR = WORLD.bridge;
box(BR.minX, BR.maxX, BR.minZ, BR.maxZ, -3, BR.top, 'bridge');
box(BR.minX, BR.minX + 0.2, BR.minZ, BR.maxZ, BR.top, 1.25, 'rail');
box(BR.maxX - 0.2, BR.maxX, BR.minZ, BR.maxZ, BR.top, 1.25, 'rail');
{
  const R = CL.ramp;
  const S = CL.slab;
  const lo = CL.floor - 0.1;
  // trench side walls, basement walls, and the slab (the living room floor above the basement)
  box(R.minX, R.maxX, R.minZ - 0.2, R.minZ + 0.2, lo, 1.0, 'concrete'); // a 1 m parapet: nobody wanders into the stairwell by accident
  box(R.minX, R.maxX, R.maxZ - 0.2, R.maxZ + 0.4, lo, 1.0, 'concrete');
  box(S.minX, S.maxX, S.minZ + 0.8, S.minZ + 1.2, lo, 0.0, 'concrete'); // north wall of the room
  box(S.minX, S.maxX, S.maxZ - 0.4, S.maxZ + 0.4, lo, 0.0, 'concrete'); // south
  box(S.maxX - 0.2, S.maxX + 0.2, S.minZ, S.maxZ + 0.4, lo, 0.0, 'concrete'); // east
  box(S.minX, S.minX + 0.4, S.minZ, R.minZ + 0.2, lo, 0.0, 'concrete'); // west, north of the stairs
  box(S.minX, S.maxX, S.minZ, S.maxZ, -0.2, 0.0, 'slab');
}

// ---- doors (destructible; plants pass, zombies do not) -------------------------------------------------------------------
const doors = WORLD.doors.map((d) => {
  const b = doorBox(d);
  return { id: `door:${d.id}`, kind: 'door', door: d.id, name: d.name, s: 'box', ...b, y0: 0, y1: DH, passTeam: 'plant', shotPassTeam: 'plant', style: 'door' };
});

// ---- no-build zones ---------------------------------------------------------------------------------------------------------
const noBuild = [
  { minX: H.minX - 0.6, maxX: GA.maxX + 0.6, minZ: H.minZ - 0.6, maxZ: H.maxZ + 0.6 },
  { minX: DK.minX - 0.5, maxX: DK.maxX + 0.5, minZ: DK.minZ - 0.5, maxZ: DK.maxZ + 2.2 },
  { minX: CL.ramp.minX - 1, maxX: CL.slab.maxX, minZ: CL.ramp.minZ - 1.5, maxZ: CL.ramp.maxZ + 1.5 },
  { minX: BR.minX - 3, maxX: BR.maxX + 3, minZ: BR.minZ - 3, maxZ: BR.maxZ + 3 },
  { minX: WORLD.shed.minX - 1.5, maxX: WORLD.shed.maxX + 3, minZ: WORLD.shed.minZ - 1.5, maxZ: WORLD.shed.maxZ + 1.5 },
  { minX: WORLD.pen.minX - 1, maxX: WORLD.pen.maxX + 1, minZ: WORLD.pen.minZ, maxZ: WORLD.pen.maxZ + 3 },
  ...PLOTS.map((p) => p.rect),
  ...WORLD.doors.map((d) => doorZone(d)),
];

// ---- waypoint graph ------------------------------------------------------------------------------------------------------
const NODES = {
  // front lawn
  f1: [3, -36], f2: [5, -20], f3: [5, -8], out_front: [5, 3.8],
  // front lawn -> side door
  s1: [-9, -3], s2: [-15, 5], out_side: [-16.5, 15],
  // left gravel path
  l1: [-30, -46], l2: [-35, -38], l3: [-35, -17], l_bridge: [-35, -10.5], l4: [-35, -3], l5: [-35, 12], l_side: [-27, 15],
  l6: [-35, 28], l7: [-14, 29.5], l8: [-1, 30.5], l9: [5, 31.2], out_back: [5, 26.2],
  // right hedge path
  r1: [28, -46], r2: [37.5, -40], r3: [37.5, -20], r_shed: [37.5, -9.5], r4: [37.5, 4], r5: [37.5, 15], r6: [30, 15], out_garage: [22.6, 15],
  // across the front of the garage
  c1: [24, 5], c2: [14, 3.5],
  // inside
  in_front: [5, 8.5], hall: [5, 15], in_back: [5, 21.5], hall_w: [3.2, 15], kit_e: [0.4, 15], kitchen: [-2, 15], kit_w: [-4.4, 15], lk: [-6, 15],
  living: [-10, 15], in_side: [-12.6, 15], fridge: [-2, 21.6],
  hall_g: [8, 15], gar1: [11.5, 15], gar_in: [18.4, 15], gar_mower: [13.5, 12.5], gar_rack: [14, 19.8],
  // basement
  cel_out: [-25, 22.6], cel_top: [-20.4, 22.4], cel_bot: [-14.8, 22.4], cel_room: [-10, 21.6],
  // shed
  shed_door: [36.8, -9.5], shed_in: [30.5, -9.5],
};

const EDGES = [
  ['f1', 'f2'], ['f2', 'f3'], ['f3', 'out_front'],
  ['f2', 's1'], ['s1', 's2'], ['s2', 'out_side'],
  ['l1', 'l2'], ['l2', 'l3'], ['l3', 'l_bridge'], ['l_bridge', 'l4'], ['l4', 'l5'], ['l5', 'l_side'], ['l_side', 'out_side'], ['l5', 'l6'], ['l6', 'l7'], ['l7', 'l8'], ['l8', 'l9'], ['l9', 'out_back'],
  ['r1', 'r2'], ['r2', 'r3'], ['r3', 'r_shed'], ['r_shed', 'r4'], ['r4', 'r5'], ['r5', 'r6'], ['r6', 'out_garage'],
  ['out_garage', 'c1'], ['c1', 'c2'], ['c2', 'out_front'],
  ['out_front', 'in_front'], ['in_front', 'hall'], ['hall', 'in_back'], ['in_back', 'out_back'],
  ['hall', 'hall_w'], ['hall_w', 'kit_e'], ['kit_e', 'kitchen'], ['kitchen', 'kit_w'], ['kit_w', 'lk'], ['lk', 'living'], ['living', 'in_side'], ['in_side', 'out_side'],
  ['kitchen', 'fridge'], ['kit_e', 'fridge'], ['hall', 'hall_g'], ['hall_g', 'gar1'], ['gar1', 'gar_in'], ['gar_in', 'out_garage'], ['gar1', 'gar_mower'], ['gar1', 'gar_rack'],
  ['l_side', 'l6'],
  ['l6', 'cel_out'], ['out_side', 'cel_out'], ['cel_out', 'cel_top'], ['cel_top', 'cel_bot'], ['cel_bot', 'cel_room'],
  ['r_shed', 'shed_door'], ['shed_door', 'shed_in'],
];

/** The ways in from the gate: a route family, and an itinerary (node list) ending at a door's outside node. */
const ROUTES = {
  front: { weight: 0.4, variants: [
    { door: 'front', weight: 0.6, nodes: ['f1', 'f2', 'f3', 'out_front'] },
    { door: 'side', weight: 0.4, nodes: ['f1', 'f2', 's1', 's2', 'out_side'] },
  ] },
  left: { weight: 0.3, variants: [
    { door: 'back', weight: 0.7, nodes: ['l1', 'l2', 'l3', 'l_bridge', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'out_back'] },
    { door: 'side', weight: 0.3, nodes: ['l1', 'l2', 'l3', 'l_bridge', 'l4', 'l5', 'l_side', 'out_side'] },
  ] },
  right: { weight: 0.3, variants: [
    { door: 'garage', weight: 1, nodes: ['r1', 'r2', 'r3', 'r_shed', 'r4', 'r5', 'r6', 'out_garage'] },
  ] },
};

// ---- parts: candidate spots (a few are picked at random every round) --------------------------------------------------------
const PART_SPOTS = [
  { id: 'g1', where: 'garage', x: 9.6, z: 10.4 }, { id: 'g2', where: 'garage', x: 18.8, z: 10.6 }, { id: 'g3', where: 'garage', x: 9.4, z: 18.4 },
  { id: 'c1', where: 'cellar', x: -11.8, z: 19.9 }, { id: 'c2', where: 'cellar', x: -8.2, z: 22.2 }, { id: 'c3', where: 'cellar', x: -8.0, z: 19.9 },
  { id: 's1', where: 'shed', x: 29.2, z: -11.0 }, { id: 's2', where: 'shed', x: 31.6, z: -8.0 },
  { id: 'y1', where: 'yard', x: -24, z: 4 }, { id: 'y2', where: 'yard', x: 17, z: -6 }, { id: 'y3', where: 'yard', x: -13, z: 33 },
  { id: 'y4', where: 'yard', x: 30, z: 26 }, { id: 'y5', where: 'yard', x: 3, z: 40 }, { id: 'y6', where: 'yard', x: -30, z: -20 },
];

export const MAP = {
  statics,
  doors,
  cover: makeCover({ noBuild, nodes: NODES, edges: EDGES, terrainHeight }),
  noBuild,
  nodes: NODES,
  edges: EDGES,
  routes: ROUTES,
  partSpots: PART_SPOTS,
};

export function noBuildAt(x, z, pad = 0) {
  return noBuild.some((r) => inRect(r, x, z, pad));
}
