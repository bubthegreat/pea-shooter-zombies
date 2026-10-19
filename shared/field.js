// Collision field: boxes and cylinders in a 4 m spatial hash. Every collider has a vertical range y0..y1.
//   - resolve(): push a standing circle out of whatever blocks it. A collider blocks walking when its top is above the
//     feet + STEP; lower ones are walked (or jumped) onto.
//   - groundAt(): terrain height, or the top of a collider the feet can step onto.
//   - segment(): first thing a projectile or line of sight runs into.
// Pure (no imports from the server or the client): the server builds one from the real map, the client builds one from the
// map in the welcome message so it can predict its own walking with the very same code (see walker.js).

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const MAX_SLOPE = 1.2; // steepest terrain face (rise / run) a walker climbs
export const STEP = 0.5; // highest ledge a walker steps up (a jump apex is 1 m, so ~1.5 m ledges are jumpable)
const CELL = 4;
function colliderBounds(c) {
  return c.s === 'box' ? [c.minX, c.maxX, c.minZ, c.maxZ] : [c.x - c.r, c.x + c.r, c.z - c.r, c.z + c.r];
}

export class Field {
  /** bounds = { minX, maxX, minZ, maxZ } of the yard; terrain(x, z) = ground height (the server's grid or the client's copy of it). */
  constructor(bounds, terrain) {
    const B = bounds;
    this.B = B;
    this.terrain = terrain;
    this.nx = Math.ceil((B.maxX - B.minX) / CELL) + 1;
    this.nz = Math.ceil((B.maxZ - B.minZ) / CELL) + 1;
    this.cells = Array.from({ length: this.nx * this.nz }, () => []);
    this.stamp = 0;
    this.all = new Set();
  }

  _range(minX, maxX, minZ, maxZ) {
    const B = this.B;
    return [
      clamp(Math.floor((minX - B.minX) / CELL), 0, this.nx - 1),
      clamp(Math.floor((maxX - B.minX) / CELL), 0, this.nx - 1),
      clamp(Math.floor((minZ - B.minZ) / CELL), 0, this.nz - 1),
      clamp(Math.floor((maxZ - B.minZ) / CELL), 0, this.nz - 1),
    ];
  }

