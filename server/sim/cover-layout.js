// The destructible cover layout: gravestones (lots, zombie side), rocks, trees, hedges, trash cans, a picnic table, a kiddie
// pool and the shed walls. Seeded, so every server and every round has the same yard. Pieces keep clear of plots, doors,
// the house, spawn pens and the waypoint paths; the layout test checks it.
import { WORLD, inRect } from './world.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distSeg(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / len2)) : 0;
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

/**
 * env: { noBuild: [rect], nodes, edges, terrainHeight }. Returns [{ id, kind, s, ..., y0, y1, rot? }].
 */
export function makeCover({ noBuild, nodes, edges, terrainHeight }) {
  const rnd = mulberry32(20261018);
  const B = WORLD.bounds;
  const pieces = [];
  const placed = []; // { x, z, r } footprints for the spacing test
  const outdoorEdges = edges
    .map(([a, b]) => [nodes[a], nodes[b]])
    .filter(([p, q]) => !(inRect(WORLD.house, p[0], p[1], 0.5) && inRect(WORLD.house, q[0], q[1], 0.5)));

  const slopeAt = (x, z) => {
    const h = terrainHeight(x, z);
    return Math.max(Math.abs(terrainHeight(x + 1, z) - h), Math.abs(terrainHeight(x, z + 1) - h));
  };

  /** Free spot for a footprint of radius r? */
  const free = (x, z, r, { clearPaths = true, spacing = 0.5, pad = r + 0.5, edge = 1.5 } = {}) => {
    if (x < B.minX + r + edge || x > B.maxX - r - edge || z < B.minZ + r + edge || z > B.maxZ - r - edge) return false;
    for (const rect of noBuild) if (inRect(rect, x, z, pad)) return false;
    if (clearPaths) {
      for (const [p, q] of outdoorEdges) if (distSeg(x, z, p[0], p[1], q[0], q[1]) < 2.2 + r) return false;
      for (const k of Object.values(nodes)) if (Math.hypot(x - k[0], z - k[1]) < 2.6 + r) return false;
    }
    if (terrainHeight(x, z) < -0.5 || slopeAt(x, z) > 0.8) return false;
    for (const o of placed) if (Math.hypot(x - o.x, z - o.z) < o.r + r + spacing) return false;
    return true;
  };

  const base = (x, z, r = 0) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const h = terrainHeight(x + dx, z + dz);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    return { lo, hi };
  };

  let n = 0;
  const id = () => `c${n++}`;
  const r2 = (v) => Math.round(v * 100) / 100;

  const addCyl = (kind, x, z, r, h, extra = {}) => {
    const { lo, hi } = base(x, z, r);
    pieces.push({ id: id(), kind, s: 'cyl', x: r2(x), z: r2(z), r: r2(r), y0: r2(lo - 0.3), y1: r2(hi + h), ...extra });
    placed.push({ x, z, r });
  };
  const addBox = (kind, minX, maxX, minZ, maxZ, h, extra = {}) => {
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const rad = Math.hypot(maxX - minX, maxZ - minZ) / 2;
    const { lo, hi } = base(cx, cz, Math.max(maxX - minX, maxZ - minZ) / 2);
    pieces.push({ id: id(), kind, s: 'box', minX: r2(minX), maxX: r2(maxX), minZ: r2(minZ), maxZ: r2(maxZ), y0: r2(lo - 0.3), y1: r2(hi + h), ...extra });
    placed.push({ x: cx, z: cz, r: rad * 0.8 });
  };

  // ---- the shed (walls are cover: shoot a hole in it) ----
  {
    const s = WORLD.shed;
    const t = 0.3;
    const h = 2.4;
    const d = s.door;
    addBox('shedwall', s.minX, s.maxX, s.minZ, s.minZ + t, h, { rot: 0 }); // north
    addBox('shedwall', s.minX, s.maxX, s.maxZ - t, s.maxZ, h, { rot: 0 }); // south
    addBox('shedwall', s.minX, s.minX + t, s.minZ + t, s.maxZ - t, h, { rot: 1 }); // west
    addBox('shedwall', s.maxX - t, s.maxX, s.minZ + t, d.c - d.w / 2, h, { rot: 1 }); // east, either side of the door
    addBox('shedwall', s.maxX - t, s.maxX, d.c + d.w / 2, s.maxZ - t, h, { rot: 1 });
  }

  // ---- the hedge-lined right path ----
  {
    const seg = 5.5;
    for (const x of [35.3, 39.2]) {
      const end = x < 38 ? 4 : 12; // the west row stops short of the garage plot
      for (let z = -44; z < end; z += seg + 0.1) {
        const z1 = Math.min(z + seg, end);
        if (x < 38 && z1 > WORLD.shed.minZ - 1.5 && z < WORLD.shed.maxZ + 1.5) continue; // open at the shed
        addBox('hedge', x - 0.5, x + 0.5, z, z1, 1.7);
      }
    }
  }

  // ---- gravestones: lots, zombie side, in loose rows ----
  {
    const centers = [[-28, -42], [-12, -38], [16, -42], [30, -36], [-30, -24], [12, -24], [-8, -26], [28, -20]];
    let count = 0;
    for (const [cx, cz] of centers) {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          if (count >= 58) break;
          const x = cx + (col - 1) * 2.6 + (rnd() - 0.5) * 1.3;
          const z = cz + (row - 1) * 3.0 + (rnd() - 0.5) * 1.3;
          if (rnd() < 0.2 || !free(x, z, 0.45, { spacing: 0.9 })) continue;
          addCyl('gravestone', x, z, 0.45, 1.1 + rnd() * 0.3, { rot: r2((rnd() - 0.5) * 0.6), variant: Math.floor(rnd() * 3) });
          count++;
        }
      }
    }
  }

  // ---- rocks: tough ----
  for (let tries = 0, k = 0; k < 16 && tries < 400; tries++) {
    const x = B.minX + 4 + rnd() * (B.maxX - B.minX - 8);
    const z = B.minZ + 6 + rnd() * (B.maxZ - B.minZ - 12);
    const r = 0.7 + rnd() * 0.7;
    if (!free(x, z, r, { spacing: 2 })) continue;
    addCyl('rock', x, z, r, r * 1.5, { rot: r2(rnd() * 6.28), variant: Math.floor(rnd() * 3) });
    k++;
  }

  // ---- trees: around the edges and a few in the yard ----
  for (let tries = 0, k = 0; k < 26 && tries < 600; tries++) {
    const edge = k < 18;
    let x;
    let z;
    if (edge) {
      const side = Math.floor(rnd() * 3);
      if (side === 0) { x = B.minX + 1.8 + rnd() * 1.2; z = B.minZ + 4 + rnd() * (B.maxZ - B.minZ - 8); }
      else if (side === 1) { x = B.maxX - 1.8 - rnd() * 1.2; z = B.minZ + 4 + rnd() * (B.maxZ - B.minZ - 8); }
      else { x = B.minX + 6 + rnd() * (B.maxX - B.minX - 12); z = B.maxZ - 2 - rnd() * 1.5; }
    } else {
      x = B.minX + 6 + rnd() * (B.maxX - B.minX - 12);
      z = B.minZ + 10 + rnd() * (B.maxZ - B.minZ - 20);
    }
    if (!free(x, z, 0.5, { spacing: edge ? 4.5 : 8, edge: 1 })) continue;
    addCyl('tree', x, z, 0.5, 7, { rot: r2(rnd() * 6.28), variant: Math.floor(rnd() * 4) });
    k++;
  }

  // ---- trash cans ----
  for (const [x, z] of [[21.6, 7.4], [21.6, 22.8], [-15.4, 9.6], [-15.6, 20.2], [11.5, 6.8], [27, -5.5], [3.2, 31.6], [-9, 27], [-33, 4], [32, 12], [-12, 29], [26, 28], [-25, 44], [14, 40]]) {
    if (!free(x, z, 0.45, { clearPaths: false, spacing: 0.3, pad: 0 })) continue;
    addCyl('trashcan', x, z, 0.45, 1.0, { rot: 0 });
  }

  // ---- picnic table and kiddie pool in the back yard ----
  if (free(-10, 36, 1.4, { clearPaths: false, pad: 0 })) addBox('picnic', -11.2, -8.8, 35.2, 36.8, 0.8);
  if (free(-18, 40, 1.8, { clearPaths: false, pad: 0 })) addCyl('pool', -18, 40, 1.6, 0.35);

  return pieces;
}
