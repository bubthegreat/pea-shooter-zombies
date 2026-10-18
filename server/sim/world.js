// Static world layout. Y up, meters. Yard x in [-30, 30], z in [-50, 30];
// the house and garage sit beyond z = 30 (toward +z).
import { clamp } from './vec.js';

export const WORLD = {
  bounds: { minX: -30, maxX: 30, minZ: -50, maxZ: 30 },
  // Outer clamp box. Anything beyond the yard is filled with solids except the garage interior.
  extent: { minX: -30, maxX: 30, minZ: -50, maxZ: 50 },
  gate: { z: -48, minX: -20, maxX: 20 },
  garden: {
    columns: 9,
    startX: -16,
    stepX: 4,
    rows: [
      { z: 0, kind: 'peashooter' },
      { z: 4, kind: 'cactus' },
      { z: 8, kind: 'cactus' },
      { z: 12, kind: 'peashooter' },
    ],
  },
  house: { minX: -25, maxX: 10, minZ: 30, maxZ: 45, height: 8 },
  garage: { minX: 12, maxX: 28, minZ: 30, maxZ: 45, height: 4, doorMinX: 14, doorMaxX: 26 },
  mowerHome: { x: 20, y: 0, z: 34 },
  plantSpawn: { x: -5, y: 0, z: 26 },
  // Invisible collision fill: the house plus the gaps beside the garage, leaving only the
  // garage interior (x 14..26, z 30..43) walkable beyond the yard edge.
  solids: [
    { minX: -30, maxX: 14, minZ: 30, maxZ: 50, height: 8 },
    { minX: 26, maxX: 30, minZ: 30, maxZ: 50, height: 8 },
    { minX: 14, maxX: 26, minZ: 43, maxZ: 50, height: 8 },
  ],
};

export const PLAYER_RADIUS = 0.5;

/** All garden slots, row-major (front row first): [{x, z, kind}]. */
export function gardenSlots() {
  const { columns, startX, stepX, rows } = WORLD.garden;
  const slots = [];
  for (const row of rows) {
    for (let c = 0; c < columns; c++) {
      slots.push({ x: startX + c * stepX, z: row.z, kind: row.kind });
    }
  }
  return slots;
}

/** Push a point (circle of `radius`) out of the world boundary and solids. Mutates and returns pos. */
export function clampToWorld(pos, radius = PLAYER_RADIUS) {
  const ex = WORLD.extent;
  pos.x = clamp(pos.x, ex.minX + radius, ex.maxX - radius);
  pos.z = clamp(pos.z, ex.minZ + radius, ex.maxZ - radius);
  for (const s of WORLD.solids) {
    const cx = clamp(pos.x, s.minX, s.maxX);
    const cz = clamp(pos.z, s.minZ, s.maxZ);
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= radius * radius) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      pos.x = cx + (dx / d) * radius;
      pos.z = cz + (dz / d) * radius;
    } else {
      // Center is inside the box: exit through the nearest face.
      const left = pos.x - s.minX;
      const right = s.maxX - pos.x;
      const near = pos.z - s.minZ;
      const far = s.maxZ - pos.z;
      const m = Math.min(left, right, near, far);
      if (m === left) pos.x = s.minX - radius;
      else if (m === right) pos.x = s.maxX + radius;
      else if (m === near) pos.z = s.minZ - radius;
      else pos.z = s.maxZ + radius;
    }
  }
  pos.x = clamp(pos.x, ex.minX + radius, ex.maxX - radius);
  pos.z = clamp(pos.z, ex.minZ + radius, ex.maxZ - radius);
  return pos;
}

/** True if a point (x, y, z) is inside a collision solid (used for projectiles). */
export function insideSolid(x, y, z) {
  for (const s of WORLD.solids) {
    if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ && y <= s.height) return true;
  }
  return false;
}
