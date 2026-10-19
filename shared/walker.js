// One tick of a walker (player or bot): steer from the keys, get pushed out of walls / cover / doors / solid plants, climb
// ledges, fall and jump. Pure: the server runs it for every fighter each tick (server/sim/game.js), and the client runs the very
// same code to predict its own player (client/predict.js), so both agree on where walls are.
import { STEP, MAX_SLOPE } from './field.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Advance `e` by dt seconds. e: { x, y, z, yaw, vy, grounded, radius, height, team }; keys: { f, b, l, r, jump }.
 * env: { field, speed (m/s), jumpSpeed, gravity, pen (a rect the walker is held in, or null), blockers ([{ x, z, radius }]) }.
 * Mutates e (x, y, z, vy, grounded) and sets e.vx / e.vz to the actual ground velocity.
 */
export function walkerStep(e, keys, dt, env) {
  const { field } = env;
  const terrain = field.terrain;
  const ox = e.x;
  const oz = e.z;
  const ix = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
  const iz = (keys.f ? 1 : 0) - (keys.b ? 1 : 0);
  const len = Math.hypot(ix, iz);
  let nx = e.x;
  let nz = e.z;
  if (len > 0) {
    const s = Math.sin(e.yaw);
    const co = Math.cos(e.yaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    nx += ((co * ix - s * iz) / len) * env.speed * dt;
    nz += ((-s * ix - co * iz) / len) * env.speed * dt;
  }
  // Walls, cover and doors push the body out; a terrain face taller than a step cannot be walked up (try sliding).
  const feet = e.y;
  const h0 = terrain(e.x, e.z);
  const onTerrain0 = field.groundAt(e.x, e.z, feet) <= h0 + 1e-6;
  const place = (tx, tz) => {
    const p = { x: tx, z: tz };
    field.resolve(p, e.radius, feet, feet + e.height, e.team);
    const h1 = terrain(p.x, p.z);
    if (h1 > feet + STEP + 1e-6) return null; // a terrain wall
    // a terrain face too steep to walk up or down is a wall too (only between two spots on the terrain, not on a slab or step)
    const run = Math.hypot(p.x - e.x, p.z - e.z);
    if (Math.abs(h1 - h0) > MAX_SLOPE * run + 0.01 && onTerrain0 && field.groundAt(p.x, p.z, feet) <= h1 + 1e-6) return null;
    return p;
  };
  const p = place(nx, nz) ?? place(nx, e.z) ?? place(e.x, nz) ?? place(e.x, e.z);
  if (p) {
    e.x = p.x;
    e.z = p.z;
  }
  if (env.pen) {
    const pen = env.pen;
    e.x = clamp(e.x, pen.minX + e.radius, pen.maxX - e.radius);
    e.z = clamp(e.z, pen.minZ + e.radius, pen.maxZ - e.radius);
  }
  // Vertical: stand on the ground (terrain or a ledge within a step), otherwise fall; jump from the ground.
  const ground = field.groundAt(e.x, e.z, e.y);
  if (e.vy <= 0 && e.y <= ground + (e.grounded ? STEP : 1e-3)) {
    e.y = ground;
    e.vy = 0;
    e.grounded = true;
    if (keys.jump) {
      e.vy = env.jumpSpeed;
      e.grounded = false;
    }
  } else e.grounded = false; // walked off a ledge: fall
  if (!e.grounded) {
    e.vy -= env.gravity * dt;
    e.y += e.vy * dt;
    if (e.vy <= 0) {
      const g2 = field.groundAt(e.x, e.z, e.y);
      if (e.y <= g2) {
        e.y = g2;
        e.vy = 0;
        e.grounded = true;
      }
    }
  }
  const blockers = env.blockers;
  if (blockers) {
    for (let i = 0; i < blockers.length; i++) {
      // solid plants (wall-nuts): slide around them instead of walking through
      const b = blockers[i];
      const bx = e.x - b.x;
      const bz = e.z - b.z;
      const min = b.radius + e.radius;
      const d = Math.hypot(bx, bz);
      if (d >= min) continue;
      if (d < 1e-6) e.x = b.x + min;
      else {
        e.x = b.x + (bx / d) * min;
        e.z = b.z + (bz / d) * min;
      }
    }
  }
  e.vx = (e.x - ox) / dt; // actual ground velocity (turrets use it to aim)
  e.vz = (e.z - oz) / dt;
}
