// Small math helpers shared by the simulation. Y is up, units are meters.
// Orientation convention (matches three.js camera YXZ euler): yaw 0 faces -z,
// positive yaw turns left (counter-clockwise from above); positive pitch looks up.

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function wrapAngle(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}

export function round(v, places = 2) {
  const m = 10 ** places;
  return Math.round(v * m) / m;
}

export function dist2D(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

/** Yaw that faces from the origin toward the horizontal offset (dx, dz). */
export function yawTo(dx, dz) {
  return Math.atan2(-dx, -dz);
}

/** Unit look direction for yaw/pitch. */
export function forwardVec(yaw, pitch = 0) {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

/** Horizontal unit vector pointing to the right of a yaw. */
export function rightVec(yaw) {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

/** Distance from point P to segment AB (3D). */
export function distPointSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > 1e-12) {
    t = clamp(((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2, 0, 1);
  }
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t), pz - (az + abz * t));
}
