// The static map as the client knows it (config.map from the welcome message) plus what changed since the round began
// (state: broken pieces, damage, builds). Pure data and maths, no DOM and no three.js, so it is unit tested against the
// server: the ground height is sampled with the same triangles the server stands on, and `placement()` mirrors the
// server's build rules (server/sim/build.js) for the ghost preview.

const STEP = 0.5;

function distSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * Where a flower pot may stand, from the map alone: null when fine, 'house' (not on the interior floor) or 'lane' (a walkway,
 * doorway, repair pile or the fridge front would be blocked). Mirrors server/sim/pots.js potProblem; `rules` = config.potRules.
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

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export class MapData {
  /**
   * cfg = welcome.config.map; builds = welcome.config.builds (the kinds); state = welcome.state (or null);
   * extra = { potRules, pots, doorHp } from the welcome config (pot placement rules, the pot cap, door maximum HP).
   */
  constructor(cfg, builds, state = null, extra = {}) {
    this.cfg = cfg;
    this.potRules = extra.potRules || null;
    this.potCfg = extra.pots || { max: 10, spacing: 2.2 };
    this.doorHp = extra.doorHp || {};
    this.doorOrder = (cfg.doors || []).map((d) => `door:${d.id}`);
    this.bounds = cfg.bounds;
    const t = cfg.terrain;
    this.t = t;
    const raw = typeof atob === 'function' ? atob(t.data) : Buffer.from(t.data, 'base64').toString('binary');
    this.h = new Float64Array(t.nx * t.nz);
    for (let i = 0; i < this.h.length; i++) {
      const lo = raw.charCodeAt(i * 2);
      const hi = raw.charCodeAt(i * 2 + 1);
      let v = lo | (hi << 8);
      if (v & 0x8000) v -= 0x10000;
      this.h[i] = v / 100;
    }
    this.statics = cfg.statics || [];
    this.builds = builds || { plant: [], zombie: [], maxPerPlayer: 12, reach: 14 };
    this.noBuild = cfg.noBuild || [];
    this.cover = new Map(); // id -> { def, hp, maxHp, alive }
    this.doors = new Map();
    this.placed = new Map(); // id -> build
    this.round = -1;
    this.coverMax = {};
    this.reset(state);
  }

  /** Give every piece full health again, then apply `state` (round start / welcome). */
  reset(state = null, hp = {}) {
    this.cover.clear();
    this.doors.clear();
    this.placed.clear();
    for (const c of this.cfg.cover || []) this.cover.set(c.id, { def: c, hp: hp[c.kind] ?? 1, maxHp: hp[c.kind] ?? 1, alive: true });
    for (const d of this.cfg.doorPieces || []) {
      const max = this.doorHp[d.id.slice(5)] ?? this.doorHp.default ?? 1;
      this.doors.set(d.id, { def: d, hp: max, maxHp: max, alive: true });
    }
    if (state) this.applyState(state);
  }

  applyState(state) {
    if (!state) return;
    this.round = state.round ?? this.round;
    for (const id of state.gone || []) this.setAlive(id, false);
    for (const [id, hp] of Object.entries(state.hurt || {})) {
      const p = this.piece(id);
      if (p) p.hp = hp;
    }
    for (const b of state.builds || []) this.addBuild(b);
  }

  piece(id) {
    return this.cover.get(id) || this.doors.get(id) || this.placed.get(id) || null;
  }

  setAlive(id, alive) {
    const p = this.piece(id);
    if (!p) return null;
    p.alive = alive;
    if (!alive) p.hp = 0;
    return p;
  }

  addBuild(b) {
    const def = [...this.builds.plant, ...this.builds.zombie].find((k) => k.id === b.kind);
    if (!def) return null;
    const rot = b.rot ? 1 : 0;
    const w = rot ? def.d : def.w;
    const d = rot ? def.w : def.d;
    const rec = { id: b.id, kind: b.kind, def, x: b.x, z: b.z, rot, w, d, hp: b.hp ?? def.hp, maxHp: b.maxHp ?? def.hp, by: b.by, alive: true };
    this.placed.set(b.id, rec);
    return rec;
  }

  /** Apply a server event (coverHit / coverBreak / build). Returns the affected piece. */
  onEvent(ev) {
    if (ev.type === 'coverHit') {
      const p = this.piece(ev.id);
      if (p) {
        p.hp = ev.hp;
        p.maxHp = ev.maxHp ?? p.maxHp;
      }
      return p;
    }
    if (ev.type === 'coverBreak') return this.setAlive(ev.id, false);
    if (ev.type === 'build') return this.addBuild(ev);
    if (ev.type === 'doorUp') {
      const p = this.doors.get(ev.id);
      if (p) {
        p.alive = true;
        p.hp = ev.hp;
        p.maxHp = ev.maxHp ?? p.maxHp;
      }
      return p || null;
    }
    return null;
  }

  /**
   * Door HP from a snapshot (`snap.doors`, in config.map.doors order, 0 = broken) and their full HP (`snap.doorMax`: the level can
   * toughen the doors). Returns true when any door's HP, maximum or state changed (the bars above the doors redraw only then).
   */
  setDoorHps(arr, max = null) {
    if (!Array.isArray(arr)) return false;
    let changed = false;
    for (let i = 0; i < this.doorOrder.length; i++) {
      const p = this.doors.get(this.doorOrder[i]);
      const hp = arr[i];
      if (!p || typeof hp !== 'number') continue;
      const alive = hp > 0;
      const m = max && typeof max[i] === 'number' && max[i] > 0 ? max[i] : p.maxHp;
      if (p.hp !== hp || p.alive !== alive || p.maxHp !== m) {
        p.hp = hp;
        p.alive = alive;
        p.maxHp = m;
        changed = true;
      }
    }
    return changed;
  }

  /** Id of the door nearest to (x, z) within maxD metres (centre of its opening), or null. No allocation. */
  nearestDoorId(x, z, maxD) {
    let best = null;
    let bd = maxD;
    for (const [id, p] of this.doors) {
      const d = Math.hypot((p.def.minX + p.def.maxX) / 2 - x, (p.def.minZ + p.def.maxZ) / 2 - z);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  }

  /** Flower pots standing (alive): [{ x, z (centre), rec }]. */
  potCentres(out = []) {
    out.length = 0;
    for (const b of this.placed.values()) if (b.alive && b.kind === 'pot') out.push({ x: b.x + 0.5, z: b.z + 0.5, rec: b });
    return out;
  }

  /** Terrain height (same triangles as the server). */
  groundHeight(x, z) {
    const t = this.t;
    const fx = Math.max(0, Math.min(t.nx - 1.000001, (x - t.x0) / t.cell));
    const fz = Math.max(0, Math.min(t.nz - 1.000001, (z - t.z0) / t.cell));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const k = j * t.nx + i;
    const ha = this.h[k];
    const hb = this.h[k + 1];
    const hc = this.h[k + t.nx];
    const hd = this.h[k + t.nx + 1];
    return u <= v ? ha + u * (hd - hc) + v * (hc - ha) : ha + v * (hd - hb) + u * (hb - ha);
  }

  /** Standing surface for an entity whose feet are at y: terrain, or a ledge / platform it is on. */
  supportY(x, z, y) {
    let g = this.groundHeight(x, z);
    for (const c of this.statics) {
      if (c.s !== 'box' || c.y1 > y + STEP + 0.05 || c.y1 <= g) continue;
      if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ) g = c.y1;
    }
    return g;
  }

  /** Where a ray from (ox, oy, oz) along unit dir first meets the terrain within maxDist: { x, y, z, t } or null. */
  rayGround(ox, oy, oz, dx, dy, dz, maxDist = 30) {
    let prev = 0;
    for (let t = 0.5; t <= maxDist; t += 0.5) {
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      if (y <= this.groundHeight(x, z)) {
        // refine between prev and t
        let lo = prev;
        let hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (oy + dy * mid <= this.groundHeight(ox + dx * mid, oz + dz * mid)) hi = mid;
          else lo = mid;
        }
        const tt = (lo + hi) / 2;
        const px = ox + dx * tt;
        const pz = oz + dz * tt;
        return { x: px, y: this.groundHeight(px, pz), z: pz, t: tt };
      }
      prev = t;
    }
    return null;
  }

  /** Footprint of a build def for rotation rot. */
  static footprint(def, rot) {
    return rot ? { w: def.d, d: def.w } : { w: def.w, d: def.d };
  }

  /** Grid cell (min corner) that centres a footprint on (x, z). */
  cellFor(def, rot, x, z) {
    const f = MapData.footprint(def, rot);
    return { gx: Math.round(x - f.w / 2), gz: Math.round(z - f.d / 2) };
  }

  /**
   * Can this build go at grid cell (gx, gz)? Mirrors server checkBuild without the cost / cap:
   * { ok, reason: 'spot' | 'far' | 'blocked' | 'busy', rect }. `me` = { x, z } the builder, `others` = [{ x, z, radius }] fighters + turrets.
   */
  placement(def, gx, gz, rot, me, others = []) {
    if (def.pot) return this.potPlacement(def, gx, gz, me, others);
    const f = MapData.footprint(def, rot ? 1 : 0);
    const rect = { minX: gx, maxX: gx + f.w, minZ: gz, maxZ: gz + f.d };
    const B = this.bounds;
    const bad = (reason) => ({ ok: false, reason, rect });
    if (rect.minX < B.minX + 1 || rect.maxX > B.maxX - 1 || rect.minZ < B.minZ + 1 || rect.maxZ > B.maxZ - 1) return bad('spot');
    const cx = (rect.minX + rect.maxX) / 2;
    const cz = (rect.minZ + rect.maxZ) / 2;
    if (me && Math.hypot(me.x - cx, me.z - cz) > this.builds.reach) return bad('far');
    for (const z of this.noBuild) if (rect.minX < z.maxX && rect.maxX > z.minX && rect.minZ < z.maxZ && rect.maxZ > z.minZ) return bad('blocked');
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, z] of [[rect.minX, rect.minZ], [rect.maxX, rect.minZ], [rect.minX, rect.maxZ], [rect.maxX, rect.maxZ], [cx, cz]]) {
      const h = this.groundHeight(x, z);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    if (lo < -0.45 || hi - lo > 0.9) return bad('spot');
    const hits = (c) => {
      if (c.y1 <= lo + 0.3) return false;
      if (c.s === 'box') return c.minX < rect.maxX && c.maxX > rect.minX && c.minZ < rect.maxZ && c.maxZ > rect.minZ;
      const dx = Math.max(rect.minX - c.x, 0, c.x - rect.maxX);
      const dz = Math.max(rect.minZ - c.z, 0, c.z - rect.maxZ);
      return dx * dx + dz * dz < c.r * c.r;
    };
    for (const c of this.statics) if (c.blocks !== false && hits(c)) return bad('blocked');
    for (const p of this.cover.values()) if (p.alive && hits(p.def)) return bad('blocked');
    for (const p of this.doors.values()) if (p.alive && hits(p.def)) return bad('blocked');
    for (const b of this.placed.values()) {
      if (b.alive && b.x < rect.maxX && b.x + b.w > rect.minX && b.z < rect.maxZ && b.z + b.d > rect.minZ) return bad('blocked');
    }
    for (const o of others) {
      const dx = Math.max(rect.minX - o.x, 0, o.x - rect.maxX);
      const dz = Math.max(rect.minZ - o.z, 0, o.z - rect.maxZ);
      const r = num(o.radius, 0.5) + 0.1;
      if (dx * dx + dz * dz < r * r) return bad('busy');
    }
    return { ok: true, rect, lo, hi };
  }

  /** Placement of a flower pot (see server/sim/build.js): { ok, reason: 'spot'|'far'|'house'|'lane'|'crowd'|'blocked'|'busy', rect }. */
  potPlacement(def, gx, gz, me, others = []) {
    const rect = { minX: gx, maxX: gx + 1, minZ: gz, maxZ: gz + 1 };
    const bad = (reason) => ({ ok: false, reason, rect });
    const B = this.bounds;
    if (rect.minX < B.minX + 1 || rect.maxX > B.maxX - 1 || rect.minZ < B.minZ + 1 || rect.maxZ > B.maxZ - 1) return bad('spot');
    const cx = gx + 0.5;
    const cz = gz + 0.5;
    if (me && Math.hypot(me.x - cx, me.z - cz) > this.builds.reach) return bad('far');
    const rules = this.potRules;
    if (!rules) return bad('house');
    const why = potProblem(rules, gx, gz);
    if (why) return bad(why);
    const h = rules.house;
    if (me && !(me.x >= h.minX - 0.5 && me.x <= h.maxX + 0.5 && me.z >= h.minZ - 0.5 && me.z <= h.maxZ + 0.5)) return bad('house');
    for (const b of this.placed.values()) if (b.alive && b.kind === 'pot' && Math.hypot(b.x + 0.5 - cx, b.z + 0.5 - cz) < rules.spacing) return bad('crowd');
    const slab = this.cfg.cellar && this.cfg.cellar.slab;
    const lo = slab && cx >= slab.minX && cx <= slab.maxX && cz >= slab.minZ && cz <= slab.maxZ ? 0 : this.groundHeight(cx, cz);
    const hits = (c) => {
      if (c.y1 <= lo + 0.3 || c.y0 >= lo + def.h) return false;
      if (c.s === 'box') return c.minX < rect.maxX && c.maxX > rect.minX && c.minZ < rect.maxZ && c.maxZ > rect.minZ;
      const dx = Math.max(rect.minX - c.x, 0, c.x - rect.maxX);
      const dz = Math.max(rect.minZ - c.z, 0, c.z - rect.maxZ);
      return dx * dx + dz * dz < c.r * c.r;
    };
    for (const c of this.statics) if (c.blocks !== false && hits(c)) return bad('blocked');
    for (const p of this.cover.values()) if (p.alive && hits(p.def)) return bad('blocked');
    for (const p of this.doors.values()) if (p.alive && hits(p.def)) return bad('blocked');
    for (const b of this.placed.values()) {
      if (b.alive && b.x < rect.maxX && b.x + b.w > rect.minX && b.z < rect.maxZ && b.z + b.d > rect.minZ) return bad('blocked');
    }
    for (const o of others) {
      const dx = Math.max(rect.minX - o.x, 0, o.x - rect.maxX);
      const dz = Math.max(rect.minZ - o.z, 0, o.z - rect.maxZ);
      const r = num(o.radius, 0.5) + 0.1;
      if (dx * dx + dz * dz < r * r) return bad('busy');
    }
    return { ok: true, rect, lo, hi: lo };
  }

  /** The build kinds for a team ('zombie' or anything else = plant). */
  listFor(team) {
    return team === 'zombie' ? this.builds.zombie : this.builds.plant;
  }
}
