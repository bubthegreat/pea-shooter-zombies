// Terrain heightmap. Deterministic (no Math.random): a 1 m grid of heights, quantised to centimetres, built from
// rolling hills, two big mounds, a creek bed, flat pads (house, plots, pen, shed) and the cellar pit. The grid is sent to
// the client in the welcome message; both sides sample it with the SAME triangulation (diagonal a-d of every quad), so the
// client mesh and the server's ground height are identical. Platforms with sharp ledges (deck, terraces) are colliders in
// map.js, not part of the grid.
import { WORLD, PLOTS } from './world.js';

const B = WORLD.bounds;
export const CELL = 1;
export const GRID = {
  cell: CELL,
  x0: B.minX,
  z0: B.minZ,
  nx: Math.round((B.maxX - B.minX) / CELL) + 1,
  nz: Math.round((B.maxZ - B.minZ) / CELL) + 1,
};

const smooth = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hash2(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1]. */
function noise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(0, 1, x - ix);
  const fz = smooth(0, 1, z - iz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

function distRect(r, x, z) {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

function distSegment(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / len2)) : 0;
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

export function distPolyline(pts, x, z) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, distSegment(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  return best;
}

const MOUNDS = [
  { x: -18, z: -32, r: 10, h: 3.0 },
  { x: 21, z: -30, r: 9, h: 2.6 },
  { x: -4, z: -20, r: 6, h: 1.2 },
  { x: 30, z: -26, r: 6, h: 1.4 },
  { x: -32, z: 28, r: 7, h: 1.6 },
  { x: 24, z: 35, r: 6, h: 1.0 },
  { x: -16, z: 38, r: 6, h: 1.0 },
];

// Flat zones (height exactly 0 within `core` metres of the rect, blending back to the hills over `fall` more): [rect, core, fall]
const g = WORLD.garage;
const h = WORLD.house;
const FLAT = [
  [{ minX: h.minX, maxX: g.maxX, minZ: h.minZ, maxZ: h.maxZ }, 3.5, 3],
  [WORLD.deck, 2, 2.5],
  [WORLD.pen, 2, 3],
  [WORLD.shed, 1.5, 2.5],
  ...PLOTS.map((p) => [p.rect, 1, 2.5]),
];
const PATHS = WORLD.gravel; // flattened to ~30% of the terrain height

function flatMask(x, z) {
  let m = 0;
  for (const [r, core, fall] of FLAT) m = Math.max(m, 1 - smooth(0, fall, Math.max(0, distRect(r, x, z) - core)));
  for (const p of PATHS) m = Math.max(m, 0.7 * (1 - smooth(p.half, p.half + 3, distPolyline(p.pts, x, z))));
  return m;
}

const edge = (x, z) => Math.min(x - B.minX, B.maxX - x, z - B.minZ, B.maxZ - z);

/** Natural height before the pit overrides. */
function natural(x, z) {
  let hgt = (noise(x / 12 + 7.3, z / 12 + 1.9) - 0.5) * 1.4 + (noise(x / 5 + 3.1, z / 5 + 8.7) - 0.5) * 0.45;
  for (const m of MOUNDS) hgt += m.h * (1 - smooth(0, m.r, Math.hypot(x - m.x, z - m.z)));
  hgt *= (1 - flatMask(x, z)) * smooth(0, 5, edge(x, z)); // flat at the fence, so the meadow outside lines up
  const c = WORLD.creek;
  const d = distPolyline(c.points, x, z);
  const w = (1 - smooth(c.half, c.half + c.bank, d)) * smooth(0, 3.5, edge(x, z));
  if (w > 0) hgt = hgt * (1 - w) - c.depth * w;
  return hgt;
}

/** Height at a lattice vertex (world coordinates on the 1 m grid). */
function vertexHeight(x, z) {
  const cl = WORLD.cellar;
  const R = cl.ramp;
  if (x >= R.minX && x <= R.maxX && z >= R.minZ && z <= R.maxZ) return cl.floor * (x - R.minX) / (R.maxX - R.minX);
  const S = cl.room;
  if (x >= S.minX && x <= S.maxX && z >= S.minZ && z <= S.maxZ) return cl.floor;
  return natural(x, z);
}

function build() {
  const out = new Float64Array(GRID.nx * GRID.nz);
  for (let j = 0; j < GRID.nz; j++) {
    for (let i = 0; i < GRID.nx; i++) {
      out[j * GRID.nx + i] = Math.round(vertexHeight(GRID.x0 + i * CELL, GRID.z0 + j * CELL) * 100) / 100 + 0; // + 0 turns -0 into 0
    }
  }
  return out;
}

const HEIGHTS = build();

/**
 * Ground height at (x, z): triangle interpolation on the grid. Every quad is split along the a-d diagonal where
 * a = (i, j), b = (i + 1, j), c = (i, j + 1), d = (i + 1, j + 1); the client mesh uses exactly these triangles.
 */
export function terrainHeight(x, z) {
  const fx = Math.max(0, Math.min(GRID.nx - 1.000001, (x - GRID.x0) / CELL));
  const fz = Math.max(0, Math.min(GRID.nz - 1.000001, (z - GRID.z0) / CELL));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const k = j * GRID.nx + i;
  const ha = HEIGHTS[k];
  const hb = HEIGHTS[k + 1];
  const hc = HEIGHTS[k + GRID.nx];
  const hd = HEIGHTS[k + GRID.nx + 1];
  return u <= v ? ha + u * (hd - hc) + v * (hc - ha) : ha + v * (hd - hb) + u * (hb - ha);
}

/** Heights as base64 of little-endian int16 centimetres, row-major (z rows, x columns). */
export function terrainData() {
  const buf = Buffer.alloc(HEIGHTS.length * 2);
  for (let i = 0; i < HEIGHTS.length; i++) buf.writeInt16LE(Math.round(HEIGHTS[i] * 100), i * 2);
  return buf.toString('base64');
}

/** The grid description sent to the client. */
export function terrainConfig() {
  return { ...GRID, data: terrainData() };
}

export function terrainMin() {
  let m = Infinity;
  for (const v of HEIGHTS) if (v < m) m = v;
  return m;
}

export function terrainMax() {
  let m = -Infinity;
  for (const v of HEIGHTS) if (v > m) m = v;
  return m;
}
