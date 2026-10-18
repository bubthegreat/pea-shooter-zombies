// The backyard level, built from the server's static map (config.map): terrain mesh, gravel paths, garden plots, walls and
// furniture, the house with its roofs and windows, doors, the fridge, the fence and gate, deck, cellar, creek and bridge,
// scenery beyond the fence. Static geometry is merged by material (a few dozen draw calls in all); the doors, the fridge and
// the gate are the only animated parts. Cover and builds live in cover3d.js.
import * as THREE from 'three';
import { toon, basic, G, add, gradientMap, mulberry, bakeGroup } from './models.js';
import {
  grassTexture, dirtTexture, gravelTexture, pathTexture, plankTexture, stoneTexture, sidingTexture, shingleTexture, textSignTexture,
  emojiTexture, mergeStatic,
} from './textures.js';

const PI = Math.PI;
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ------------------------------------------------------------------ */
/* triangle soup batcher: boxes with world-space UVs and vertex colours  */
/* ------------------------------------------------------------------ */

export class Batch {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
  }

  /**
   * Axis-aligned box. `color` is a hex or (nx, ny, nz) => hex per face; `uvs` = texture tiles per metre.
   */
  box(x0, x1, y0, y1, z0, z1, color = 0xffffff, uvs = 0.25) {
    const faces = [
      [[1, 0, 0], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
      [[-1, 0, 0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
      [[0, 1, 0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]],
      [[0, -1, 0], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
      [[0, 0, 1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      [[0, 0, -1], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
    ];
    for (const [n, a, b, c, d] of faces) {
      const hex = typeof color === 'function' ? color(n[0], n[1], n[2]) : color;
      const cc = _c.set(hex);
      for (const v of [a, b, c, a, c, d]) {
        this.pos.push(v[0], v[1], v[2]);
        this.nor.push(n[0], n[1], n[2]);
        if (n[0] !== 0) this.uv.push(v[2] * uvs, v[1] * uvs);
        else if (n[2] !== 0) this.uv.push(v[0] * uvs, v[1] * uvs);
        else this.uv.push(v[0] * uvs, v[2] * uvs);
        this.col.push(cc.r, cc.g, cc.b);
      }
    }
  }

  get empty() { return this.pos.length === 0; }

  mesh(material, cast = true, receive = true) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false;
    return m;
  }
}
const _c = new THREE.Color();

function tex(map, extra = {}) {
  return new THREE.MeshToonMaterial({ map, gradientMap, vertexColors: true, ...extra });
}

/* ------------------------------------------------------------------ */

function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const h = (a, b) => { let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263); n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  const fx = smooth(0, 1, x - ix), fz = smooth(0, 1, z - iz);
  const a = h(ix, iz), b = h(ix + 1, iz), c = h(ix, iz + 1), d = h(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

function distSeg(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const l2 = abx * abx + abz * abz;
  const t = l2 > 0 ? clamp(((px - ax) * abx + (pz - az) * abz) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

const FURNITURE_COLORS = {
  couch: 0x7e57c2, coffeetable: 0xbcaaa4, bookshelf: 0x8d6e63, tvstand: 0x455a64, counter: 0xcfd8dc, island: 0xb0bec5, table: 0xc49a6c,
  cabinet: 0xa1887f, crate: 0xc59a62, shelf: 0x78909c, pot: 0xb5651d, rack: 0x6d4c41, fridge: 0xe0f2f1,
};

export class Level {
  /**
   * map: MapData (client/map.js); world: the World (sky, lights, windowMats, lanterns). hp: { kind: maxHp } for cover.
   */
  constructor(map, world) {
    this.map = map;
    this.world = world;
    this.cfg = map.cfg;
    this.group = new THREE.Group();
    this.props = new THREE.Group(); // merged at the end
    this.doorViews = new Map(); // door piece id -> { group, panel, def, hp }
    this.gate = null;
    this.fridge = null;
    this.t = 0;
    this._terrain();
    this._paths();
    this._plots();
    this._statics();
    this._house();
    this._doors();
    this._piles();
    this._doorBars();
    this._fence();
    this._scenery();
    this._decorInstances();
    this.group.add(mergeStatic(this.props));
    this._fridge();
    this._water();
    this._lights();
  }

  get ground() { return (x, z) => this.map.groundHeight(x, z); }

  /* ---------------------------------------------------------------- terrain */

  _terrain() {
    const T = this.cfg.terrain;
    const { nx, nz } = T;
    const pos = new Float32Array(nx * nz * 3);
    const uv = new Float32Array(nx * nz * 2);
    const col = new Float32Array(nx * nz * 3);
    const c1 = new THREE.Color(0x7cc957), c2 = new THREE.Color(0x58a83e), mud = new THREE.Color(0x9a8c64), conc = new THREE.Color(0x9aa4ab), rock = new THREE.Color(0x8a9a78);
    const tmp = new THREE.Color();
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const x = T.x0 + i * T.cell, z = T.z0 + j * T.cell;
        const h = this.map.h[k];
        pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
        uv[k * 2] = x / 7; uv[k * 2 + 1] = z / 7;
        const n = vnoise(x * 0.22, z * 0.22) * 0.7 + vnoise(x * 0.9 + 9, z * 0.9) * 0.3;
        tmp.copy(c1).lerp(c2, n);
        // steeper ground shows a little rock, ditches show mud, the basement is concrete
        const hx = this.map.h[k + (i < nx - 1 ? 1 : 0)], hz = this.map.h[k + (j < nz - 1 ? nx : 0)];
        const slope = Math.max(Math.abs(hx - h), Math.abs(hz - h));
        tmp.lerp(rock, clamp((slope - 0.35) * 1.4, 0, 0.6));
        tmp.lerp(mud, smooth(-0.15, -0.8, h));
        if (h < -1.5) tmp.lerp(conc, 0.85);
        col[k * 3] = tmp.r; col[k * 3 + 1] = tmp.g; col[k * 3 + 2] = tmp.b;
      }
    }
    const idx = [];
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx.push(a, c, d, a, d, b); // the same diagonal the server samples
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.terrainGeo = g;
    const mat = new THREE.MeshToonMaterial({ map: grassTexture(1, 1, false, 0), gradientMap, vertexColors: true });
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);

    // wide meadow outside the fence: four big quads around the yard (the terrain is flat at its edge)
    const outer = grassTexture(60, 60, false, 1);
    const om = new THREE.MeshToonMaterial({ map: outer, gradientMap, color: 0xcfe8c0 });
    const B = this.cfg.bounds, R = 450;
    for (const [x0, x1, z0, z1] of [[-R, R, -R, B.minZ], [-R, R, B.maxZ, R], [-R, B.minX, B.minZ, B.maxZ], [B.maxX, R, B.minZ, B.maxZ]]) {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-PI / 2), om);
      q.position.set((x0 + x1) / 2, -0.01, (z0 + z1) / 2);
      q.receiveShadow = true;
      this.group.add(q);
    }
  }

  /* ---------------------------------------------------------------- paths */

  _ribbon(pts, half, y, uvPer, material, step = 1) {
    // sample the polyline every `step` metres
    const samples = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k < n; k++) samples.push([lerp(ax, bx, k / n), lerp(az, bz, k / n)]);
    }
    samples.push(pts[pts.length - 1]);
    const pos = [], uv = [], idx = [];
    let run = 0;
    for (let i = 0; i < samples.length; i++) {
      const [x, z] = samples[i];
      const [px, pz] = samples[Math.max(0, i - 1)], [qx, qz] = samples[Math.min(samples.length - 1, i + 1)];
      let tx = qx - px, tz = qz - pz;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nxv = -tz, nzv = tx;
      if (i > 0) run += Math.hypot(x - samples[i - 1][0], z - samples[i - 1][1]);
      for (const s of [-1, 1]) {
        const vx = x + nxv * half * s, vz = z + nzv * half * s;
        pos.push(vx, Math.max(this.map.groundHeight(vx, vz), this.map.groundHeight(x, z) - 0.05) + y, vz);
        uv.push(s < 0 ? 0 : 1, run * uvPer);
      }
      if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.renderOrder = 1;
    this.group.add(m);
    return m;
  }

  _paths() {
    const gravel = new THREE.MeshToonMaterial({ map: gravelTexture(1, 1), gradientMap, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const stone = new THREE.MeshToonMaterial({ map: pathTexture(1, 1), gradientMap, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const p of this.cfg.gravel) this._ribbon(p.pts, p.half, 0.05, p.id === 'front' ? 0.3 : 0.22, p.id === 'front' ? stone : gravel);
    // a gravel apron in front of the garage door and the side door (where the plots end)
    const g = this.cfg.garage;
    this._ribbon([[g.maxX + 1, 15], [g.maxX + 3, 15]], 2.6, 0.05, 0.2, gravel);
  }

  /* ---------------------------------------------------------------- plots */

  _plots() {
    const P = this.props;
    const dirt = new THREE.MeshToonMaterial({ map: dirtTexture(4, 4), gradientMap });
    const wood = toon(0xc8955a);
    const mound = toon(0x7a4a33);
    for (const plot of this.cfg.plots) {
      const r = plot.rect;
      const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
      const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
      add(P, G.box, dirt, cx, 0.04, cz, { sx: w - 0.6, sy: 0.08, sz: d - 0.6 }).receiveShadow = true;
      for (const [sx, sz, px, pz] of [[w, 0.22, cx, r.minZ + 0.2], [w, 0.22, cx, r.maxZ - 0.2], [0.22, d, r.minX + 0.2, cz], [0.22, d, r.maxX - 0.2, cz]]) {
        const m = add(P, G.box, wood, px, 0.17, pz, { sx: sx, sy: 0.3, sz: sz });
        m.castShadow = true;
        m.receiveShadow = true;
      }
      // a little sunflower sign at one corner
      const signMat = new THREE.MeshToonMaterial({ map: emojiTexture('\u{1F33B}', '#fff3b0'), gradientMap });
      add(P, G.cyl, wood, r.minX + 0.5, 0.5, r.minZ + 0.5, { sx: 0.06, sy: 1.0, sz: 0.06 });
      add(P, G.box, signMat, r.minX + 0.5, 1.15, r.minZ + 0.5, { sx: 0.9, sy: 0.9, sz: 0.1 });
    }
    // seed mounds in every slot (instanced)
    const slots = this.map.slots || [];
    if (slots.length) {
      const im = new THREE.InstancedMesh(G.sphere, mound, slots.length);
      const d = new THREE.Object3D();
      slots.forEach((s, i) => {
        d.position.set(s.x, 0.09, s.z);
        d.scale.set(0.6, 0.06, 0.6);
        d.updateMatrix();
        im.setMatrixAt(i, d.matrix);
      });
      im.receiveShadow = true;
      this.group.add(im);
    }
  }

  /* ---------------------------------------------------------------- walls, furniture ---- */

  _statics() {
    const H = this.cfg.house;
    const garage = this.cfg.garage;
    const rooms = [this.cfg.rooms.living, this.cfg.rooms.kitchen, this.cfg.rooms.hall, this.cfg.rooms.garageRoom];
    const inside = (x, z) => rooms.some((r) => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ);
    const siding = sidingTexture('#ffe2a6', 1, 1);
    siding.repeat.set(1, 1);
    const sidingBlue = sidingTexture('#bfe6ff', 1, 1);
    const bHouse = new Batch(), bGarage = new Batch(), bWood = new Batch(), bPlain = new Batch(), bStone = new Batch();
    const cream = 0xfff1d0, wallH = H.height;
    for (const c of this.cfg.statics) {
      if (c.style === 'roof') continue;
      if (c.s === 'cyl') { this._cylStatic(c, bPlain); continue; }
      const y0 = c.y0, y1 = c.y1;
      if (c.style === 'wall') {
        if (y0 >= wallH - 0.01) continue; // lintels and roof-height bits: the roof covers them
        const top = Math.min(y1, wallH);
        const garageWall = c.minX >= garage.minX - 0.01 && c.maxX <= garage.maxX + 0.01 && !(c.maxX - c.minX < 0.5 && c.minX < garage.minX + 0.5 && c.maxZ - c.minZ > 3 && c.maxX <= garage.minX + 0.5);
        const b = garageWall ? bGarage : bHouse;
        const mx = (c.minX + c.maxX) / 2, mz = (c.minZ + c.maxZ) / 2;
        // faces toward a room are painted cream
        const color = (nx, ny, nz) => {
          if (ny !== 0) return 0xe9dfc8;
          const px = mx + nx * ((c.maxX - c.minX) / 2 + 0.3), pz = mz + nz * ((c.maxZ - c.minZ) / 2 + 0.3);
          return inside(px, pz) ? cream : 0xffffff;
        };
        b.box(c.minX, c.maxX, Math.max(y0, -0.3), top, c.minZ, c.maxZ, color, 0.28);
      } else if (c.style === 'inner') {
        bPlain.box(c.minX, c.maxX, 0, Math.min(y1, wallH), c.minZ, c.maxZ, (nx, ny) => (ny > 0 ? 0xe9dfc8 : 0xf6ecd4), 0.3);
        bPlain.box(c.minX - 0.01, c.maxX + 0.01, 0, 0.18, c.minZ - 0.01, c.maxZ + 0.01, 0xd7c9a8); // baseboard
      } else if (c.style === 'deck' || c.style === 'step' || c.style === 'bridge') {
        bWood.box(c.minX, c.maxX, Math.max(y0, -0.4), y1, c.minZ, c.maxZ, c.style === 'bridge' ? 0xd0a070 : 0xffffff, 0.35);
      } else if (c.style === 'rail') {
        bPlain.box(c.minX, c.maxX, y0, y1, c.minZ, c.maxZ, 0x6d4c41);
      } else if (c.style === 'terrace') {
        bStone.box(c.minX, c.maxX, Math.max(y0, -0.6), y1, c.minZ, c.maxZ, (nx, ny) => (ny > 0 ? 0x86c55a : 0xffffff), 0.3);
      } else if (c.style === 'concrete') {
        bPlain.box(c.minX, c.maxX, Math.max(y0, -2.7), y1, c.minZ, c.maxZ, 0xb7bec4);
      } else if (c.style === 'slab') {
        // the living-room floor above the basement
        bPlain.box(c.minX, c.maxX, -0.05, 0.005, c.minZ, c.maxZ, 0xc79a6b);
      } else if (c.style === 'fridge') {
        // drawn separately (animated door)
      } else {
        this._furniture(c, bPlain);
      }
    }
    this._floors(bPlain);
    const meshes = [
      bHouse.empty ? null : bHouse.mesh(tex(siding)),
      bGarage.empty ? null : bGarage.mesh(tex(sidingBlue)),
      bWood.empty ? null : bWood.mesh(tex(plankTexture('#c8955a', 1, 1))),
      bStone.empty ? null : bStone.mesh(tex(stoneTexture(1, 1))),
      bPlain.empty ? null : bPlain.mesh(new THREE.MeshToonMaterial({ gradientMap, vertexColors: true })),
    ];
    for (const m of meshes) if (m) this.group.add(m);
  }

  _cylStatic(c, b) {
    const col = FURNITURE_COLORS[c.style] ?? 0x888888;
    const m = add(this.props, G.cylLo, toon(col), c.x, (c.y0 + c.y1) / 2, c.z, { sx: c.r, sy: c.y1 - c.y0, sz: c.r });
    m.castShadow = true;
    m.receiveShadow = true;
    if (c.style === 'pot') add(this.props, G.sphereLo, toon(0x43a047), c.x, c.y1 + 0.25, c.z, { sx: 0.45, sy: 0.4, sz: 0.45 });
    if (c.style === 'rack') {
      for (let i = 0; i < 3; i++) add(this.props, G.sphereLo, toon([0xe53935, 0x1e88e5, 0xfdd835][i]), c.x + (i - 1) * 0.18, c.y1 - 0.2 - i * 0.12, c.z, { s: 0.15 });
    }
    void b;
  }

  /** Low-poly furniture from boxes: shape by style. */
  _furniture(c, b) {
    const col = FURNITURE_COLORS[c.style] ?? 0xa1887f;
    const { minX: x0, maxX: x1, minZ: z0, maxZ: z1, y0, y1 } = c;
    const dark = (h) => new THREE.Color(h).multiplyScalar(0.72).getHex();
    switch (c.style) {
      case 'couch': {
        b.box(x0, x1, y0, y0 + 0.5, z0, z1, col);
        b.box(x0, x1, y0 + 0.5, y1, z0, z0 + 0.35, dark(col)); // back against the front wall
        b.box(x0, x0 + 0.3, y0 + 0.4, y0 + 0.8, z0 + 0.3, z1, dark(col));
        b.box(x1 - 0.3, x1, y0 + 0.4, y0 + 0.8, z0 + 0.3, z1, dark(col));
        b.box(x0 + 0.4, x1 - 0.4, y0 + 0.5, y0 + 0.62, z0 + 0.4, z1 - 0.05, 0xb39ddb);
        break;
      }
      case 'bookshelf': {
        b.box(x0, x1, y0, y1, z0, z1, col);
        const cols = [0xef5350, 0x42a5f5, 0xffee58, 0x66bb6a, 0xab47bc];
        for (let s = 0; s < 4; s++) for (let i = 0; i < 6; i++) b.box(x0 + 0.1 + i * ((x1 - x0 - 0.2) / 6), x0 + 0.1 + (i + 0.8) * ((x1 - x0 - 0.2) / 6), y0 + 0.2 + s * 0.45, y0 + 0.55 + s * 0.45, z0 - 0.02, z0 + 0.08, cols[(i + s) % 5]);
        break;
      }
      case 'table': {
        b.box(x0, x1, y1 - 0.12, y1, z0, z1, col);
        for (const [x, z] of [[x0 + 0.1, z0 + 0.1], [x1 - 0.3, z0 + 0.1], [x0 + 0.1, z1 - 0.3], [x1 - 0.3, z1 - 0.3]]) b.box(x, x + 0.2, y0, y1 - 0.12, z, z + 0.2, dark(col));
        b.box((x0 + x1) / 2 - 0.15, (x0 + x1) / 2 + 0.15, y1, y1 + 0.12, (z0 + z1) / 2 - 0.15, (z0 + z1) / 2 + 0.15, 0xef5350); // fruit bowl
        break;
      }
      case 'counter': case 'island': {
        b.box(x0, x1, y0, y1 - 0.07, z0, z1, col);
        b.box(x0 - 0.04, x1 + 0.04, y1 - 0.07, y1, z0 - 0.04, z1 + 0.04, 0xf5f5f0);
        break;
      }
      case 'tvstand': {
        b.box(x0, x1, y0, y0 + 0.5, z0, z1, col);
        b.box(x0 + 0.1, x0 + 0.25, y0 + 0.5, y0 + 1.3, z0 + 0.15, z1 - 0.15, 0x212121);
        b.box(x0 + 0.04, x0 + 0.1, y0 + 0.58, y0 + 1.22, z0 + 0.25, z1 - 0.25, 0x4fc3f7);
        break;
      }
      case 'shelf': {
        b.box(x0, x1, y0, y1, z0, z0 + 0.1, dark(col));
        for (let s = 0; s < 4; s++) b.box(x0, x1, y0 + 0.2 + s * 0.45, y0 + 0.28 + s * 0.45, z0, z1, col);
        for (let i = 0; i < 5; i++) b.box(x0 + 0.2 + i * 0.5, x0 + 0.5 + i * 0.5, y0 + 0.28 + (i % 3) * 0.45, y0 + 0.6 + (i % 3) * 0.45, z0 + 0.15, z1 - 0.15, [0xff7043, 0x4fc3f7, 0xffd54f, 0x9ccc65, 0xba68c8][i]);
        break;
      }
      case 'crate': {
        b.box(x0, x1, y0, y1, z0, z1, col);
        b.box(x0 - 0.01, x1 + 0.01, y0 + 0.1, y0 + 0.2, z0 - 0.01, z1 + 0.01, dark(col));
        b.box(x0 - 0.01, x1 + 0.01, y1 - 0.2, y1 - 0.1, z0 - 0.01, z1 + 0.01, dark(col));
        break;
      }
      default:
        b.box(x0, x1, y0, y1, z0, z1, col);
    }
  }

  _floors(b) {
    const R = this.cfg.rooms;
    const floor = (r, hex, y = 0.012) => b.box(r.minX, r.maxX, y - 0.02, y, r.minZ, r.maxZ, hex);
    floor(R.living, 0xc79a6b);
    floor(R.kitchen, 0xe9e4d2);
    floor(R.hall, 0xb98d60);
    floor(R.garageRoom, 0xb7c0c6);
    const ch = this.cfg.house.height;
    for (const r of [R.living, R.kitchen, R.hall, R.garageRoom]) b.box(r.minX, r.maxX, ch - 0.06, ch, r.minZ, r.maxZ, 0xf3ead6); // ceilings hide the roof from inside
    // checkerboard hint in the kitchen
    for (let i = 0; i < 4; i++) for (let j = 0; j < 9; j++) if ((i + j) % 2 === 0) b.box(R.kitchen.minX + 0.2 + i * 2, R.kitchen.minX + 2.2 + i * 2, 0.012, 0.018, R.kitchen.minZ + 0.4 + j * 2, R.kitchen.minZ + 2.4 + j * 2, 0xd9d3bd);
  }

  /* ---------------------------------------------------------------- the house ---- */

  _house() {
    const P = this.props;
    const H = this.cfg.house, GA = this.cfg.garage, DK = this.cfg.deck;
    const cz = (H.minZ + H.maxZ) / 2;
    const w = H.maxX - H.minX;
    const wh = H.height;
    // foundation strip
    this._P(P, G.box, toon(0xb0a99a), (H.minX + GA.maxX) / 2, 0.15, H.minZ - 0.02, { sx: GA.maxX - H.minX + 0.4, sy: 0.3, sz: 0.1 }).castShadow = false;
    // house roof: ridge along x
    const roofMat = new THREE.MeshToonMaterial({ map: shingleTexture('#c6554b', 10, 3), gradientMap, side: THREE.DoubleSide });
    const rise = 4.0, over = 0.9;
    const halfD = (H.maxZ - H.minZ) / 2 + over;
    const slope = Math.hypot(halfD, rise), ang = Math.atan2(rise, halfD);
    for (const sgn of [-1, 1]) {
      const m = this._P(P, G.box, roofMat, (H.minX + H.maxX) / 2, wh + rise / 2 + 0.05, cz + sgn * halfD / 2, { sx: w + over * 2, sy: 0.3, sz: slope + 0.2 });
      m.rotation.x = sgn < 0 ? -ang : ang;
    }
    const gableMat = toon(0xffd68a, { side: THREE.DoubleSide });
    const sh = new THREE.Shape();
    sh.moveTo(-(H.maxZ - H.minZ) / 2, 0); sh.lineTo((H.maxZ - H.minZ) / 2, 0); sh.lineTo(0, rise - 0.1); sh.closePath();
    for (const [x, rot] of [[H.maxX + 0.01, PI / 2], [H.minX - 0.01, -PI / 2]]) {
      const m = this._P(P, new THREE.ShapeGeometry(sh), gableMat, x, wh, cz, null);
      m.rotation.y = rot;
    }
    // a round attic window in the west gable
    const glass = basic(0xffe9a0);
    this.world.windowMats.push(glass);
    this._P(P, G.cyl, toon(0xffffff), H.minX - 0.05, wh + 1.7, cz, { sx: 0.7, sy: 0.12, sz: 0.7, rz: PI / 2 });
    this._P(P, G.cyl, glass, H.minX - 0.12, wh + 1.7, cz, { sx: 0.55, sy: 0.05, sz: 0.55, rz: PI / 2 }, false, false);
    // chimney
    this._P(P, G.box, toon(0xb85c45), H.minX + 5, wh + 3.2, cz - 2.2, { sx: 1.3, sy: 3.4, sz: 1.3 });
    this._P(P, G.box, toon(0x8d4a38), H.minX + 5, wh + 4.95, cz - 2.2, { sx: 1.6, sy: 0.3, sz: 1.6 });
    // garage roof: ridge along z
    const gRoof = new THREE.MeshToonMaterial({ map: shingleTexture('#5c7cc0', 6, 2), gradientMap, side: THREE.DoubleSide });
    const gRise = 2.2, gOver = 0.7;
    const gHalf = (GA.maxX - GA.minX) / 2 + gOver;
    const gSlope = Math.hypot(gHalf, gRise), gAng = Math.atan2(gRise, gHalf);
    const gcx = (GA.minX + GA.maxX) / 2, gcz = (GA.minZ + GA.maxZ) / 2, gd = GA.maxZ - GA.minZ;
    for (const sgn of [-1, 1]) {
      const m = this._P(P, G.box, gRoof, gcx + sgn * gHalf / 2, wh + gRise / 2 + 0.05, gcz, { sx: gSlope + 0.2, sy: 0.28, sz: gd + gOver * 2 });
      m.rotation.z = sgn < 0 ? gAng : -gAng;
    }
    const gSh = new THREE.Shape();
    gSh.moveTo(-(GA.maxX - GA.minX) / 2, 0); gSh.lineTo((GA.maxX - GA.minX) / 2, 0); gSh.lineTo(0, gRise - 0.05); gSh.closePath();
    const gGable = toon(0xa9d8f5, { side: THREE.DoubleSide });
    for (const z of [GA.minZ - 0.01, GA.maxZ + 0.01]) this._P(P, new THREE.ShapeGeometry(gSh), gGable, gcx, wh, z, null);
    // windows: front and back of the house, the west wall, the garage front
    const wins = [[-10, 'front'], [-1.2, 'front'], [-10, 'back'], [-1.2, 'back']];
    for (const [x, side] of wins) this._window(P, x, 1.9, side === 'front' ? H.minZ : H.maxZ, side === 'front' ? -1 : 1, 'z', side === 'front');
    this._window(P, H.minX, 1.9, 9.5, -1, 'x', false);
    this._window(P, H.minX, 1.9, 20, -1, 'x', false);
    this._window(P, (GA.minX + GA.maxX) / 2, 2.0, GA.minZ, -1, 'z', false, 1.6);
    // front door frame, porch light, house number, doormat
    const d = this.cfg.doors.find((x) => x.id === 'front');
    this._P(P, G.box, toon(0xffffff), d.x, 1.75, H.minZ - 0.06, { sx: d.w + 0.5, sy: 3.5, sz: 0.16 });
    this._P(P, G.box, toon(0xe53935), d.x, wh + 0.2, H.minZ - 0.8, { sx: d.w + 1.2, sy: 0.14, sz: 1.7, rx: 0.3 });
    for (const sx of [-1, 1]) this._P(P, G.box, toon(0xffffff), d.x + sx * (d.w / 2 + 0.5), 1.7, H.minZ - 1.5, { sx: 0.16, sy: 3.4, sz: 0.16 });
    const lamp = basic(0xfff3b0);
    this.world.windowMats.push(lamp);
    this._P(P, G.sphere, lamp, d.x + d.w / 2 + 0.7, 2.9, H.minZ - 0.2, { s: 0.2 }, false, false);
    this._P(P, G.box, toon(0x6d4c41), d.x, 0.04, H.minZ - 1.4, { sx: 2.2, sy: 0.05, sz: 1.0 }, false, true);
    // back door: sliding glass frame + deck rails + chairs
    const bd = this.cfg.doors.find((x) => x.id === 'back');
    this._P(P, G.box, toon(0xffffff), bd.x, 1.75, H.maxZ + 0.06, { sx: bd.w + 0.5, sy: 3.5, sz: 0.16 });
    const rail = toon(0xffffff);
    for (const [x0, x1, z0, z1] of [[DK.minX, DK.maxX, DK.maxZ - 0.1, DK.maxZ], [DK.minX, DK.minX + 0.1, DK.minZ, DK.maxZ], [DK.maxX - 0.1, DK.maxX, DK.minZ, DK.maxZ]]) {
      const skip = z0 === DK.maxZ - 0.1; // the south rail has a gap for the steps
      const segs = skip ? [[x0, 3.2], [6.8, x1]] : [[x0, x1]];
      for (const [a, b] of segs) {
        this._P(P, G.box, rail, (a + b) / 2, DK.top + 0.9, (z0 + z1) / 2, { sx: Math.max(0.1, b - a), sy: 0.1, sz: Math.max(0.1, z1 - z0) });
        for (let i = 0; i <= Math.round((b - a) / 0.6) && (b - a) > 0.3; i++) {
          const f = (b - a) > 0.3 ? i / Math.round((b - a) / 0.6) : 0;
          this._P(P, G.box, rail, lerp(a, b, f), DK.top + 0.45, (z0 + z1) / 2, { sx: Math.max(0.08, z1 - z0 > 0.5 ? 0.08 : 0.08), sy: 0.9, sz: 0.08 }, false, false);
        }
      }
    }
    for (const x of [1.6, 8.4]) {
      this._P(P, G.box, toon(0xff8a65), x, DK.top + 0.35, 26.5, { sx: 0.8, sy: 0.7, sz: 0.8 });
      this._P(P, G.box, toon(0xff8a65), x, DK.top + 0.85, 26.9, { sx: 0.8, sy: 0.5, sz: 0.1 });
    }
    // cellar hatch: two open storm doors leaning at the top of the stairs
    const R = this.cfg.cellar.ramp;
    for (const [z, sgn] of [[R.minZ - 0.9, -1], [R.maxZ + 0.9, 1]]) {
      const flap = this._P(P, G.box, toon(0x607d8b), R.minX - 0.1, 0.55, z, { sx: 1.6, sy: 0.1, sz: 1.5 });
      flap.rotation.x = sgn * 1.1;
    }
    this._P(P, G.box, toon(0xffe082), R.minX - 1.8, 0.9, (R.minZ + R.maxZ) / 2, { sx: 0.1, sy: 0.7, sz: 1.6 }, true, false);
    this._P(P, new THREE.PlaneGeometry(1, 1), new THREE.MeshToonMaterial({ map: textSignTexture('CELLAR', '#ffe082', '#6d4c41', 256, 96), gradientMap }), R.minX - 1.74, 0.9, (R.minZ + R.maxZ) / 2, { sx: 1.5, sy: 0.6, sz: 1 }, false, false).rotation.y = -PI / 2;
    // shed: slanted roof and a sign (its walls are cover)
    const S = this.cfg.shed;
    const shedRoof = this._P(P, G.box, toon(0x8d6e63), (S.minX + S.maxX) / 2, 2.65, (S.minZ + S.maxZ) / 2, { sx: S.maxX - S.minX + 0.8, sy: 0.18, sz: S.maxZ - S.minZ + 0.8 });
    shedRoof.rotation.x = 0.12;
    this._P(P, new THREE.PlaneGeometry(1, 1), new THREE.MeshToonMaterial({ map: textSignTexture('SHED', '#ffe082', '#6d4c41', 256, 96), gradientMap }), S.maxX + 0.05, 2.0, S.door.c, { sx: 1.4, sy: 0.5, sz: 1 }, false, false).rotation.y = PI / 2;
    // bushes along the house and gnomes
    for (const x of [-12.5, -7, -1.5, 3, 7]) {
      this._P(P, G.sphereLo, toon(0x3fa34d), x, 0.5, H.minZ - 0.7, { sx: 0.9, sy: 0.65, sz: 0.7 });
      this._P(P, G.sphereLo, toon(0x57bb5e), x + 0.6, 0.4, H.minZ - 0.8, { sx: 0.6, sy: 0.5, sz: 0.5 });
    }
    this._gnome(P, 1.6, H.minZ - 1.0, 0x1e88e5);
    this._gnome(P, 8.6, H.minZ - 0.9, 0xe53935);
    // pegboard behind the garage rack and the open roll-up sign
    this._P(P, G.box, toon(0xd7ccc8), (GA.minX + GA.maxX) / 2, 2.0, GA.maxZ - 0.5, { sx: 9.6, sy: 1.6, sz: 0.06 }, false, true);
    const sign = new THREE.MeshToonMaterial({ map: textSignTexture('GARAGE', '#ffe082', '#6d4c41'), gradientMap });
    this._P(P, new THREE.PlaneGeometry(1, 1), sign, GA.maxX + 0.05, 3.55, 15, { sx: 3.2, sy: 0.7, sz: 1 }, false, false).rotation.y = PI / 2;
  }

  _P(parent, geo, mat, x, y, z, o, cast = true, receive = true) {
    const m = add(parent, geo, mat, x, y, z, o);
    m.castShadow = cast;
    m.receiveShadow = receive;
    return m;
  }

  _gnome(P, x, z, hatColor) {
    this._P(P, G.cyl, toon(0x1565c0), x, 0.3, z, { sx: 0.17, sy: 0.6, sz: 0.17 });
    this._P(P, G.sphere, toon(0xffccaa), x, 0.7, z - 0.05, { s: 0.15 });
    this._P(P, G.cone, toon(0xffffff), x, 0.52, z - 0.12, { sx: 0.17, sy: 0.3, sz: 0.1 }).rotation.x = PI;
    this._P(P, G.cone, toon(hatColor), x, 1.0, z, { sx: 0.17, sy: 0.5, sz: 0.17 });
  }

  /** A window on a wall: (x or z) is the wall line, nz/nx the outward side. */
  _window(P, a, y, b, out, axis, flowers, w = 2.0) {
    const frame = toon(0xffffff);
    const glass = basic(0xffe9a0);
    this.world.windowMats.push(glass);
    const shutter = toon(a < -5 ? 0x4fc3f7 : 0xff8a65);
    const g = new THREE.Group();
    // built facing -z (out = -1) at the origin, then rotated into place
    add(g, G.box, frame, 0, 0, -0.05, { sx: w + 0.4, sy: 1.7, sz: 0.14 });
    add(g, G.box, glass, 0, 0, -0.13, { sx: w, sy: 1.3, sz: 0.06 }).castShadow = false;
    add(g, G.box, frame, 0, 0, -0.18, { sx: 0.08, sy: 1.3, sz: 0.06 });
    add(g, G.box, frame, 0, 0, -0.18, { sx: w, sy: 0.08, sz: 0.06 });
    for (const s of [-1, 1]) add(g, G.box, shutter, s * (w / 2 + 0.55), 0, -0.1, { sx: 0.55, sy: 1.7, sz: 0.08 });
    add(g, G.box, frame, 0, -0.95, -0.3, { sx: w + 0.6, sy: 0.12, sz: 0.5 });
    if (flowers) {
      const r = mulberry(Math.floor(Math.abs(a * 7 + b)));
      add(g, G.box, toon(0x8d5a2b), 0, -1.12, -0.5, { sx: w, sy: 0.3, sz: 0.36 });
      for (let k = 0; k < 6; k++) {
        add(g, G.sphereLo, toon([0xff6fa8, 0xffd93b, 0xb388ff, 0xff8a65][(r() * 4) | 0]), -w / 2 + 0.2 + k * ((w - 0.4) / 5), -0.88, -0.5, { s: 0.13 });
      }
    }
    if (axis === 'z') {
      g.position.set(a, y, b);
      g.rotation.y = out < 0 ? 0 : PI;
    } else {
      g.position.set(a, y, b);
      g.rotation.y = out < 0 ? -PI / 2 : PI / 2; // facing -x
    }
    P.add(g);
  }

  /* ---------------------------------------------------------------- doors, gate, fridge ---- */

  _doors() {
    const palette = { front: 0x26a69a, side: 0x66bb6a, back: 0xb2ebf2, garage: 0xf5f5f5 };
    for (const piece of this.cfg.doorPieces) {
      const d = this.cfg.doors.find((x) => `door:${x.id}` === piece.id);
      const g = new THREE.Group();
      const w = d.w, h = piece.y1;
      const color = palette[d.id];
      const panelMat = toon(color);
      const along = d.nz !== 0 ? 'x' : 'z';
      // built in a local frame: width along x, thickness along z, facing -z; rotated to the door's wall
      const panel = new THREE.Group();
      add(panel, G.box, panelMat, 0, h / 2, 0, { sx: w - 0.1, sy: h - 0.1, sz: 0.2 }).castShadow = true;
      if (d.id === 'garage') {
        for (let i = 0; i < 6; i++) add(panel, G.box, toon(0xcfd8dc), 0, 0.4 + i * 0.55, -0.12, { sx: w - 0.3, sy: 0.07, sz: 0.06 });
        for (let i = 0; i < 4; i++) add(panel, G.box, toon(0x90a4ae), -w / 2 + 0.9 + i * 1.0, 3.0, -0.13, { sx: 0.7, sy: 0.3, sz: 0.05 });
      } else if (d.id === 'back') {
        add(panel, G.box, basic(0xc9f1f7), 0, h / 2 + 0.2, -0.12, { sx: w - 0.6, sy: h - 0.9, sz: 0.06 });
        add(panel, G.box, toon(0xffffff), 0, h / 2 + 0.2, -0.14, { sx: 0.1, sy: h - 0.9, sz: 0.05 });
      } else {
        add(panel, G.box, toon(0xffffff), 0, h * 0.62, -0.12, { sx: w * 0.55, sy: h * 0.3, sz: 0.05 });
        add(panel, G.sphere, toon(0xffd54f), w * 0.34, h * 0.45, -0.18, { s: 0.11 });
        add(panel, G.cyl, basic(0xb2ebf2), 0, h * 0.62, -0.17, { sx: 0.4, sy: 0.04, sz: 0.4, rx: PI / 2 });
      }
      g.add(panel);
      // frame
      add(g, G.box, toon(0xffffff), -w / 2, h / 2, 0, { sx: 0.12, sy: h, sz: 0.3 });
      add(g, G.box, toon(0xffffff), w / 2, h / 2, 0, { sx: 0.12, sy: h, sz: 0.3 });
      add(g, G.box, toon(0xffffff), 0, h + 0.05, 0, { sx: w + 0.2, sy: 0.12, sz: 0.3 });
      g.userData.bake = true; // the whole door becomes one mesh per colour
      // facing: the door's outward normal (nx, nz) points to the local -z axis
      const cx = (piece.minX + piece.maxX) / 2, cz = (piece.minZ + piece.maxZ) / 2;
      g.position.set(cx, 0, cz);
      g.rotation.y = Math.atan2(-d.nx, -d.nz); // local -z -> outward
      void along;
      g.updateMatrixWorld(true);
      bakeGroup(g);
      this.group.add(g);
      this.doorViews.set(piece.id, { group: g, panel, def: d, maxHp: 1, hp: 1, broken: false, shake: 0, piece });
    }
    // planks left behind by a broken door share one set of meshes
    this.plankMat = toon(0xa9774a);
  }

  /**
   * Repair piles: planks leaning on a crate, a stack of boards, a red toolbox, a hammer and a little yellow sign - one just
   * inside every door. Plain coloured boxes only, so the four piles cost no extra draw call (they merge with the props).
   */
  _piles() {
    const P = this.props;
    for (const r of this.cfg.repairPiles || []) {
      const d = this.cfg.doors.find((x) => x.id === r.door);
      if (!d) continue;
      const g = new THREE.Group();
      g.position.set(r.x, this.map.groundHeight(r.x, r.z), r.z);
      g.rotation.y = Math.atan2(-d.nx, -d.nz); // local -z points out through the door: the planks lean on the wall side
      const wood = [0xc59a62, 0xa9774a, 0xd9b27c];
      this._P(P, G.box, toon(0xb98a5a), -0.15, 0.21, -0.1, { sx: 0.6, sy: 0.42, sz: 0.46 }); // crate
      this._P(P, G.box, toon(0x8d6240), -0.15, 0.43, -0.1, { sx: 0.64, sy: 0.05, sz: 0.5 });
      for (let i = 0; i < 3; i++) this._P(P, G.box, toon(wood[i]), -0.3 + i * 0.17, 0.72, -0.4, { sx: 0.14, sy: 1.25, sz: 0.04, rx: -0.3 }); // planks leaning on the wall
      for (let i = 0; i < 3; i++) this._P(P, G.box, toon(wood[(i + 1) % 3]), 0.28, 0.03 + i * 0.05, 0.38, { sx: 1.0, sy: 0.045, sz: 0.17, ry: 0.15 * (i - 1) }); // boards on the floor
      this._P(P, G.box, toon(0xe53935), 0.5, 0.11, -0.12, { sx: 0.46, sy: 0.22, sz: 0.24 }); // toolbox
      this._P(P, G.box, toon(0xb71c1c), 0.5, 0.23, -0.12, { sx: 0.48, sy: 0.04, sz: 0.26 });
      this._P(P, G.box, toon(0x424242), 0.5, 0.29, -0.12, { sx: 0.3, sy: 0.03, sz: 0.04 }); // handle
      this._P(P, G.box, toon(0xcfd8dc), 0.5, 0.2, -0.0, { sx: 0.08, sy: 0.06, sz: 0.02 }); // latch
      this._P(P, G.box, toon(0x8d5a2b), 0.26, 0.17, 0.38, { sx: 0.5, sy: 0.04, sz: 0.04, ry: 0.7 }); // hammer
      this._P(P, G.box, toon(0x78909c), 0.43, 0.2, 0.3, { sx: 0.13, sy: 0.1, sz: 0.07, ry: 0.7 });
      this._P(P, G.box, toon(0x8d6240), -0.62, 0.55, 0.3, { sx: 0.06, sy: 1.1, sz: 0.06 }); // sign post
      this._P(P, G.box, toon(0xffd54f), -0.62, 1.08, 0.3, { sx: 0.56, sy: 0.3, sz: 0.05 });
      this._P(P, G.box, toon(0xe53935), -0.62, 1.08, 0.33, { sx: 0.34, sy: 0.07, sz: 0.03, rz: 0.78 });
      this._P(P, G.box, toon(0xe53935), -0.62, 1.08, 0.33, { sx: 0.34, sy: 0.07, sz: 0.03, rz: -0.78 });
      P.add(g);
    }
  }

  /**
   * Health bars on both faces of every door: one canvas atlas (a row per door), one merged mesh (8 quads), one draw call.
   * `updateDoorBars` redraws a row only when its bar changes by at least a pixel or the door breaks / is rebuilt.
   */
  _doorBars() {
    const pieces = this.cfg.doorPieces;
    const W = 256;
    const ROW = 48;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = ROW * pieces.length;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const pos = [];
    const uv = [];
    const idx = [];
    const N = pieces.length;
    pieces.forEach((piece, i) => {
      const d = this.cfg.doors.find((x) => `door:${x.id}` === piece.id);
      const w = Math.max(2.0, d.w * 0.85);
      const h = (w * ROW) / W;
      const cx = (piece.minX + piece.maxX) / 2;
      const cz = (piece.minZ + piece.maxZ) / 2;
      const y = piece.y1 - 0.45;
      for (const side of [1, -1]) {
        const nx = d.nx * side;
        const nz = d.nz * side;
        const rx = nz;
        const rz = -nx; // the viewer's right while looking at the face
        const px = cx + nx * 0.17;
        const pz = cz + nz * 0.17;
        const base = pos.length / 3;
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          pos.push(px + rx * (w / 2) * su, y + (h / 2) * sv, pz + rz * (w / 2) * su);
          uv.push((su + 1) / 2, 1 - (i + 1 - (sv + 1) / 2) / N);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.35, toneMapped: false }));
    mesh.renderOrder = 3;
    mesh.frustumCulled = true;
    this.group.add(mesh);
    this.bars = { canvas, ctx: canvas.getContext('2d'), tex, W, ROW, key: pieces.map(() => -2) };
    this.updateDoorBars(this.map.doors);
  }

  /** Redraw the bars of doors whose health changed. doors: MapData.doors (id -> { hp, maxHp, alive }). */
  updateDoorBars(doors) {
    const b = this.bars;
    if (!b) return;
    let dirty = false;
    this.cfg.doorPieces.forEach((piece, i) => {
      const d = doors.get(piece.id);
      if (!d) return;
      const frac = d.alive ? Math.max(0.02, Math.min(1, d.hp / Math.max(1, d.maxHp))) : 0;
      const key = d.alive ? Math.round(frac * 60) : -1; // a pixel or so of bar
      if (b.key[i] === key) return;
      b.key[i] = key;
      dirty = true;
      const g = b.ctx;
      const y0 = i * b.ROW;
      g.clearRect(0, y0, b.W, b.ROW);
      const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
      rr(3, y0 + 4, b.W - 6, b.ROW - 8, 14);
      g.fillStyle = 'rgba(25, 20, 40, 0.92)';
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = '#ffffff';
      g.stroke();
      if (d.alive) {
        const inner = b.W - 24;
        rr(12, y0 + 12, Math.max(8, inner * frac), b.ROW - 24, 9);
        g.fillStyle = frac > 0.6 ? '#5ad04a' : frac > 0.3 ? '#ffc83a' : '#ff4a3a';
        g.fill();
      } else {
        rr(12, y0 + 12, b.W - 24, b.ROW - 24, 9);
        g.fillStyle = '#c62828';
        g.fill();
        g.font = `bold ${b.ROW - 22}px "Trebuchet MS", sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = '#ffffff';
        g.fillText('BROKEN', b.W / 2, y0 + b.ROW / 2 + 1);
      }
      const v = this.doorViews.get(piece.id);
      if (v && d.alive && !v.broken) v.panel.rotation.z = (1 - frac) * 0.05;
    });
    if (dirty) b.tex.needsUpdate = true;
  }

  /** A broken door goes back up (the planks vanish, the door pops back in). Returns where, for the dust. */
  doorRebuild(id) {
    const v = this.doorViews.get(id);
    if (!v || !v.broken) return null;
    v.broken = false;
    if (v.planks) this.group.remove(v.planks);
    v.planks = null;
    this.group.add(v.group);
    v.shake = 0.5;
    return { x: (v.piece.minX + v.piece.maxX) / 2, y: v.piece.y1 / 2, z: (v.piece.minZ + v.piece.maxZ) / 2 };
  }

  /** Door damage / break from events (client/map.js keeps the numbers). */
  doorHit(id, frac) {
    const v = this.doorViews.get(id);
    if (!v || v.broken) return;
    v.shake = 0.35;
    v.panel.rotation.z = (1 - frac) * 0.05;
  }

  doorBreak(id) {
    const v = this.doorViews.get(id);
    if (!v || v.broken) return null;
    v.broken = true;
    this.group.remove(v.group);
    // a few planks on the floor and one hanging on the hinge
    const d = v.def;
    const f = new THREE.Group();
    const cx = (v.piece.minX + v.piece.maxX) / 2, cz = (v.piece.minZ + v.piece.maxZ) / 2;
    const r = mulberry(Math.floor(cx * 31 + cz));
    for (let i = 0; i < 6; i++) {
      const p = add(f, G.box, this.plankMat, (r() - 0.5) * 1.6 - d.nx * 0.2, 0.05 + (i % 2) * 0.03, (r() - 0.5) * 1.6 - d.nz * 0.2, { sx: 0.18, sy: 0.05, sz: 1.1 + r() * 0.6 });
      p.rotation.y = r() * PI;
      p.castShadow = false;
    }
    const hang = add(f, G.box, this.plankMat, (d.nz !== 0 ? -d.w / 2 + 0.2 : 0), 1.2, (d.nz !== 0 ? 0 : -d.w / 2 + 0.2), { sx: 0.2, sy: 2.2, sz: 0.1 });
    hang.rotation.z = d.nz !== 0 ? 0.28 : 0;
    hang.rotation.x = d.nz !== 0 ? 0 : 0.28;
    f.position.set(cx + d.nx * 0.5, 0, cz + d.nz * 0.5);
    this.group.add(f);
    v.planks = f;
    return { x: cx, y: v.piece.y1 / 2, z: cz };
  }

  resetDoors() {
    for (const [, v] of this.doorViews) {
      if (v.broken) {
        if (v.planks) this.group.remove(v.planks);
        v.planks = null;
        this.group.add(v.group);
        v.broken = false;
      }
      v.panel.rotation.z = 0;
    }
  }

  _fridge() {
    const f = this.cfg.fridge;
    const g = new THREE.Group();
    g.position.set(f.x, 0, f.z);
    const body = toon(0xe0f2f1);
    add(g, G.box, body, 0, f.h / 2, 0.05, { sx: f.w, sy: f.h, sz: f.d - 0.1 }).castShadow = true;
    add(g, G.box, basic(0xfff8d0), 0, f.h / 2 - 0.1, 0.1, { sx: f.w - 0.16, sy: f.h - 0.3, sz: f.d - 0.34 }); // the lit inside
    for (let i = 0; i < 4; i++) add(g, G.box, toon(0xffffff), 0, 0.4 + i * 0.45, -0.1, { sx: f.w - 0.16, sy: 0.04, sz: 0.4 });
    // snacks on the shelves
    const snack = [0xef5350, 0xffca28, 0x66bb6a, 0x42a5f5, 0xff7043];
    for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) add(g, G.box, toon(snack[(i + k) % 5]), -0.25 + k * 0.25, 0.5 + i * 0.45, -0.12, { sx: 0.16, sy: 0.18, sz: 0.16 });
    // door: hinged on the left, swings open when zombies come near
    const hinge = new THREE.Group();
    hinge.position.set(-f.w / 2, 0, -f.d / 2 + 0.02);
    const door = new THREE.Group();
    door.position.set(f.w / 2, 0, 0);
    add(door, G.box, body, 0, f.h / 2, -0.04, { sx: f.w, sy: f.h, sz: 0.1 }).castShadow = true;
    add(door, G.box, toon(0x90a4ae), f.w / 2 - 0.1, f.h * 0.55, -0.12, { sx: 0.07, sy: 0.6, sz: 0.06 });
    for (let i = 0; i < 3; i++) add(door, G.box, toon([0xef5350, 0x42a5f5, 0xffca28][i]), -0.2 + i * 0.2, f.h * 0.82, -0.1, { sx: 0.12, sy: 0.12, sz: 0.04 }); // magnets
    door.userData.bake = true;
    bakeGroup(door);
    hinge.add(door);
    g.add(hinge);
    const glow = new THREE.PointLight(0xfff1c0, 0, 6, 1.6);
    glow.position.set(0, 1.2, -0.7);
    g.add(glow);
    g.userData.bake = true; // body, shelves and snacks: a few meshes (the hinged door is baked separately and left alone)
    g.updateMatrixWorld(true);
    bakeGroup(g);
    this.group.add(g);
    this.fridge = { group: g, hinge, glow, open: 0 };
  }

  setFridge(n, dt) {
    const f = this.fridge;
    if (!f) return;
    const want = n > 0 ? 1 : 0;
    f.open += (want - f.open) * Math.min(1, dt * 5);
    f.hinge.rotation.y = f.open * 1.9;
    f.glow.intensity = 0.1 + f.open * 3;
  }

  /* ---------------------------------------------------------------- fence, gate, pen ---- */

  _fence() {
    const P = this.props;
    const B = this.cfg.bounds, gate = this.cfg.gate, pen = this.cfg.pen;
    const rail = toon(0xe0c8a0);
    const segs = [
      { a: [B.minX, B.minZ], b: [gate.minX - 1.0, B.minZ] },
      { a: [gate.maxX + 1.0, B.minZ], b: [B.maxX, B.minZ] },
      { a: [B.minX, B.minZ], b: [B.minX, B.maxZ] },
      { a: [B.maxX, B.minZ], b: [B.maxX, B.maxZ] },
      { a: [B.minX, B.maxZ], b: [B.maxX, B.maxZ] },
      // the gate pen
      { a: [pen.minX, pen.minZ], b: [pen.minX, pen.maxZ] },
      { a: [pen.maxX, pen.minZ], b: [pen.maxX, pen.maxZ] },
    ];
    this.picketXforms = [];
    for (const s of segs) {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
      const len = Math.hypot(dx, dz);
      const cx = (s.a[0] + s.b[0]) / 2, cz = (s.a[1] + s.b[1]) / 2;
      const alongX = Math.abs(dx) > Math.abs(dz);
      for (const y of [0.55, 1.35]) this._P(P, G.box, rail, cx, y, cz, alongX ? { sx: len, sy: 0.14, sz: 0.1 } : { sx: 0.1, sy: 0.14, sz: len });
      const n = Math.floor(len / 0.55);
      for (let i = 0; i <= n; i++) {
        const k = i / n;
        this.picketXforms.push({ x: s.a[0] + dx * k, z: s.a[1] + dz * k, rot: alongX ? 0 : PI / 2 });
      }
    }
    // gate pillars with grinning lanterns, banner, and the double gate that holds the zombies in
    for (const sx of [-1, 1]) {
      const x = sx * (gate.maxX + 1.2), z = B.minZ;
      this._P(P, G.cyl, toon(0x9aa5ad), x, 1.8, z, { sx: 0.8, sy: 3.6, sz: 0.8 });
      this._P(P, G.cyl, toon(0xb0bec5), x, 3.7, z, { sx: 1.05, sy: 0.3, sz: 1.05 });
      const lantern = add(this.group, G.sphere, basic(0xb8f56a, { transparent: true, opacity: 0.9 }), x, 4.5, z, { s: 0.75 });
      this.world.lanterns.push(lantern);
      add(this.group, G.sphere, basic(0x2b2438), x - 0.25, 4.65, z + 0.62, { s: 0.14 });
      add(this.group, G.sphere, basic(0x2b2438), x + 0.25, 4.65, z + 0.62, { s: 0.14 });
      add(this.group, G.smile, basic(0x2b2438), x, 4.4, z + 0.62, { s: 0.3 }).rotation.z = PI;
    }
    const bannerMat = new THREE.MeshToonMaterial({ map: textSignTexture('ZOMBIE GATE', '#7e57c2', '#f3e5f5'), gradientMap });
    for (const x of [-5.5, 5.5]) this._P(P, G.cyl, toon(0x6d4c41), x, 2.4, B.minZ - 1.2, { sx: 0.18, sy: 4.8, sz: 0.18 });
    this._P(P, G.box, bannerMat, 0, 4.6, B.minZ - 1.2, { sx: 11, sy: 2.0, sz: 0.2 }, true, false).rotation.y = PI;
    // the gate itself: two wooden doors across the pen's mouth, hinged at the pen posts
    const wood = toon(0xb07a45);
    const halfW = (pen.maxX - pen.minX) / 2;
    this.gate = { left: new THREE.Group(), right: new THREE.Group(), open: 0 };
    for (const [grp, sx] of [[this.gate.left, -1], [this.gate.right, 1]]) {
      grp.position.set(sx * halfW, 0, pen.maxZ);
      const panel = new THREE.Group();
      panel.position.set(-sx * halfW / 2, 0, 0);
      add(panel, G.box, wood, 0, 1.2, 0, { sx: halfW - 0.1, sy: 2.2, sz: 0.18 }).castShadow = true;
      for (const y of [0.5, 1.2, 1.9]) add(panel, G.box, toon(0x8d5a2b), 0, y, -0.12, { sx: halfW - 0.2, sy: 0.14, sz: 0.06 });
      add(panel, G.box, toon(0x8d5a2b), 0, 1.2, -0.13, { sx: 0.14, sy: 2.1, sz: 0.06 });
      panel.userData.bake = true;
      grp.add(panel);
      grp.updateMatrixWorld(true);
      bakeGroup(panel);
      this.group.add(grp);
    }
    // skull sign on the gate
    this._P(this.group, new THREE.PlaneGeometry(1, 1), new THREE.MeshToonMaterial({ map: emojiTexture('\u{1F480}', '#7e57c2'), gradientMap }), 0, 2.6, pen.maxZ - 0.1, { sx: 1.1, sy: 1.1, sz: 1 }, false, false).rotation.y = PI;
  }

  /** 0 = closed (head start), 1 = swung open. */
  setGate(open, dt) {
    const g = this.gate;
    if (!g) return;
    g.open += (open - g.open) * Math.min(1, dt * 4);
    const a = g.open * 1.75;
    g.left.rotation.y = a; // swings toward the yard (+z)
    g.right.rotation.y = -a;
  }

  /* ---------------------------------------------------------------- scenery beyond the fence ---- */

  _scenery() {
    const P = this.props;
    const r = mulberry(1234);
    const B = this.cfg.bounds;
    const trunk = toon(0x8d5a2b);
    const greens = [toon(0x4caf50), toon(0x66bb6a), toon(0x2e9e4f), toon(0x7ac74f)];
    const blossom = toon(0xff9ec4);
    const inside = (x, z) => x > B.minX - 6 && x < B.maxX + 6 && z > B.minZ - 6 && z < B.maxZ + 6;
    let placed = 0;
    while (placed < 34) {
      const x = -130 + r() * 260, z = -150 + r() * 250;
      if (inside(x, z)) continue;
      placed++;
      const s = 0.9 + r() * 1.3;
      this._P(P, G.cyl, trunk, x, 2.2 * s, z, { sx: 0.5 * s, sy: 4.4 * s, sz: 0.5 * s });
      const gm = r() < 0.18 ? blossom : greens[(r() * greens.length) | 0];
      this._P(P, G.sphereLo, gm, x, 5.6 * s, z, { sx: 3.2 * s, sy: 2.9 * s, sz: 3.2 * s });
      this._P(P, G.sphereLo, gm, x + 1.6 * s, 4.7 * s, z + 0.6 * s, { sx: 2.2 * s, sy: 2.0 * s, sz: 2.2 * s });
      this._P(P, G.sphereLo, gm, x - 1.5 * s, 4.9 * s, z - 0.5 * s, { sx: 2.0 * s, sy: 1.9 * s, sz: 2.0 * s });
    }
    const hillMat = [toon(0x5fb04e), toon(0x4f9f48), toon(0x6bbd57)];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * PI * 2 + r() * 0.3;
      const rad = 210 + r() * 90;
      const s = 40 + r() * 50;
      this._P(P, G.sphere, hillMat[i % 3], Math.cos(a) * rad, -s * 0.35, Math.sin(a) * rad - 20, { sx: s * 1.6, sy: s * 0.8, sz: s * 1.2 }, false, false);
    }
    // neighbours' bird house
    this._P(P, G.cyl, toon(0x8d5a2b), -48, 2.5, 18, { sx: 0.12, sy: 5, sz: 0.12 });
    this._P(P, G.box, toon(0xff8a65), -48, 5.3, 18, { sx: 0.8, sy: 0.8, sz: 0.8 });
    this._P(P, G.cone, toon(0x6d4c41), -48, 6.0, 18, { sx: 0.7, sy: 0.5, sz: 0.7 }).rotation.y = PI / 4;
  }

  /* ---------------------------------------------------------------- instanced decor ---- */

  _decorInstances() {
    const s = this.group;
    const d = new THREE.Object3D();
    const col = new THREE.Color();
    // pickets
    const shape = new THREE.Shape();
    shape.moveTo(-0.15, 0); shape.lineTo(0.15, 0); shape.lineTo(0.15, 1.75); shape.lineTo(0, 2.0); shape.lineTo(-0.15, 1.75); shape.closePath();
    const pg = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
    pg.translate(0, 0, -0.04);
    const pm = new THREE.InstancedMesh(pg, new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap }), this.picketXforms.length);
    pm.castShadow = true;
    pm.receiveShadow = true;
    const r = mulberry(4);
    this.picketXforms.forEach((p, i) => {
      d.position.set(p.x, this.map.groundHeight(p.x, p.z) - 0.05, p.z);
      d.rotation.set(0, p.rot, 0);
      d.scale.set(1, 0.88 + r() * 0.2, 1);
      d.updateMatrix();
      pm.setMatrixAt(i, d.matrix);
      pm.setColorAt(i, col.setHSL(0.1 + r() * 0.03, 0.6 + r() * 0.3, 0.88 + r() * 0.08));
    });
    s.add(pm);

    // flowers and grass tufts in the lawn, away from buildings, plots and paths
    const rnd = mulberry(21);
    const B = this.cfg.bounds;
    const noGo = this.cfg.noBuild || [];
    const paths = this.cfg.gravel;
    const bad = (x, z) => {
      if (x < B.minX + 1 || x > B.maxX - 1 || z < B.minZ + 1 || z > B.maxZ - 1) return true;
      for (const r2 of noGo) if (x > r2.minX - 0.4 && x < r2.maxX + 0.4 && z > r2.minZ - 0.4 && z < r2.maxZ + 0.4) return true;
      for (const p of paths) for (let i = 0; i + 1 < p.pts.length; i++) if (distSeg(x, z, p.pts[i][0], p.pts[i][1], p.pts[i + 1][0], p.pts[i + 1][1]) < p.half + 0.4) return true;
      return this.map.groundHeight(x, z) < -0.3;
    };
    const pts = [];
    while (pts.length < 120) {
      const x = B.minX + 1 + rnd() * (B.maxX - B.minX - 2), z = B.minZ + 1 + rnd() * (B.maxZ - B.minZ - 2);
      if (!bad(x, z)) pts.push({ x, z });
    }
    const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.015, 0.015, 0.4, 4).translate(0, 0.2, 0), toon(0x3fa34d), pts.length);
    const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 6, 4).translate(0, 0.42, 0), new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap }), pts.length);
    const pal = [0xff6fa8, 0xffd93b, 0xffffff, 0xb388ff, 0xff8a65, 0x4fc3f7];
    pts.forEach((p, i) => {
      d.position.set(p.x, this.map.groundHeight(p.x, p.z), p.z);
      d.rotation.set(0, rnd() * 6, 0);
      const sc = 0.8 + rnd() * 0.7;
      d.scale.set(sc, sc, sc);
      d.updateMatrix();
      stems.setMatrixAt(i, d.matrix);
      heads.setMatrixAt(i, d.matrix);
      heads.setColorAt(i, col.set(pal[(rnd() * pal.length) | 0]));
    });
    s.add(stems, heads);
    const tN = 300;
    const tufts = new THREE.InstancedMesh(new THREE.ConeGeometry(0.05, 0.32, 4).translate(0, 0.16, 0), new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap }), tN * 3);
    let ti = 0;
    for (let i = 0; i < tN; i++) {
      const x = B.minX + 1 + rnd() * (B.maxX - B.minX - 2), z = B.minZ + 1 + rnd() * (B.maxZ - B.minZ - 2);
      if (bad(x, z)) continue;
      const gy = this.map.groundHeight(x, z);
      for (let k = 0; k < 3; k++) {
        d.position.set(x + (k - 1) * 0.08, gy, z + (rnd() - 0.5) * 0.1);
        d.rotation.set((rnd() - 0.5) * 0.5, 0, (rnd() - 0.5) * 0.7);
        d.scale.set(1, 0.7 + rnd() * 0.8, 1);
        d.updateMatrix();
        tufts.setMatrixAt(ti, d.matrix);
        tufts.setColorAt(ti, col.setHSL(0.28 + rnd() * 0.05, 0.6, 0.32 + rnd() * 0.12));
        ti++;
      }
    }
    tufts.count = ti;
    s.add(tufts);
  }

  /* ---------------------------------------------------------------- water + lights ---- */

  _water() {
    const c = this.cfg.creek;
    const mat = new THREE.MeshBasicMaterial({ color: 0x6bc4ec, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });
    const m = this._ribbon(c.points, c.half + 0.9, -0.62, 0.1, mat, 1.5);
    // _ribbon samples the ground; flatten it to the water level
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, -0.62);
    pos.needsUpdate = true;
    this.water = m;
  }

  _lights() {
    const H = this.cfg.house, GA = this.cfg.garage;
    const mk = (x, y, z, intensity, dist) => {
      const l = new THREE.PointLight(0xffd9a0, intensity, dist, 1.4);
      l.position.set(x, y, z);
      this.group.add(l);
      return l;
    };
    this.houseLights = [mk(5, 2.9, 15, 22, 15), mk(-2, 2.9, 12, 22, 15)];
    this.houseLights.push(mk((GA.minX + GA.maxX) / 2, 3.0, 15, 18, 14));
    void H;
  }

  /** Night makes the indoor lights glow. */
  setNight(night) {
    this.houseLights[0].intensity = 8 + 18 * night;
    this.houseLights[1].intensity = 8 + 18 * night;
    this.houseLights[2].intensity = 6 + 16 * night;
  }

  update(dt, t, st) {
    this.t = t;
    this.setFridge(st && st.fridgeN ? st.fridgeN : 0, dt);
    this.setGate(st && st.gateOpen ? 1 : 0, dt);
    for (const v of this.doorViews.values()) {
      if (v.shake > 0) {
        v.shake = Math.max(0, v.shake - dt);
        v.group.position.y = Math.sin(t * 70) * 0.03 * v.shake;
      } else if (v.group.position.y !== 0) v.group.position.y = 0;
    }
    if (this.water) this.water.material.opacity = 0.68 + Math.sin(t * 1.3) * 0.04;
  }
}
