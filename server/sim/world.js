// Static world layout: constants and pure helpers only (no terrain, no colliders; see terrain.js / map.js / collide.js).
// Y up, meters. Yard x in [-40, 40], z in [-52, 46]. Zombies enter at the gate (-z) and walk toward the house (+z).
// The house sits in the middle-back; the yard wraps around it. Yaw 0 faces -z.

export const PLAYER_RADIUS = 0.5;

const WALL = 0.4; // outer wall thickness
const INNER = 0.3; // interior wall thickness

// Doors: (x, z) is the centre of the wall, (nx, nz) points outward, w is the opening width.
const house = { minX: -14, maxX: 8, minZ: 6, maxZ: 24, wall: WALL, inner: INNER, height: 3.4, roofTop: 8 };
const garage = { minX: 8, maxX: 20, minZ: 8, maxZ: 22, wall: WALL, height: 3.4, roofTop: 5.6 };

const doors = [
  { id: 'front', name: 'Front door', x: 5, z: house.minZ + WALL / 2, w: 3, nx: 0, nz: -1 },
  { id: 'side', name: 'Side door', x: house.minX + WALL / 2, z: 15, w: 3, nx: -1, nz: 0 },
  { id: 'back', name: 'Back door', x: 5, z: house.maxZ - WALL / 2, w: 3, nx: 0, nz: 1 },
  { id: 'garage', name: 'Garage door', x: garage.maxX - WALL / 2, z: 15, w: 5, nx: 1, nz: 0 },
];

// Row kinds for every plot, outermost row (toward the zombies) first: Peashooter / Cactus / Cactus / Peashooter.
export const PLOT_ROW_KINDS = ['peashooter', 'cactus', 'cactus', 'peashooter'];
const PLOT_COLS = [-5.25, -1.75, 1.75, 5.25]; // lateral offsets from the plot centre
const PLOT_ROWS = [15, 11.5, 8, 4.5]; // distance from the door's outer face, outermost first
const BACK_ROWS = [18.5, 15, 11.5, 8]; // the back plot starts beyond the deck

export const WORLD = {
  bounds: { minX: -40, maxX: 40, minZ: -52, maxZ: 46 },
  gate: { z: -50, minX: -16, maxX: 16 },
  pen: { minX: -16, maxX: 16, minZ: -52, maxZ: -46.5 }, // zombies wait here during the plants' head start
  house,
  garage,
  doors,
  rooms: {
    living: { minX: -14, maxX: -6, minZ: 6, maxZ: 24 },
    kitchen: { minX: -6, maxX: 2, minZ: 6, maxZ: 24 },
    hall: { minX: 2, maxX: 8, minZ: 6, maxZ: 24 },
    garageRoom: { minX: 8, maxX: 20, minZ: 8, maxZ: 22 },
    cellar: { minX: -13, maxX: -7, minZ: 19, maxZ: 23 },
  },
  // Interior doorways (open): x of the wall, z centre, width.
  doorways: [
    { id: 'living-kitchen', x: -6, z: 15, w: 3 },
    { id: 'kitchen-hall', x: 2, z: 15, w: 3 },
    { id: 'hall-garage', x: 8, z: 15, w: 3 },
  ],
  // The fridge stands against the kitchen's back wall; zombies earn the Fridge Meter within `radius` of `stand`.
  fridge: { x: -2, z: 23.35, w: 0.9, d: 0.7, h: 2.0, stand: { x: -2, z: 22.0 }, radius: 2.0 },
  mowerHome: { x: 13.5, y: 0, z: 11 },
  plantSpawn: { x: 5, y: 0, z: 3.5 }, // the front porch
  deck: { minX: 0, maxX: 10, minZ: 24, maxZ: 28.4, top: 0.9 },
  shed: { minX: 28, maxX: 33, minZ: -12, maxZ: -7, door: { side: 'east', c: -9.5, w: 1.8 } },
  // Storm cellar: slanted outside hatch on the west side of the house, stairs down into a basement under the living room.
  cellar: {
    floor: -2.6,
    room: { minX: -13, maxX: -7, minZ: 19, maxZ: 23 }, // flat basement floor (grid vertices)
    ramp: { minX: -20, maxX: -14, minZ: 21, maxZ: 24 }, // trench: ground level at minX, basement floor at maxX
    slab: { minX: -14, maxX: -6, minZ: 18, maxZ: 24 }, // the living room floor above: covers the room and its sloped margin
  },
  creek: { points: [[-41, -10], [-30, -11], [-22, -9], [-14, -10.5], [-8, -10.5]], half: 2.0, bank: 2.6, depth: 1.1 },
  bridge: { minX: -36.5, maxX: -33.5, minZ: -13.6, maxZ: -7.4, top: 0.3 },
  gravel: [ // routes' painted paths (half-width m) for the client; bots use map.js nav
    { id: 'left', half: 1.5, pts: [[-14, -49], [-30, -46], [-35, -38], [-35, -10.5], [-35, 28], [-14, 29.5], [4, 30.5]] },
    { id: 'right', half: 1.5, pts: [[14, -49], [28, -46], [37.5, -40], [37.5, 15], [28, 15], [22.4, 15]] },
    { id: 'front', half: 1.7, pts: [[0, -49], [3, -34], [5, -18], [5, 3]] },
  ],
  plotRect: 1.8, // plots reach this far past the outermost slots
  // Door repair piles, INSIDE next to each door: plants hold E here to mend that door (server/sim/repair.js).
  repair: [
    { door: 'front', x: 3.0, z: 7.3 },
    { door: 'side', x: -12.9, z: 12.9 },
    { door: 'back', x: 3.0, z: 22.7 },
    { door: 'garage', x: 18.9, z: 18.3 },
  ],
};

