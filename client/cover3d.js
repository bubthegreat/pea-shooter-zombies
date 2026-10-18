// Destructible cover and player builds, drawn with a handful of InstancedMeshes (one per kind) so a hundred pieces cost
// about a dozen draw calls. Pieces that break are hidden (scale 0) and the caller throws debris; damage darkens a piece and
// tilts it a little. Builds are added and removed as the server's events arrive and pop up with a short build-up animation.
import * as THREE from 'three';
import { gradientMap, mulberry } from './models.js';

const PI = Math.PI;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Merge [{ geo, color, m }] into one non-indexed geometry with vertex colours. */
function mergeParts(parts) {
  const pos = [], nor = [], col = [];
  const c = new THREE.Color();
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    g.applyMatrix4(p.m);
    const n = g.attributes.position.count;
    c.set(p.color);
    for (let i = 0; i < n; i++) {
      pos.push(g.attributes.position.getX(i), g.attributes.position.getY(i), g.attributes.position.getZ(i));
      nor.push(g.attributes.normal.getX(i), g.attributes.normal.getY(i), g.attributes.normal.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

const M = (x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  return m;
};
const box = new THREE.BoxGeometry(1, 1, 1);
const cyl = (seg = 8) => new THREE.CylinderGeometry(1, 1, 1, seg);
const ico = (jit, seed) => {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const r = mulberry(seed);
  const p = g.attributes.position;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(k)) seen.set(k, 1 + (r() - 0.5) * jit);
    const f = seen.get(k);
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f);
  }
  g.computeVertexNormals();
  return g;
};