  /** Add a collider (kept by reference; a copy is the caller's job when sharing). */
  add(c) {
    if (c.blocks === undefined) c.blocks = true;
    if (c.shots === undefined) c.shots = true;
    const [minX, maxX, minZ, maxZ] = colliderBounds(c);
    const [i0, i1, j0, j1] = this._range(minX, maxX, minZ, maxZ);
    c._cells = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        this.cells[k].push(c);
        c._cells.push(k);
      }
    }
    this.all.add(c);
    return c;
  }

  remove(c) {
    if (!c._cells) return;
    for (const k of c._cells) {
      const a = this.cells[k];
      const i = a.indexOf(c);
      if (i >= 0) a.splice(i, 1);
    }
    c._cells = null;
    this.all.delete(c);
  }

  /** Call fn(c) once for every collider whose cells touch the rectangle. */
  each(minX, maxX, minZ, maxZ, fn) {
    const [i0, i1, j0, j1] = this._range(minX, maxX, minZ, maxZ);
    const st = ++this.stamp;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = this.cells[j * this.nx + i];
        for (let n = 0; n < cell.length; n++) {
          const c = cell[n];
          if (c._seen === st) continue;
          c._seen = st;
          fn(c);
        }
      }
    }
  }

  /**
   * Push the circle at p (p.x, p.z) of `radius` out of colliders it overlaps. The actor's body spans feetY..headY;
   * `team` walks through colliders whose passTeam matches. Also keeps p inside the yard. Mutates p.
   */
  resolve(p, radius, feetY = 0, headY = feetY + 1.8, team = null) {
    const B = this.B;
    p.x = clamp(p.x, B.minX + radius, B.maxX - radius);
    p.z = clamp(p.z, B.minZ + radius, B.maxZ - radius);
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      this.each(p.x - radius, p.x + radius, p.z - radius, p.z + radius, (c) => {
        if (!c.blocks || (c.passTeam && c.passTeam === team)) return;
        if (c.y1 <= feetY + STEP || c.y0 >= headY) return;
        if (c.s === 'cyl') {
          const dx = p.x - c.x;
          const dz = p.z - c.z;
          const min = c.r + radius;
          const d2 = dx * dx + dz * dz;
          if (d2 >= min * min) return;
          const d = Math.sqrt(d2);
          if (d > 1e-6) {
            p.x = c.x + (dx / d) * min;
            p.z = c.z + (dz / d) * min;
          } else p.x = c.x + min;
          moved = true;
          return;
        }
        const cx = clamp(p.x, c.minX, c.maxX);
        const cz = clamp(p.z, c.minZ, c.maxZ);
        const dx = p.x - cx;
        const dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) return;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          p.x = cx + (dx / d) * radius;
          p.z = cz + (dz / d) * radius;
        } else {
          // centre inside the box: leave through the nearest face
          const left = p.x - c.minX;
          const right = c.maxX - p.x;
          const near = p.z - c.minZ;
          const far = c.maxZ - p.z;
          const m = Math.min(left, right, near, far);
          if (m === left) p.x = c.minX - radius;
          else if (m === right) p.x = c.maxX + radius;
          else if (m === near) p.z = c.minZ - radius;
          else p.z = c.maxZ + radius;
        }
        moved = true;
      });
      p.x = clamp(p.x, B.minX + radius, B.maxX - radius);
      p.z = clamp(p.z, B.minZ + radius, B.maxZ - radius);
      if (!moved) break;
    }
    return p;
  }

  /** Height under (x, z) for feet at feetY: the terrain, or the top of a collider the feet can step onto. */
  groundAt(x, z, feetY) {
    let g = this.terrain(x, z);
    this.each(x, x, z, z, (c) => {
      if (c.y1 > feetY + STEP || c.y1 <= g) return;
      if (c.s === 'box') {
        if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) return;
      } else if ((x - c.x) ** 2 + (z - c.z) ** 2 > c.r * c.r) return;
      g = c.y1;
    });
    return g;
  }

  /**
   * First collider the segment (x0,y0,z0)->(x1,y1,z1) runs into, as { c, t } (t in 0..1), or null. `pad` fattens colliders
   * (projectile radius); `team` skips colliders that team shoots through. `skip(c)` can exclude more.
   */
  segment(x0, y0, z0, x1, y1, z1, pad = 0, team = null, skip = null) {
    let best = null;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    this.each(Math.min(x0, x1) - pad, Math.max(x0, x1) + pad, Math.min(z0, z1) - pad, Math.max(z0, z1) + pad, (c) => {
      if (!c.shots) return;
      if (team && c.shotPassTeam === team) return;
      if (skip && skip(c)) return;
      let t0 = 0;
      let t1 = best ? best.t : 1;
      if (c.s === 'box') {
        const lo = [c.minX - pad, c.y0 - pad, c.minZ - pad];
        const hi = [c.maxX + pad, c.y1 + pad, c.maxZ + pad];
        const o = [x0, y0, z0];
        const d = [dx, dy, dz];
        for (let a = 0; a < 3; a++) {
          if (Math.abs(d[a]) < 1e-9) {
            if (o[a] < lo[a] || o[a] > hi[a]) return;
          } else {
            let ta = (lo[a] - o[a]) / d[a];
            let tb = (hi[a] - o[a]) / d[a];
            if (ta > tb) [ta, tb] = [tb, ta];
            if (ta > t0) t0 = ta;
            if (tb < t1) t1 = tb;
            if (t0 > t1) return;
          }
        }
      } else {
        const fx = x0 - c.x;
        const fz = z0 - c.z;
        const R = c.r + pad;
        const a = dx * dx + dz * dz;
        if (a < 1e-12) {
          if (fx * fx + fz * fz > R * R) return;
        } else {
          const b = 2 * (fx * dx + fz * dz);
          const cc = fx * fx + fz * fz - R * R;
          const disc = b * b - 4 * a * cc;
          if (disc < 0) return;
          const sq = Math.sqrt(disc);
          const ta = (-b - sq) / (2 * a);
          const tb = (-b + sq) / (2 * a);
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) return;
        }
        // vertical range over [t0, t1]
        const ya = y0 + dy * t0;
        const yb = y0 + dy * t1;
        if (Math.min(ya, yb) > c.y1 + pad || Math.max(ya, yb) < c.y0 - pad) return;
      }
      if (best === null || t0 < best.t) best = { c, t: Math.max(0, t0) };
    });
    return best;
  }

  /** Could a walker go straight from (x0, z0) to (x1, z1)? Chest-height line over whatever ground is at each end. */
  walkLine(x0, z0, x1, z1, team = null) {
    const g0 = this.groundAt(x0, z0, this.terrain(x0, z0) + 1.0);
    const g1 = this.groundAt(x1, z1, this.terrain(x1, z1) + 1.0);
    return this.clearLine(x0, g0 + 0.6, z0, x1, g1 + 0.6, z1, team);
  }

  /** True if nothing blocks the straight line between two points (walls, cover, doors for `team`, and hills). */
  clearLine(x0, y0, z0, x1, y1, z1, team = null) {
    if (this.segment(x0, y0, z0, x1, y1, z1, 0, team)) return false;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.ceil(len / 1.5);
    for (let i = 1; i < n; i++) {
      const f = i / n;
      if (this.terrain(x0 + (x1 - x0) * f, z0 + (z1 - z0) * f) > y0 + (y1 - y0) * f + 0.15) return false;
    }
    return true;
  }
}