function tangent(d) {
  return d.nz !== 0 ? { x: 1, z: 0 } : { x: 0, z: 1 };
}

/** The point on the door's outer wall face (centre of the opening). */
export function doorFace(d) {
  return { x: d.x + d.nx * WALL / 2, z: d.z + d.nz * WALL / 2 };
}

/** Plot description for each door: where its slots are. Order = slot order: front, side, back, garage. */
export const PLOTS = ['front', 'side', 'back', 'garage'].map((id, index) => {
  const door = doors.find((d) => d.id === id);
  const face = doorFace(door);
  const t = tangent(door);
  const lat = id === 'side' || id === 'garage' ? -2 : 0; // keep the side plots clear of the cellar stairs / garage corner
  const rows = id === 'back' ? BACK_ROWS : PLOT_ROWS;
  const slots = [];
  rows.forEach((dist, r) => {
    PLOT_COLS.forEach((off, c) => {
      slots.push({
        x: Math.round((face.x + door.nx * dist + t.x * (off + lat)) * 100) / 100,
        z: Math.round((face.z + door.nz * dist + t.z * (off + lat)) * 100) / 100,
        kind: PLOT_ROW_KINDS[r],
        plot: index,
        door: id,
        row: r,
        col: c,
      });
    });
  });
  // bounding rectangle (for no-build zones and the client)
  const xs = slots.map((s) => s.x);
  const zs = slots.map((s) => s.z);
  const m = WORLD.plotRect;
  const rect = { minX: Math.min(...xs) - m, maxX: Math.max(...xs) + m, minZ: Math.min(...zs) - m, maxZ: Math.max(...zs) + m };
  return { index, door: id, slots, rect };
});

const SLOTS = PLOTS.flatMap((p) => p.slots);

/** All garden slots, plot by plot, outermost row first within a plot: [{x, z, kind, plot, door, row, col}]. */
export function gardenSlots() {
  return SLOTS.map((s) => ({ ...s }));
}

/** Slot index of (plot, row, col). */
export function slotIndex(plot, row, col) {
  return plot * 16 + row * 4 + col;
}

export function doorById(id) {
  return doors.find((d) => d.id === id) ?? null;
}

/** Axis-aligned box of a door (the part that fills the wall gap). */
export function doorBox(d) {
  if (d.nz !== 0) return { minX: d.x - d.w / 2, maxX: d.x + d.w / 2, minZ: d.z - WALL / 2, maxZ: d.z + WALL / 2 };
  return { minX: d.x - WALL / 2, maxX: d.x + WALL / 2, minZ: d.z - d.w / 2, maxZ: d.z + d.w / 2 };
}

/** The strip in front of a door that builds may never occupy (and a door's frame). */
export function doorZone(d, depth = 3.2, pad = 0.6) {
  const f = doorFace(d);
  const hw = d.w / 2 + pad;
  if (d.nz !== 0) {
    const z0 = d.nz < 0 ? f.z - depth : f.z - 0.2;
    return { minX: d.x - hw, maxX: d.x + hw, minZ: z0, maxZ: z0 + depth + 0.2 };
  }
  const x0 = d.nx < 0 ? f.x - depth : f.x - 0.2;
  return { minX: x0, maxX: x0 + depth + 0.2, minZ: d.z - hw, maxZ: d.z + hw };
}

export function inRect(r, x, z, pad = 0) {
  return x >= r.minX - pad && x <= r.maxX + pad && z >= r.minZ - pad && z <= r.maxZ + pad;
}

export function rectsOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}