/** Unit-sized geometries: footprint radius 1 / box 1 x 1 x 1, base at y = 0, height 1 (trees: 1 = one metre, r 0.5). */
function makeGeos() {
  const g = {};
  // gravestones in three styles: arch, cross, stepped slab (x half-width 1 = the 0.45 m piece radius, height 1 = 1.2 m)
  const stone = 0xb9c1c9, dark = 0x8f99a2, moss = 0x7aa85a;
  g.gravestone0 = mergeParts([
    { geo: box, color: dark, m: M(0, 0.06, 0, 2.2, 0.12, 1.1) },
    { geo: box, color: stone, m: M(0, 0.42, 0, 1.8, 0.62, 0.9) },
    { geo: cyl(10), color: stone, m: M(0, 0.73, 0, 0.9, 0.9, 0.45, PI / 2, 0, 0) },
    { geo: box, color: moss, m: M(0.55, 0.14, 0.46, 0.7, 0.14, 0.12) },
  ]);
  g.gravestone1 = mergeParts([
    { geo: box, color: dark, m: M(0, 0.06, 0, 2.2, 0.12, 1.1) },
    { geo: box, color: stone, m: M(0, 0.5, 0, 0.7, 0.95, 0.6) },
    { geo: box, color: stone, m: M(0, 0.72, 0, 1.7, 0.4, 0.6) },
    { geo: box, color: moss, m: M(-0.5, 0.14, 0.4, 0.8, 0.14, 0.12) },
  ]);
  g.gravestone2 = mergeParts([
    { geo: box, color: dark, m: M(0, 0.05, 0, 2.2, 0.1, 1.1) },
    { geo: box, color: stone, m: M(0, 0.3, 0, 1.9, 0.4, 0.95) },
    { geo: box, color: stone, m: M(0, 0.66, 0, 1.4, 0.45, 0.8) },
    { geo: box, color: 0xcfd8dc, m: M(0, 0.92, 0, 0.9, 0.2, 0.7) },
  ]);
  g.rock = (() => {
    const geo = ico(0.55, 7);
    geo.applyMatrix4(M(0, 0.55, 0, 1, 0.55, 1));
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color(0x9aa5ae);
    const r = mulberry(3);
    for (let i = 0; i < n; i += 3) {
      const k = 0.85 + r() * 0.25;
      for (let j = 0; j < 3; j++) { col[(i + j) * 3] = c.r * k; col[(i + j) * 3 + 1] = c.g * k; col[(i + j) * 3 + 2] = c.b * k; }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  })();
  g.tree = mergeParts([
    { geo: cyl(7), color: 0x8d5a2b, m: M(0, 2.0, 0, 0.5, 4.0, 0.5) },
    { geo: ico(0.35, 11), color: 0x4caf50, m: M(0, 5.3, 0, 2.6, 2.3, 2.6) },
    { geo: ico(0.35, 12), color: 0x66bb6a, m: M(1.3, 4.5, 0.5, 1.8, 1.6, 1.8) },
    { geo: ico(0.35, 13), color: 0x3d9e48, m: M(-1.2, 4.8, -0.4, 1.7, 1.5, 1.7) },
    { geo: ico(0.35, 14), color: 0x7ac74f, m: M(0.2, 6.6, -0.2, 1.5, 1.3, 1.5) },
  ]);
  g.hedge = (() => {
    const geo = new THREE.BoxGeometry(1, 1, 1, 6, 3, 1).toNonIndexed();
    const p = geo.attributes.position;
    const r = mulberry(5);
    const seen = new Map();
    for (let i = 0; i < p.count; i++) {
      const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      if (!seen.has(k)) seen.set(k, (r() - 0.5) * 0.12);
      const f = seen.get(k);
      const y = p.getY(i);
      p.setXYZ(i, p.getX(i) * (1 + f), y + (y > 0.2 ? f * 0.8 : 0), p.getZ(i) * (1 + f * 0.5));
    }
    geo.translate(0, 0.5, 0);
    geo.computeVertexNormals();
    const n = p.count;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color(0x3a9a48);
    const c2 = new THREE.Color(0x56b85f);
    for (let i = 0; i < n; i++) {
      const t = clamp(p.getY(i), 0, 1);
      const cc = c.clone().lerp(c2, t);
      col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  })();
  g.trashcan = mergeParts([
    { geo: cyl(10), color: 0x78909c, m: M(0, 0.45, 0, 0.92, 0.9, 0.92) },
    { geo: cyl(10), color: 0x546e7a, m: M(0, 0.92, 0, 1.0, 0.12, 1.0) },
    { geo: box, color: 0x37474f, m: M(0, 1.0, 0, 0.3, 0.1, 0.12) },
    { geo: box, color: 0x607d8b, m: M(0, 0.4, 0, 1.0, 0.07, 1.0) },
  ]);
  g.picnic = mergeParts([
    { geo: box, color: 0xc49a6c, m: M(0, 0.76, 0, 1, 0.08, 1) },
    { geo: box, color: 0xa87a4c, m: M(0, 0.4, -0.78, 1, 0.07, 0.22) },
    { geo: box, color: 0xa87a4c, m: M(0, 0.4, 0.78, 1, 0.07, 0.22) },
    { geo: box, color: 0x8d6240, m: M(-0.4, 0.38, 0, 0.1, 0.76, 1.3) },
    { geo: box, color: 0x8d6240, m: M(0.4, 0.38, 0, 0.1, 0.76, 1.3) },
    { geo: box, color: 0xef5350, m: M(0, 0.82, 0, 0.9, 0.012, 0.35) },
  ]);
  g.pool = mergeParts([
    { geo: new THREE.TorusGeometry(1, 0.1, 6, 18).rotateX(PI / 2), color: 0xff8a65, m: M(0, 0.28, 0) },
    { geo: new THREE.CylinderGeometry(0.98, 0.98, 0.3, 18), color: 0x4fc3f7, m: M(0, 0.15, 0) },
    { geo: new THREE.CylinderGeometry(0.98, 0.98, 0.02, 18), color: 0xb3e5fc, m: M(0, 0.26, 0) },
  ]);
  g.shedwall = (() => {
    const geo = mergeParts([{ geo: box, color: 0xb98a5a, m: M(0, 0.5, 0, 1, 1, 1) }]);
    return geo;
  })();
  // builds
  g.hedgewall = g.hedge;
  g.fence = mergeParts([
    { geo: box, color: 0xd9b27c, m: M(0, 0.7, 0, 1, 0.14, 0.4) },
    { geo: box, color: 0xd9b27c, m: M(0, 1.15, 0, 1, 0.14, 0.4) },
    ...[-0.46, -0.23, 0, 0.23, 0.46].map((x) => ({ geo: box, color: 0xe6c592, m: M(x, 0.65, 0, 0.1, 1.3, 0.34) })),
    ...[-0.5, 0.5].map((x) => ({ geo: box, color: 0xb98a5a, m: M(x, 0.75, 0, 0.1, 1.5, 0.5) })),
  ]);
  g.tombwall = mergeParts([
    { geo: box, color: 0x9aa5ae, m: M(0, 0.4, 0, 1, 0.8, 1) },
    { geo: box, color: 0xb6c0c8, m: M(0, 1.0, 0, 0.94, 0.4, 0.94) },
    ...[-0.34, 0, 0.34].map((x, i) => ({ geo: box, color: i % 2 ? 0x7e8a93 : 0x8d99a2, m: M(x, 0.4, -0.5, 0.3, 0.7, 0.04) })),
    { geo: box, color: 0x7aa85a, m: M(0.25, 0.82, 0.5, 0.4, 0.1, 0.06) },
  ]);
  g.junk = (() => {
    const r = mulberry(9);
    const parts = [];
    const cols = [0xef5350, 0x42a5f5, 0xffca28, 0x8d6e63, 0x78909c, 0x66bb6a];
    for (let i = 0; i < 12; i++) parts.push({ geo: box, color: cols[i % 6], m: M((r() - 0.5) * 0.85, 0.2 + r() * 0.6, (r() - 0.5) * 0.7, 0.2 + r() * 0.3, 0.2 + r() * 0.35, 0.2 + r() * 0.3, r() - 0.5, r() * PI, r() - 0.5) });
    parts.push({ geo: box, color: 0x5d4037, m: M(0, 0.12, 0, 1, 0.24, 1) });
    return mergeParts(parts);
  })();
  g.cantower = mergeParts([0, 1, 2].flatMap((i) => [
    { geo: cyl(10), color: i % 2 ? 0x607d8b : 0x78909c, m: M(i % 2 ? 0.06 : -0.05, 0.4 + i * 0.85, 0, 0.9, 0.78, 0.9) },
    { geo: cyl(10), color: 0x455a64, m: M(i % 2 ? 0.06 : -0.05, 0.82 + i * 0.85, 0, 0.95, 0.07, 0.95) },
  ]));
  return g;
}

// kind -> { geo, kind of footprint: 'cyl' (radius) | 'box' }, nominal footprint radius / height of the unit geometry
const COVER_DRAW = {
  gravestone: { geoR: 1, geoH: 1.2, scaleR: 0.45 },
  rock: { geoR: 1, geoH: 1 },
  tree: { geoR: 0.5, geoH: 1, fixedH: true },
  hedge: { box: true, geoH: 1 },
  trashcan: { geoR: 0.45, geoH: 1 },
  picnic: { box: true, geoH: 0.9 },
  pool: { geoR: 1, geoH: 0.3, fixedH: true },
  shedwall: { box: true, geoH: 1 },
};
const BUILD_DRAW = {
  hedgewall: { color: 0xffffff }, fence: { color: 0xffffff }, tombwall: { color: 0xffffff }, junk: { color: 0xffffff }, cantower: { color: 0xffffff },
};

const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

export class CoverLayer {
  /** level: Level (its .group gets the meshes); map: MapData; cfg: welcome.config (builds, cover hp). */
  constructor(level, map) {
    this.level = level;
    this.map = map;
    this.group = new THREE.Group();
    level.group.add(this.group);
    this.geos = makeGeos();
    this.mat = new THREE.MeshToonMaterial({ gradientMap, vertexColors: true });
    this.kinds = new Map(); // draw key -> { mesh, slots: [piece records], free }
    this.pieces = new Map(); // id -> { key, i, base: Matrix4 parts, color }
    this.anim = []; // builds popping up
    this._d = new THREE.Object3D();
    this._build();
  }

  _mesh(key, geo, count, cast = true) {
    const m = new THREE.InstancedMesh(geo, this.mat, Math.max(1, count));
    m.castShadow = cast;
    m.receiveShadow = true;
    m.count = 0;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    this.group.add(m);
    const rec = { mesh: m, n: 0, cap: Math.max(1, count), free: [] };
    this.kinds.set(key, rec);
    return rec;
  }

  /** Create instance matrices for every cover piece in the map. */
  _build() {
    const cover = this.map.cfg.cover || [];
    const count = {};
    for (const c of cover) {
      const key = c.kind === 'gravestone' ? `gravestone${c.variant ?? 0}` : c.kind;
      count[key] = (count[key] || 0) + 1;
    }
    for (const [key, n] of Object.entries(count)) this._mesh(key, this.geos[key], n, key !== 'pool');
    const d = this._d;
    for (const c of cover) {
      const key = c.kind === 'gravestone' ? `gravestone${c.variant ?? 0}` : c.kind;
      const rec = this.kinds.get(key);
      const draw = COVER_DRAW[c.kind];
      const base = c.y0 + 0.3;
      const h = Math.max(0.2, c.y1 - base);
      if (draw.box) {
        d.position.set((c.minX + c.maxX) / 2, base, (c.minZ + c.maxZ) / 2);
        d.rotation.set(0, 0, 0);
        d.scale.set(c.maxX - c.minX, draw.fixedH ? 1 : h / draw.geoH, c.maxZ - c.minZ);
        if (c.kind === 'picnic') d.scale.set((c.maxX - c.minX) / 2.2, 1, (c.maxZ - c.minZ) / 1.6).multiply(new THREE.Vector3(1, 1, 1));
      } else {
        const r = c.r;
        d.position.set(c.x, base, c.z);
        d.rotation.set(0, c.rot || 0, 0);
        const sxz = draw.scaleR ? r / draw.scaleR * (draw.geoR / 1) : r / draw.geoR;
        d.scale.set(sxz, draw.fixedH ? 1 : h / draw.geoH, sxz);
        if (c.kind === 'gravestone') d.scale.set(r, h / 1.2, r);
      }
      d.updateMatrix();
      const i = rec.n++;
      rec.mesh.count = rec.n;
      rec.mesh.setMatrixAt(i, d.matrix);
      const tint = new THREE.Color(0xffffff);
      if (c.kind === 'rock' || c.kind === 'tree') tint.setHSL(0, 0, 0.9 + ((i * 37) % 10) / 100);
      rec.mesh.setColorAt(i, tint);
      this.pieces.set(c.id, { key, i, matrix: d.matrix.clone(), tint, def: c, hpFrac: 1, alive: true });
    }
    for (const rec of this.kinds.values()) {
      rec.mesh.instanceMatrix.needsUpdate = true;
      if (rec.mesh.instanceColor) rec.mesh.instanceColor.needsUpdate = true;
    }
    // builds: one pool per kind
    const kinds = [...(this.map.builds.plant || []), ...(this.map.builds.zombie || [])];
    for (const k of kinds) this._mesh(`b:${k.id}`, this.geos[k.id], 48);
    this._ghost();
  }

  /* ---- state ---- */

  _write(piece) {
    const rec = this.kinds.get(piece.key);
    const d = this._d;
    d.matrix.copy(piece.matrix);
    if (!piece.alive) d.matrix.makeScale(0, 0, 0);
    else if (piece.hpFrac < 1) {
      // damaged: sink a little and lean
      const lean = (1 - piece.hpFrac) * 0.12 * (piece.i % 2 ? 1 : -1);
      d.matrix.multiply(new THREE.Matrix4().makeRotationZ(lean));
    }
    rec.mesh.setMatrixAt(piece.i, d.matrix);
    const c = piece.tint.clone().multiplyScalar(0.55 + 0.45 * piece.hpFrac);
    rec.mesh.setColorAt(piece.i, c);
    rec.mesh.instanceMatrix.needsUpdate = true;
    if (rec.mesh.instanceColor) rec.mesh.instanceColor.needsUpdate = true;
  }

  /** Back to a fresh round: every piece standing at full health, no builds. */
  reset() {
    for (const p of this.pieces.values()) {
      p.alive = true;
      p.hpFrac = 1;
      this._write(p);
    }
    for (const [key, rec] of this.kinds) {
      if (!key.startsWith('b:')) continue;
      rec.n = 0;
      rec.mesh.count = 0;
      rec.free.length = 0;
    }
    this.builtById = new Map();
    this.anim.length = 0;
    this.level.resetDoors();
  }

  /** Apply MapData state (after reset): broken pieces, damage, builds. */
  sync() {
    for (const [id, p] of this.pieces) {
      const mp = this.map.cover.get(id);
      if (!mp) continue;
      p.alive = mp.alive;
      p.hpFrac = mp.alive ? clamp(mp.hp / mp.maxHp, 0.05, 1) : 0;
      this._write(p);
    }
    for (const [id, d] of this.map.doors) {
      if (!d.alive) this.level.doorBreak(id);
      else if (d.hp < d.maxHp) this.level.doorHit(id, d.hp / d.maxHp);
    }
    for (const b of this.map.placed.values()) if (b.alive) this._addBuild(b, false);
  }

  _addBuild(b, animate = true) {
    const rec = this.kinds.get(`b:${b.kind}`);
    if (!rec) return;
    this.builtById ??= new Map();
    if (this.builtById.has(b.id)) return;
    let i;
    if (rec.free.length) i = rec.free.pop();
    else if (rec.n < rec.cap) i = rec.n++;
    else return;
    rec.mesh.count = rec.n;
    const def = b.def;
    const base = Math.min(...[[b.x, b.z], [b.x + b.w, b.z], [b.x, b.z + b.d], [b.x + b.w, b.z + b.d]].map(([x, z]) => this.map.groundHeight(x, z)));
    const sc = { x: b.w, y: def.h, z: b.d };
    const item = { id: b.id, rec, i, x: b.x + b.w / 2, y: base, z: b.z + b.d / 2, sc, t: animate ? 0 : 1, rot: b.rot };
    this.builtById.set(b.id, item);
    // fences and walls are modelled facing along x: rotate for the 90 degree variants (footprint stays w x d in the world)
    this._placeBuild(item, animate ? 0.01 : 1);
    if (animate) this.anim.push(item);
    rec.mesh.instanceMatrix.needsUpdate = true;
    if (rec.mesh.instanceColor) rec.mesh.instanceColor.needsUpdate = true;
  }

  _placeBuild(item, k) {
    const d = this._d;
    d.position.set(item.x, item.y, item.z);
    const long = Math.max(item.sc.x, item.sc.z);
    const isLong = item.sc.x !== item.sc.z;
    // unit geometry has its long side along x and its thin side along z; a rotated build is long along z
    d.rotation.set(0, item.sc.z > item.sc.x ? PI / 2 : 0, 0);
    if (isLong) d.scale.set(long, item.sc.y * k, Math.min(item.sc.x, item.sc.z));
    else d.scale.set(item.sc.x, item.sc.y * k, item.sc.z);
    d.updateMatrix();
    item.rec.mesh.setMatrixAt(item.i, d.matrix);
    item.rec.mesh.setColorAt(item.i, _white);
  }

  _removeBuild(id) {
    const item = this.builtById?.get(id);
    if (!item) return null;
    this.builtById.delete(id);
    item.rec.mesh.setMatrixAt(item.i, this._zero ??= new THREE.Matrix4().makeScale(0, 0, 0));
    item.rec.free.push(item.i);
    item.rec.mesh.instanceMatrix.needsUpdate = true;
    return item;
  }

  /**
   * A server event arrived (already applied to MapData). Returns { kind, x, y, z } for debris on a break, else null.
   */
  onEvent(ev) {
    if (ev.type === 'coverHit') {
      const p = this.pieces.get(ev.id);
      if (p) {
        p.hpFrac = clamp(ev.hp / Math.max(1, ev.maxHp), 0.05, 1);
        this._write(p);
      } else if (this.level.doorViews.has(ev.id)) this.level.doorHit(ev.id, clamp(ev.hp / Math.max(1, ev.maxHp), 0, 1));
      else {
        const b = this.builtById?.get(ev.id);
        if (b) b.hurt = 0.2;
      }
      return null;
    }
    if (ev.type === 'coverBreak') {
      const p = this.pieces.get(ev.id);
      if (p) {
        p.alive = false;
        this._write(p);
        return { kind: ev.kind, x: ev.x, y: ev.y + 0.6, z: ev.z };
      }
      if (this.level.doorViews.has(ev.id)) {
        const pos = this.level.doorBreak(ev.id);
        return pos ? { kind: 'door', x: pos.x, y: pos.y, z: pos.z } : null;
      }
      const item = this._removeBuild(ev.id);
      if (item) return { kind: ev.kind, x: item.x, y: item.y + 0.6, z: item.z };
      return null;
    }
    if (ev.type === 'build') {
      const b = this.map.placed.get(ev.id);
      if (b) this._addBuild(b, true);
      return null;
    }
    return null;
  }

  /* ---- ghost preview ---- */

  _ghost() {
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.4, depthWrite: false });
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), this.ghostMat);
    this.ghost.visible = false;
    this.ghost.renderOrder = 6;
    this.ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.ghostEdges.visible = false;
    this.ghostEdges.renderOrder = 7;
    this.group.add(this.ghost, this.ghostEdges);
  }

  /** Show / move the ghost: def = build kind, rect = footprint, ok = placement allowed; null hides it. */
  setGhost(def, rect, ok, y = 0) {
    if (!def || !rect) {
      this.ghost.visible = this.ghostEdges.visible = false;
      return;
    }
    this.ghost.visible = this.ghostEdges.visible = true;
    const w = rect.maxX - rect.minX, d = rect.maxZ - rect.minZ;
    for (const m of [this.ghost, this.ghostEdges]) {
      m.position.set((rect.minX + rect.maxX) / 2, y, (rect.minZ + rect.maxZ) / 2);
      m.scale.set(w, def.h, d);
    }
    this.ghostMat.color.set(ok ? 0x66ff88 : 0xff5a5a);
    this.ghostEdges.material.color.set(ok ? 0xd8ffe0 : 0xffb0b0);
  }

  update(dt) {
    if (this.anim.length) {
      for (let n = this.anim.length - 1; n >= 0; n--) {
        const it = this.anim[n];
        it.t = Math.min(1, it.t + dt / 0.45);
        this._placeBuild(it, Math.max(0.02, easeOutBack(it.t)));
        if (it.t >= 1) this.anim.splice(n, 1);
        it.rec.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }
}

const _white = new THREE.Color(0xffffff);
export { BUILD_DRAW };
