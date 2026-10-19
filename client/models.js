// Cartoon low-poly models built from shared primitives. Everything here reuses cached
// geometries / materials; a model is just a handful of Mesh objects, so creating and
// throwing away models as entities come and go is cheap.
//
// Every builder returns { root, update(ctx), kick(), tagY, ownYaw? }.
//   ctx = { t, dt, speed, e, state, riding, yaw, pitch }
// Models face -z at yaw 0 (same as the server / three.js camera).
import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* shared resources                                                    */
/* ------------------------------------------------------------------ */

const gradientMap = (() => {
  const data = new Uint8Array([90, 160, 220, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
})();
export { gradientMap };

const toonCache = new Map();
/** Cached cel-shaded material. */
export function toon(color, opts) {
  const key = opts ? color + JSON.stringify(opts) : color;
  let m = toonCache.get(key);
  if (!m) {
    m = new THREE.MeshToonMaterial({ color, gradientMap, ...(opts || {}) });
    m.userData.shared = true; // lives for the whole session: nobody disposes it
    toonCache.set(key, m);
  }
  return m;
}

const basicCache = new Map();
/** Cached unlit (always bright) material. */
export function basic(color, opts) {
  const key = opts ? color + JSON.stringify(opts) : color;
  let m = basicCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, ...(opts || {}) });
    m.userData.shared = true;
    basicCache.set(key, m);
  }
  return m;
}

export const G = {
  sphere: new THREE.SphereGeometry(1, 16, 12),
  sphereLo: new THREE.SphereGeometry(1, 10, 8),
  petal: new THREE.SphereGeometry(1, 6, 4),
  sphereXS: new THREE.SphereGeometry(1, 7, 5),
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
  cylLo: new THREE.CylinderGeometry(1, 1, 1, 8),
  cone: new THREE.ConeGeometry(1, 1, 12),
  coneLo: new THREE.ConeGeometry(1, 1, 6),
  torus: new THREE.TorusGeometry(1, 0.16, 6, 18),
  smile: new THREE.TorusGeometry(1, 0.16, 6, 14, Math.PI),
  circle: new THREE.CircleGeometry(1, 20),
  plane: new THREE.PlaneGeometry(1, 1),
};
for (const g of Object.values(G)) g.userData.shared = true; // the shared primitives are never disposed with a model

export function hash(str) {
  str = String(str);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Add a mesh to `parent`. o: s, sx, sy, sz, rx, ry, rz. */
export function add(parent, geometry, material, x = 0, y = 0, z = 0, o = null) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  if (o) {
    if (o.s !== undefined) m.scale.setScalar(o.s);
    if (o.sx !== undefined) m.scale.x = o.sx;
    if (o.sy !== undefined) m.scale.y = o.sy;
    if (o.sz !== undefined) m.scale.z = o.sz;
    if (o.rx !== undefined) m.rotation.x = o.rx;
    if (o.ry !== undefined) m.rotation.y = o.ry;
    if (o.rz !== undefined) m.rotation.z = o.rz;
  }
  parent.add(m);
  return m;
}

function group(parent, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  if (parent) parent.add(g);
  return g;
}

/** Group whose static child meshes get merged (one draw call per material) by bakeAll. */
function bgroup(parent, x = 0, y = 0, z = 0) {
  const g = group(parent, x, y, z);
  g.userData.bake = true;
  return g;
}

/** Group that bakeAll must leave alone (swapped / toggled at runtime). */
function kgroup(parent, x = 0, y = 0, z = 0) {
  const g = group(parent, x, y, z);
  g.userData.keep = true;
  return g;
}

const _inv = new THREE.Matrix4();
const _rel = new THREE.Matrix4();

/** One shared cel-shaded material for every plain coloured part once its colour is baked into vertex colours: one draw call instead of one per colour. */
export const vcMat = new THREE.MeshToonMaterial({ gradientMap, vertexColors: true });
vcMat.userData.shared = true;
/** A plain opaque toon material (no texture, glow, transparency or special sides) can have its colour baked into the geometry. */
export function isPlainToon(m) {
  return Boolean(m && m.isMeshToonMaterial && !m.map && !m.transparent && m.opacity === 1 && m.side === THREE.FrontSide && !m.vertexColors && m.emissive.getHex() === 0 && !m.polygonOffset);
}

// Baked geometry, shared between models. Building a model is cheap, merging it is not (and every merged geometry is a GPU upload),
// so the result is remembered by what went in: the source geometries, each part's colour / material and its matrix inside the
// group. The same builder makes the same signature, so the second zombie of a kind borrows the first one's baked geometry. A
// shared geometry is flagged `userData.shared` and must never be disposed by whoever is using it. Models that vary per entity
// (a seeded colour, say) simply make a few signatures; past BAKE_CACHE_MAX we stop remembering and bake per model as before.
const bakeCache = new Map();
const BAKE_CACHE_MAX = 600;
export const bakeStats = { hit: 0, miss: 0 };

/** Merge the meshes under `g` (not inside nested bake/keep groups) into one mesh per material. */
export function bakeGroup(g) {
  g.updateMatrixWorld(true);
  _inv.copy(g.matrixWorld).invert();
  const parts = [];
  const visit = (o) => {
    for (const c of o.children) {
      if (c.userData.bake || c.userData.keep) continue;
      if (c.isMesh && c.geometry) parts.push(c);
      else if (!c.isSprite) visit(c);
    }
  };
  visit(g);
  if (!parts.length) return g;
  let sig = '';
  for (const c of parts) {
    _rel.multiplyMatrices(_inv, c.matrixWorld);
    const e = _rel.elements;
    sig += `${c.geometry.uuid}|${isPlainToon(c.material) ? 'c' + c.material.color.getHex() : c.material.uuid}`;
    for (let i = 0; i < 16; i++) sig += `,${Math.round(e[i] * 10000)}`;
    sig += ';';
  }
  const hit = bakeCache.get(sig);
  for (const c of parts) c.parent.remove(c);
  if (hit) {
    bakeStats.hit++;
    for (const b of hit) g.add(new THREE.Mesh(b.geo, b.mat));
    return g;
  }
  bakeStats.miss++;
  const buckets = new Map();
  for (const c of parts) {
    const plain = isPlainToon(c.material);
    const key = plain ? 'vc' : c.material.uuid;
    let b = buckets.get(key);
    if (!b) { b = { mat: plain ? vcMat : c.material, plain, pos: [], nor: [], col: [] }; buckets.set(key, b); }
    const geo = c.geometry.index ? c.geometry.toNonIndexed() : c.geometry.clone();
    geo.applyMatrix4(_rel.multiplyMatrices(_inv, c.matrixWorld));
    b.pos.push(geo.attributes.position.array);
    b.nor.push(geo.attributes.normal.array);
    if (plain) {
      const n = geo.attributes.position.count;
      const arr = new Float32Array(n * 3);
      const col = c.material.color;
      for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
      b.col.push(arr);
    }
    geo.dispose();
  }
  const cat = (arrs) => {
    let n = 0;
    for (const a of arrs) n += a.length;
    const out = new Float32Array(n);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  };
  const made = [];
  for (const b of buckets.values()) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cat(b.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(cat(b.nor), 3));
    if (b.plain) geo.setAttribute('color', new THREE.BufferAttribute(cat(b.col), 3));
    geo.computeBoundingSphere();
    geo.userData.baked = true;
    made.push({ geo, mat: b.mat });
    g.add(new THREE.Mesh(geo, b.mat));
  }
  if (bakeCache.size < BAKE_CACHE_MAX) {
    for (const b of made) b.geo.userData.shared = true;
    bakeCache.set(sig, made);
  }
  return g;
}

/** Free a model's own GPU geometry (the shared baked geometry stays: other models use it). */
export function disposeModel(root) {
  root.traverse((o) => {
    if (o.isMesh && o.geometry.userData.baked && !o.geometry.userData.shared) o.geometry.dispose();
  });
}

/** Bake every flagged group in a finished model. */
export function bakeAll(root) {
  root.updateMatrixWorld(true);
  const list = [];
  root.traverse((o) => { if (o.userData.bake) list.push(o); });
  for (const g of list) bakeGroup(g);
  return root;
}

const DARK = 0x2b2438;
const WHITE = 0xffffff;
const PI = Math.PI;
const lerp = (a, b, k) => a + (b - a) * k;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function eyePair(parent, y, z, dx, r, look = 0) {
  const white = toon(WHITE);
  const dark = basic(DARK);
  for (const s of [-1, 1]) {
    add(parent, G.sphereXS, white, s * dx, y, z, { s: r });
    add(parent, G.sphereXS, dark, s * dx + look * r * 0.3, y, z - r * 0.72, { s: r * 0.55 });
  }
}

function smile(parent, x, y, z, r) {
  const m = add(parent, G.smile, basic(DARK), x, y, z, { s: r });
  m.rotation.z = PI;
  return m;
}

function leafMesh(parent, mat, x, y, z, len, wid, rx, ry, rz) {
  // A leaf: flattened ellipsoid with its long axis along +y before rotation.
  const m = add(parent, G.petal, mat, x, y, z, { sx: wid, sy: len, sz: wid * 0.22 });
  m.rotation.set(rx || 0, ry || 0, rz || 0);
  return m;
}

/* ------------------------------------------------------------------ */
/* weapons                                                             */
/* ------------------------------------------------------------------ */

export const WEAPONS = {
  // plant kids keep one gun all round (the plants themselves are what level up)
  pea_blaster: { name: 'Pea Blaster', rate: 4, proj: 'pea', team: 'plant' },
  // zombie ladder
  goo_blaster: { name: 'Goo Blaster', rate: 3, proj: 'bullet', team: 'zombie' },
  slime_pistol: { name: 'Slime Pistol', rate: 2.5, proj: 'slime', team: 'zombie' },
  zombie_rifle: { name: 'Zombie Rifle', rate: 6, proj: 'bullet', team: 'zombie' },
  bone_burst: { name: 'Bone Burst', rate: 1.6, proj: 'bone', team: 'zombie' },
  zombie_shotgun: { name: 'Zombie Shotgun', rate: 1.2, proj: 'bullet', team: 'zombie' },
  sludge_sprayer: { name: 'Sludge Sprayer', rate: 14, proj: 'sludge', team: 'zombie' },
  brain_cannon: { name: 'Brain Cannon', rate: 0.7, proj: 'brain', team: 'zombie' },
  auto_shot_rifle: { name: 'Auto-Shot Rifle', rate: 12, proj: 'bullet', team: 'zombie' },
};

/** Replace the built-in weapon table with the server's (names / fire rates / projectile kinds). */
export function setWeaponTable(weapons) {
  if (!weapons || typeof weapons !== 'object') return;
  for (const team of ['plant', 'zombie']) {
    const list = weapons[team];
    if (!Array.isArray(list)) continue;
    for (const w of list) {
      if (!w || typeof w.id !== 'string') continue;
      WEAPONS[w.id] = {
        name: typeof w.name === 'string' ? w.name : w.id,
        rate: typeof w.rate === 'number' && w.rate > 0 ? w.rate : 3,
        proj: typeof w.projKind === 'string' ? w.projKind : team === 'zombie' ? 'bullet' : 'pea',
        team,
      };
    }
  }
}

export function weaponInfo(id, team) {
  const w = WEAPONS[id];
  if (w) return w;
  const pretty = typeof id === 'string' && id
    ? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : team === 'zombie' ? 'Goo Blaster' : 'Pea Blaster';
  return { name: pretty, rate: team === 'zombie' ? 3 : 4, proj: team === 'zombie' ? 'bullet' : 'pea', team };
}

/* ---- garage equipment (names / one-line blurbs; the server's table wins when it arrives) ---- */

export const ITEMS = {
  weed_eater: { name: 'Weed Eater', blurb: 'Shreds plants up close. Tiny range, no protection.' },
  leaf_blower: { name: 'Leaf Blower', blurb: 'Blows plants away and swats peas. Hardly hurts.' },
  hedge_trimmer: { name: 'Hedge Trimmer', blurb: 'Wilts plants fast, but you walk slower.' },
  wheelbarrow: { name: 'Wheelbarrow', blurb: 'A rolling shield! Can\'t attack, and you walk slower.' },
};

export function setEquipmentTable(eq) {
  if (!eq || typeof eq !== 'object') return;
  for (const [id, v] of Object.entries(eq)) {
    if (!v || typeof v !== 'object') continue;
    const prev = ITEMS[id] || {};
    ITEMS[id] = {
      name: typeof v.name === 'string' && v.name ? v.name : prev.name || prettyId(id),
      blurb: typeof v.blurb === 'string' ? v.blurb : prev.blurb || '',
      needs: typeof v.needs === 'string' ? v.needs : undefined, // the part that powers it
    };
  }
}

function prettyId(id) {
  return String(id).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ---- mower parts ---- */

export const PART_INFO = {
  battery: { name: 'Battery', icon: '\u{1F50B}', color: 0x66bb6a },
  gas: { name: 'Gas Can', icon: '\u26FD', color: 0xe53935 },
  plug: { name: 'Spark Plug', icon: '\u{1F50C}', color: 0xeceff1 },
};

/** A little glowing part (battery, gas can, spark plug) about 0.5 m tall, origin at its middle. Shared by pickups, carried icons and rack markers. */
export function makePartMesh(kind) {
  const g = new THREE.Group();
  if (kind === 'battery') {
    add(g, G.cylLo, toon(0x455a64), 0, 0, 0, { sx: 0.17, sy: 0.4, sz: 0.17 });
    add(g, G.cylLo, toon(0x66bb6a), 0, 0.03, 0, { sx: 0.18, sy: 0.22, sz: 0.18 });
    add(g, G.cylLo, toon(0xffd54f), 0, 0.23, 0, { sx: 0.07, sy: 0.07, sz: 0.07 });
    add(g, G.box, basic(0xffffff), 0, 0.03, -0.185, { sx: 0.1, sy: 0.03, sz: 0.02 });
    add(g, G.box, basic(0xffffff), 0, 0.03, -0.185, { sx: 0.03, sy: 0.1, sz: 0.02 });
  } else if (kind === 'gas') {
    add(g, G.box, toon(0xe53935), 0, -0.02, 0, { sx: 0.34, sy: 0.38, sz: 0.2 });
    add(g, G.box, toon(0xb71c1c), 0, -0.02, 0, { sx: 0.36, sy: 0.06, sz: 0.22 });
    add(g, G.cylLo, toon(0xffd54f), 0.1, 0.24, 0, { sx: 0.05, sy: 0.12, sz: 0.05 });
    add(g, G.box, toon(0xb71c1c), -0.09, 0.2, 0, { sx: 0.14, sy: 0.03, sz: 0.05 });
    add(g, G.box, basic(0xffeb3b), 0, -0.02, -0.105, { sx: 0.16, sy: 0.16, sz: 0.02 });
  } else {
    add(g, G.cylLo, toon(0xeceff1), 0, 0.06, 0, { sx: 0.07, sy: 0.3, sz: 0.07 });
    add(g, G.cylLo, toon(0xb0bec5), 0, -0.12, 0, { sx: 0.12, sy: 0.1, sz: 0.12 });
    add(g, G.cylLo, toon(0xcfd8dc), 0, -0.2, 0, { sx: 0.04, sy: 0.1, sz: 0.04 });
    add(g, G.cylLo, toon(0x607d8b), 0, 0.23, 0, { sx: 0.045, sy: 0.08, sz: 0.045 });
    add(g, G.torus, toon(0x37474f), 0, 0.3, 0, { sx: 0.07, sy: 0.07, sz: 0.07, rx: PI / 2 });
  }
  g.userData.bake = true;
  bakeGroup(g); // a handful of meshes become two
  return g;
}

function buildPart(e) {
  const root = new THREE.Group();
  const kind = PART_INFO[e.partKind] ? e.partKind : 'battery';
  const body = new THREE.Group();
  const mesh = makePartMesh(kind);
  mesh.scale.setScalar(1.7);
  body.add(mesh);
  root.add(body);
  const tex = getGlowTex();
  if (tex) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: PART_INFO[kind].color, transparent: true, depthWrite: false, opacity: 0.8 }));
    sp.scale.setScalar(1.9);
    body.add(sp);
  }
  const seed = (hash(e.id) % 628) / 100;
  return {
    root,
    tagY: 0,
    kick() {},
    update(c) {
      body.position.y = 0.75 + Math.sin(c.t * 2.2 + seed) * 0.1;
      body.rotation.y = c.t * 1.4 + seed;
    },
  };
}

export function itemInfo(id) {
  return ITEMS[id] || { name: prettyId(id || 'Tool'), blurb: '' };
}

let melonMat = null;
/** Striped watermelon skin (cached; falls back to plain green without a DOM). */
export function melonMaterial() {
  if (melonMat) return melonMat;
  if (typeof document === 'undefined') return (melonMat = toon(0x4caf50));
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 64;
  const c = cv.getContext('2d');
  c.fillStyle = '#7fd957';
  c.fillRect(0, 0, 128, 64);
  c.fillStyle = '#2b8a3e';
  for (let x = 0; x < 128; x += 16) {
    c.beginPath();
    c.moveTo(x, 0);
    for (let y = 0; y <= 64; y += 8) c.lineTo(x + 4 + Math.sin(y * 0.3 + x) * 2.2, y);
    for (let y = 64; y >= 0; y -= 8) c.lineTo(x + 11 + Math.sin(y * 0.3 + x) * 2.2, y);
    c.closePath();
    c.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  melonMat = new THREE.MeshToonMaterial({ map: tex, gradientMap });
  return melonMat;
}

/**
 * Held gun. Barrel points along -z, grip at origin. userData.muzzle is the muzzle point.
 */
export function makeGun(id, team) {
  const g = new THREE.Group();
  const muzzle = new THREE.Object3D();
  g.add(muzzle);
  const cyl = (parent, mat, x, y, z, r, len) =>
    add(parent, G.cyl, mat, x, y, z, { sx: r, sy: len, sz: r, rx: PI / 2 });
  // The one plant gun. Also what any unknown plant-team id falls back to.
  const peaBlaster = () => {
    const pod = toon(0x7ed957), pea = toon(0xb9f57d), barrel = toon(0x2e7d32), grip = toon(0x8d5a2b);
    add(g, G.sphereLo, pod, 0, 0, -0.16, { sx: 0.085, sy: 0.085, sz: 0.3 });
    for (let i = 0; i < 3; i++) add(g, G.sphereXS, pea, 0, 0.085, -0.04 - i * 0.12, { s: 0.052 });
    cyl(g, barrel, 0, 0, -0.44, 0.04, 0.26);
    add(g, G.torus, toon(0xffe066), 0, 0, -0.57, { s: 0.055 });
    add(g, G.box, grip, 0, -0.11, 0.02, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
    muzzle.position.set(0, 0, -0.6);
  };
  switch (id) {
    case 'pea_blaster':
      peaBlaster();
      break;
    case 'zombie_rifle': {
      const body = toon(0x8a9a72), band = toon(0x7e57c2), bandage = toon(0xf1ecd6);
      add(g, G.sphereLo, body, 0, 0, -0.2, { sx: 0.075, sy: 0.09, sz: 0.4 });
      cyl(g, toon(0x5d6b4a), 0, 0, -0.62, 0.04, 0.46);
      add(g, G.torus, bandage, 0, 0, -0.3, { s: 0.095 });
      add(g, G.torus, bandage, 0, 0, -0.1, { s: 0.095 });
      add(g, G.box, band, 0, 0.09, -0.42, { sx: 0.03, sy: 0.04, sz: 0.2 });
      // goofy eyeball sight
      add(g, G.sphereXS, toon(WHITE), 0, 0.14, -0.2, { s: 0.06 });
      add(g, G.sphereXS, basic(0x7cb342), 0, 0.14, -0.255, { s: 0.032 });
      add(g, G.sphereXS, basic(DARK), 0, 0.14, -0.27, { s: 0.018 });
      add(g, G.torus, toon(0x7e57c2), 0, 0, -0.85, { s: 0.055 });
      add(g, G.box, toon(0x5d4037), 0, -0.11, 0.0, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.9);
      break;
    }
    case 'zombie_shotgun': {
      const barrel = toon(0x6a4c93), bone = toon(0xf3efdc);
      for (const s of [-1, 1]) cyl(g, barrel, s * 0.04, 0, -0.32, 0.045, 0.7);
      add(g, G.box, toon(0x4a3470), 0, 0, 0.02, { sx: 0.13, sy: 0.12, sz: 0.2 });
      for (let i = 0; i < 4; i++) add(g, G.box, bone, 0, 0.065, -0.1 - i * 0.12, { sx: 0.1, sy: 0.02, sz: 0.04 });
      add(g, G.sphereLo, bone, 0, -0.1, -0.42, { sx: 0.05, sy: 0.04, sz: 0.1 }); // bone pump
      add(g, G.torus, toon(0x9ccc65), -0.04, 0, -0.67, { s: 0.05 });
      add(g, G.torus, toon(0x9ccc65), 0.04, 0, -0.67, { s: 0.05 });
      add(g, G.box, toon(0x5d4037), 0, -0.11, 0.06, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.72);
      break;
    }
    case 'auto_shot_rifle': {
      const body = toon(0x5e3a96), glow = basic(0x9cff57), metal = toon(0x3b2763);
      add(g, G.box, body, 0, 0, -0.1, { sx: 0.13, sy: 0.14, sz: 0.5 });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * PI * 2;
        cyl(g, metal, Math.cos(a) * 0.04, Math.sin(a) * 0.04, -0.6, 0.032, 0.5);
      }
      add(g, G.torus, toon(0x9cff57), 0, 0, -0.85, { s: 0.075 });
      const drum = add(g, G.cyl, glow, 0, -0.14, -0.1, { sx: 0.1, sy: 0.1, sz: 0.1, rz: PI / 2 });
      drum.scale.set(0.1, 0.1, 0.1);
      add(g, G.torus, metal, 0.055, -0.14, -0.1, { s: 0.1 }).rotation.y = PI / 2;
      add(g, G.torus, metal, -0.055, -0.14, -0.1, { s: 0.1 }).rotation.y = PI / 2;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * PI * 2 + 0.4;
        add(g, G.coneLo, toon(0xf3efdc), Math.cos(a) * 0.075, 0.09 + Math.sin(a) * 0.03, -0.3 + i * 0.08, { sx: 0.02, sy: 0.07, sz: 0.02 });
      }
      add(g, G.box, toon(0x5d4037), 0, -0.12, 0.1, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.9);
      break;
    }
    case 'slime_pistol': {
      const body = toon(0x7e57c2), slide = toon(0x5e3a96), lime = toon(0xb6ff3c);
      add(g, G.box, body, 0, 0, -0.1, { sx: 0.085, sy: 0.1, sz: 0.28 });
      add(g, G.box, slide, 0, 0.065, -0.14, { sx: 0.07, sy: 0.04, sz: 0.3 });
      cyl(g, toon(0x4a3470), 0, 0, -0.32, 0.034, 0.16);
      add(g, G.torus, lime, 0, 0, -0.4, { s: 0.045 });
      // slime flask on top
      add(g, G.sphere, basic(0xb6ff3c, { transparent: true, opacity: 0.85 }), 0, 0.14, -0.08, { s: 0.07 });
      add(g, G.cylLo, toon(0x4a3470), 0, 0.2, -0.08, { sx: 0.035, sy: 0.04, sz: 0.035 });
      add(g, G.sphereXS, basic(0xf4ffc0), 0.02, 0.15, -0.06, { s: 0.018 });
      add(g, G.sphereXS, basic(0xf4ffc0), -0.025, 0.12, -0.1, { s: 0.012 });
      add(g, G.sphereXS, lime, 0.012, -0.045, -0.39, { sx: 0.018, sy: 0.03, sz: 0.018 }); // drip
      add(g, G.box, toon(0x5d4037), 0, -0.1, 0.03, { sx: 0.05, sy: 0.14, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.43);
      break;
    }
    case 'bone_burst': {
      const bone = toon(0xf3efdc), boneD = toon(0xd9d0b0), dark = toon(0x3b2763), glow = basic(0xff3ccf);
      add(g, G.box, dark, 0, 0, -0.02, { sx: 0.15, sy: 0.12, sz: 0.24 });
      for (const [bx, by] of [[0, 0.04], [-0.047, -0.03], [0.047, -0.03]]) {
        cyl(g, bone, bx, by, -0.4, 0.03, 0.62);
        for (const k of [-0.014, 0.014]) {
          add(g, G.sphereXS, boneD, bx + k, by, -0.72, { s: 0.036 });
          add(g, G.sphereXS, boneD, bx + k, by, -0.1, { s: 0.036 });
        }
      }
      add(g, G.torus, glow, 0, 0.0, -0.76, { s: 0.085 });
      // little skull on top
      add(g, G.sphereLo, bone, 0, 0.13, -0.04, { sx: 0.07, sy: 0.065, sz: 0.07 });
      add(g, G.box, bone, 0, 0.09, -0.1, { sx: 0.05, sy: 0.03, sz: 0.04 });
      for (const sx of [-1, 1]) add(g, G.sphereXS, basic(DARK), sx * 0.028, 0.14, -0.105, { s: 0.02 });
      add(g, G.box, toon(0x5d4037), 0, -0.1, 0.03, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.8);
      break;
    }
    case 'sludge_sprayer': {
      const body = toon(0x4a1a7a), tank = toon(0x8e44ad), warn = toon(0xffd600), metal = toon(0x2a1a44);
      add(g, G.sphereLo, body, 0, 0, -0.1, { sx: 0.1, sy: 0.1, sz: 0.3 });
      cyl(g, metal, 0, 0, -0.38, 0.055, 0.3);
      add(g, G.cone, warn, 0, 0, -0.6, { sx: 0.13, sy: 0.18, sz: 0.13, rx: PI / 2 });
      add(g, G.torus, toon(0xa855f7), 0, 0, -0.69, { s: 0.125 });
      // big sloshing tank on top
      add(g, G.cyl, tank, 0, 0.17, -0.12, { sx: 0.1, sy: 0.4, sz: 0.1, rx: PI / 2 });
      add(g, G.sphereLo, tank, 0, 0.17, 0.08, { s: 0.1 });
      add(g, G.sphereLo, tank, 0, 0.17, -0.32, { s: 0.1 });
      for (const z of [-0.2, -0.04]) add(g, G.torus, warn, 0, 0.17, z, { s: 0.105 });
      add(g, G.sphereXS, basic(0xd9a7ff), 0.05, 0.22, -0.12, { s: 0.02 });
      add(g, G.cylLo, metal, 0, 0.1, -0.12, { sx: 0.02, sy: 0.08, sz: 0.02 }); // feed tube
      add(g, G.sphereXS, tank, 0.02, -0.07, -0.66, { sx: 0.02, sy: 0.04, sz: 0.02 }); // drip
      add(g, G.box, toon(0x5d4037), 0, -0.11, 0.02, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.75);
      break;
    }
    case 'brain_cannon': {
      const pink = toon(0xff8fb8), deep = toon(0xff5c98), light = toon(0xffc2d9);
      cyl(g, pink, 0, 0, -0.32, 0.11, 0.62);
      add(g, G.cone, deep, 0, 0, -0.72, { sx: 0.19, sy: 0.18, sz: 0.19, rx: PI / 2 });
      add(g, G.torus, light, 0, 0, -0.8, { s: 0.19 });
      for (const z of [-0.1, -0.3]) add(g, G.torus, deep, 0, 0, z, { s: 0.118 });
      // a brain sits on top
      for (const sx of [-1, 1]) add(g, G.sphereLo, light, sx * 0.04, 0.18, -0.12, { sx: 0.075, sy: 0.07, sz: 0.1 });
      const rnd = mulberry(23);
      for (let i = 0; i < 8; i++) {
        const a = rnd() * PI * 2;
        add(g, G.sphereXS, deep, Math.cos(a) * 0.08, 0.2 + Math.sin(a) * 0.045, -0.12 + (rnd() - 0.5) * 0.12, { s: 0.028 });
      }
      add(g, G.box, deep, 0, 0.215, -0.12, { sx: 0.012, sy: 0.02, sz: 0.16 });
      // googly eye on the side
      add(g, G.sphereXS, toon(WHITE), 0.1, 0.02, -0.08, { s: 0.05 });
      add(g, G.sphereXS, basic(DARK), 0.14, 0.02, -0.085, { s: 0.025 });
      add(g, G.sphereLo, pink, 0, 0, 0.1, { sx: 0.1, sy: 0.1, sz: 0.1 });
      add(g, G.box, toon(0x5d4037), 0, -0.13, 0.03, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.92);
      break;
    }
    case 'goo_blaster':
    default: {
      if (team === 'plant') { peaBlaster(); break; }
      const body = toon(0x7e57c2);
      const goo = basic(0x9cff57);
      add(g, G.sphereLo, body, 0, 0, -0.14, { sx: 0.09, sy: 0.09, sz: 0.26 });
      const jar = add(g, G.sphereXS, goo, 0, 0.1, -0.1, { s: 0.065 });
      jar.material = basic(0x9cff57, { transparent: true, opacity: 0.9 });
      cyl(g, toon(0x4a3470), 0, 0, -0.36, 0.05, 0.22);
      add(g, G.cyl, toon(0x4a3470), 0, 0, -0.5, { sx: 0.075, sy: 0.05, sz: 0.075, rx: PI / 2 });
      add(g, G.sphereXS, goo, 0.02, -0.06, -0.52, { s: 0.022 }); // drip
      add(g, G.sphereXS, goo, -0.015, -0.09, -0.5, { s: 0.015 });
      add(g, G.box, toon(0x5d4037), 0, -0.11, 0.02, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.56);
      break;
    }
  }
  g.userData.muzzle = muzzle;
  return bakeGroup(g);
}

export function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* garage equipment                                                    */
/* ------------------------------------------------------------------ */

/**
 * Held tool. Like a gun: rear grip at the origin, the business end points along -z, and a front
 * handle sits near z = -0.36 so the first-person hands (makeHands) hold it. The wheelbarrow is the
 * odd one out: its handle grips are at (+-0.3, 1.0, 0) and the barrow stretches ~2 m ahead.
 * Returns { root, id, update({ t, dt, using, speed }) }.
 */
export function makeItem(id) {
  const root = new THREE.Group();
  const body = bgroup(root);
  const dark = toon(0x37474f), steel = toon(0xcfd8dc);
  let upd = null;
  switch (id) {
    case 'weed_eater': {
      const red = toon(0xe53935), yel = toon(0xffd54f);
      body.rotation.x = -0.1;
      add(body, G.box, red, 0, 0, 0.12, { sx: 0.1, sy: 0.11, sz: 0.24 });
      add(body, G.box, yel, 0, 0.06, 0.12, { sx: 0.105, sy: 0.018, sz: 0.24 });
      add(body, G.cylLo, dark, 0, 0.075, 0.2, { sx: 0.035, sy: 0.04, sz: 0.035 });
      add(body, G.cyl, steel, 0, -0.01, -0.62, { sx: 0.026, sy: 1.0, sz: 0.026, rx: PI / 2 });
      add(body, G.torus, dark, 0, -0.08, 0.06, { s: 0.06 }).rotation.y = PI / 2;
      add(body, G.cylLo, dark, 0, 0.03, -0.5, { sx: 0.03, sy: 0.17, sz: 0.03 });
      add(body, G.box, toon(0x607d8b), 0, 0.06, -1.14, { sx: 0.34, sy: 0.02, sz: 0.2 }); // guard
      const headTilt = kgroup(body, 0, -0.01, -1.14); // tipped up at the front so the spinning head reads from behind
      headTilt.rotation.x = 0.45;
      const head = group(headTilt);
      add(head, G.cylLo, yel, 0, 0, 0, { sx: 0.06, sy: 0.04, sz: 0.06 });
      const str = basic(0xd7ffd0);
      for (let i = 0; i < 2; i++) add(head, G.box, str, 0, 0, 0, { sx: 0.7, sy: 0.01, sz: 0.018, ry: (i * PI) / 2 });
      const blur = add(head, G.circle, basic(0xd7ffd0, { transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }), 0, 0, 0, { s: 0.35 });
      blur.rotation.x = -PI / 2;
      blur.visible = false;
      upd = (c) => {
        head.rotation.y += c.dt * (c.using ? 55 : 1.2);
        blur.visible = c.using;
        body.position.x = c.using ? Math.sin(c.t * 95) * 0.004 : 0;
        body.position.y = c.using ? Math.cos(c.t * 83) * 0.004 : 0;
      };
      break;
    }
    case 'leaf_blower': {
      const org = toon(0xff7043), gray = toon(0x90a4ae), yel = toon(0xffd54f);
      add(body, G.sphereLo, org, 0, 0, 0.02, { sx: 0.1, sy: 0.11, sz: 0.17 });
      add(body, G.torus, dark, 0.09, 0, 0.02, { s: 0.07 }).rotation.y = PI / 2;
      add(body, G.cyl, gray, 0, -0.01, -0.5, { sx: 0.062, sy: 0.64, sz: 0.062, rx: PI / 2 });
      add(body, G.cone, gray, 0, -0.01, -0.9, { sx: 0.11, sy: 0.17, sz: 0.11, rx: PI / 2 });
      add(body, G.torus, yel, 0, -0.01, -0.34, { s: 0.066 });
      add(body, G.torus, yel, 0, -0.01, -0.62, { s: 0.066 });
      add(body, G.box, dark, 0, 0.1, -0.02, { sx: 0.04, sy: 0.04, sz: 0.18 });
      add(body, G.cylLo, dark, 0, -0.04, -0.5, { sx: 0.03, sy: 0.16, sz: 0.03 });
      add(body, G.cylLo, dark, 0, -0.13, 0.03, { sx: 0.03, sy: 0.1, sz: 0.03 });
      const fan = kgroup(body, 0.1, 0, 0.02);
      for (let i = 0; i < 3; i++) add(fan, G.box, basic(0xeceff1), 0, 0, 0, { sx: 0.01, sy: 0.12, sz: 0.03, rx: (i * PI) / 3 });
      upd = (c) => {
        fan.rotation.x += c.dt * (c.using ? 50 : 3);
        body.position.y = c.using ? Math.sin(c.t * 70) * 0.005 : 0;
        body.position.x = c.using ? Math.cos(c.t * 61) * 0.004 : 0;
      };
      break;
    }
    case 'hedge_trimmer': {
      const yel = toon(0xfdd835), blade = toon(0xb0bec5), tooth = toon(0xeceff1), org = toon(0xff7043);
      add(body, G.box, yel, 0, 0, -0.04, { sx: 0.09, sy: 0.1, sz: 0.3 });
      add(body, G.box, dark, 0, 0.065, 0.0, { sx: 0.04, sy: 0.025, sz: 0.2 });
      add(body, G.torus, dark, 0, 0.1, 0.06, { s: 0.05 }).rotation.y = PI / 2;
      add(body, G.cylLo, dark, 0, 0.04, -0.5, { sx: 0.03, sy: 0.16, sz: 0.03 });
      add(body, G.box, blade, 0, -0.04, -1.05, { sx: 0.06, sy: 0.02, sz: 1.02 });
      add(body, G.box, org, 0, -0.04, -1.56, { sx: 0.12, sy: 0.03, sz: 0.03 });
      for (let i = 0; i < 11; i++) {
        const z = -0.6 - i * 0.09;
        for (const s of [-1, 1]) add(body, G.box, blade, s * 0.065, -0.04, z, { sx: 0.075, sy: 0.02, sz: 0.05 });
      }
      const teeth = kgroup(body, 0, 0, 0);
      for (let i = 0; i < 11; i++) {
        const z = -0.645 - i * 0.09;
        for (const s of [-1, 1]) add(teeth, G.box, tooth, s * 0.065, -0.03, z, { sx: 0.07, sy: 0.018, sz: 0.044 });
      }
      upd = (c) => {
        teeth.position.z = c.using ? Math.sin(c.t * 110) * 0.03 : 0;
        body.position.y = c.using ? Math.sin(c.t * 77) * 0.004 : 0;
      };
      break;
    }
    case 'wheelbarrow': {
      // Compact and chunky: the server's shield box sits 1.1 m ahead of the holder, 1.8 m wide, 1.2 m high.
      const blue = toon(0x1e88e5), blueD = toon(0x1565c0), wood = toon(0xc8955a), woodD = toon(0x8d5a2b), yel = toon(0xffd54f);
      for (const s of [-1, 1]) {
        // handles run from the grips down to the tray
        const h = add(body, G.cyl, wood, s * 0.3, 0.82, -0.17, { sx: 0.03, sy: 0.5, sz: 0.03 });
        h.rotation.x = 0.7;
        add(body, G.cylLo, yel, s * 0.3, 1.0, 0.03, { sx: 0.04, sy: 0.16, sz: 0.04, rx: PI / 2 });
        const leg = add(body, G.cyl, woodD, s * 0.45, 0.25, -0.5, { sx: 0.03, sy: 0.5, sz: 0.03 });
        leg.rotation.x = 0.12;
      }
      // tray
      add(body, G.box, blue, 0, 0.52, -0.6, { sx: 1.1, sy: 0.08, sz: 0.7 });
      for (const s of [-1, 1]) add(body, G.box, blueD, s * 0.6, 0.7, -0.6, { sx: 0.06, sy: 0.4, sz: 0.74, rz: s * -0.3 });
      add(body, G.box, blueD, 0, 0.7, -0.25, { sx: 1.16, sy: 0.4, sz: 0.06, rx: 0.2 });
      add(body, G.sphereLo, toon(0x6d4430), 0, 0.62, -0.6, { sx: 0.4, sy: 0.14, sz: 0.28 }); // a heap of dirt
      // wooden plank shield across the front
      for (let i = 0; i < 2; i++) add(body, G.box, i ? wood : toon(0xd9a86c), 0, 0.78 + i * 0.3, -0.98, { sx: 1.7, sy: 0.29, sz: 0.07 });
      for (const s of [-1, 1]) add(body, G.box, woodD, s * 0.8, 0.9, -1.02, { sx: 0.1, sy: 0.72, sz: 0.05 });
      add(body, G.box, woodD, 0, 0.9, -1.03, { sx: 1.7, sy: 0.04, sz: 0.04 });
      for (const s of [-1, 1]) for (const y of [0.78, 1.08]) add(body, G.sphereXS, steel, s * 0.8, y, -1.06, { s: 0.028 });
      // wheel peeks out below the planks
      const wheel = kgroup(body, 0, 0.3, -0.85);
      add(wheel, G.cyl, basic(0x263238), 0, 0, 0, { sx: 0.3, sy: 0.14, sz: 0.3, rz: PI / 2 });
      add(wheel, G.cyl, steel, 0, 0, 0, { sx: 0.18, sy: 0.16, sz: 0.18, rz: PI / 2 });
      for (let i = 0; i < 3; i++) add(wheel, G.box, yel, 0, 0, 0, { sx: 0.17, sy: 0.04, sz: 0.38, rx: (i * PI) / 3 });
      let spin = 0;
      upd = (c) => {
        spin += (c.speed * c.dt) / 0.3;
        wheel.rotation.x = -spin;
        body.position.y = c.speed > 0.5 ? Math.abs(Math.sin(c.t * 9)) * 0.012 : 0;
      };
      break;
    }
    default: {
      // unknown tool: a plain wooden stick so nothing throws
      add(body, G.cyl, toon(0xc8955a), 0, 0, -0.4, { sx: 0.03, sy: 0.9, sz: 0.03, rx: PI / 2 });
      add(body, G.sphereLo, toon(0x8bd450), 0, 0, -0.86, { s: 0.07 });
    }
  }
  bakeAll(root);
  return { root, id, update: upd || (() => {}) };
}

/** Backpack part of a tool as seen on a zombie's back (leaf blower only). Returns a Group or null. */
export function makeItemBack(id) {
  if (id !== 'leaf_blower') return null;
  const g = bgroup(null);
  add(g, G.cyl, toon(0xff7043), 0, 0, 0, { sx: 0.17, sy: 0.5, sz: 0.15 });
  add(g, G.sphereLo, toon(0xff7043), 0, 0.26, 0, { sx: 0.17, sy: 0.08, sz: 0.15 });
  add(g, G.torus, toon(0xffd54f), 0, 0.1, 0, { s: 0.175 }).rotation.x = PI / 2;
  add(g, G.torus, toon(0xffd54f), 0, -0.12, 0, { s: 0.175 }).rotation.x = PI / 2;
  add(g, G.cylLo, toon(0x37474f), 0.22, 0.05, -0.1, { sx: 0.035, sy: 0.3, sz: 0.035, rz: -0.9 });
  return bakeAll(g);
}

/** Pair of first-person hands. specs: [[x, y, z, dirX, dirY, dirZ], ...] (hand position, arm direction). */
export function makeHands(team, specs) {
  const h = new THREE.Group();
  const skin = team === 'zombie' ? toon(0x9ccc65) : toon(0x7ed957);
  const sleeve = team === 'zombie' ? toon(0xff8a65) : toon(0x43a047);
  const up = new THREE.Vector3(0, 1, 0);
  for (const [hx, hy, hz, dx, dy, dz] of specs) {
    add(h, G.sphere, skin, hx, hy, hz, { s: 0.048 });
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const len = 0.55;
    const sleeveMesh = add(h, G.cyl, sleeve, hx + dir.x * len * 0.62, hy + dir.y * len * 0.62, hz + dir.z * len * 0.62, { sx: 0.05, sy: len * 0.7, sz: 0.05 });
    sleeveMesh.quaternion.setFromUnitVectors(up, dir);
    const wrist = add(h, G.cyl, skin, hx + dir.x * 0.1, hy + dir.y * 0.1, hz + dir.z * 0.1, { sx: 0.04, sy: 0.2, sz: 0.04 });
    wrist.quaternion.setFromUnitVectors(up, dir);
  }
  return h;
}

/** Icy shell + crystals shown around a fighter that a Snow Pea slowed. Built on demand. */
function makeIce() {
  const g = new THREE.Group();
  add(g, capsule(0.5, 0.95), basic(0x8fdcff, { transparent: true, opacity: 0.3, depthWrite: false }), 0, 0.95, 0);
  const crystal = toon(0xdff6ff, { emissive: 0x2a6f9a });
  const r = mulberry(17);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * PI * 2 + r() * 0.5;
    const y = 0.3 + r() * 1.3;
    const dir = new THREE.Vector3(Math.cos(a), 0.5 + r() * 0.4, Math.sin(a)).normalize();
    const c = add(g, G.coneLo, crystal, dir.x * 0.42, y, dir.z * 0.42, { sx: 0.07, sy: 0.3 + r() * 0.2, sz: 0.07 });
    c.quaternion.setFromUnitVectors(up, dir);
  }
  return g;
}

/* ------------------------------------------------------------------ */
/* zombie                                                              */
/* ------------------------------------------------------------------ */

const SKIN = [0x9ccc65, 0x8bc34a, 0xaed581, 0x7cb342, 0xa5d66b];
const SHIRT = [0xff8a65, 0x4fc3f7, 0xba68c8, 0xffd54f, 0xf06292, 0x4db6ac];
const PANTS = [0x5c6bc0, 0x8d6e63, 0x546e7a, 0x7e57c2];

function buildZombie(e) {
  const h = hash(e.id);
  const pick = (arr, shift) => arr[(h >>> shift) % arr.length];
  const mSkin = toon(pick(SKIN, 0));
  const mShirt = toon(pick(SHIRT, 3));
  const mPants = toon(pick(PANTS, 6));
  const mShoe = toon(0x4e342e);
  const seed = (h % 628) / 100;

  const root = new THREE.Group();
  const rig = bgroup(root);
  const legs = [];
  for (const s of [-1, 1]) {
    const p = bgroup(rig, s * 0.15, 0.7, 0);
    add(p, G.cyl, mPants, 0, -0.35, 0, { sx: 0.11, sy: 0.7, sz: 0.11 });
    add(p, G.box, mShoe, 0, -0.66, -0.06, { sx: 0.2, sy: 0.12, sz: 0.34 });
    legs.push(p);
  }
  const body = bgroup(rig, 0, 0.7, 0);
  add(body, G.cyl, mShirt, 0, 0.31, 0, { sx: 0.29, sy: 0.62, sz: 0.2 });
  // ragged hem
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * PI * 2;
    const c = add(body, G.coneLo, mShirt, Math.sin(a) * 0.27, 0.0, Math.cos(a) * 0.19, { sx: 0.075, sy: 0.14, sz: 0.04 });
    c.rotation.x = PI;
  }
  // tie, collar, patch
  const tie = toon(0xe53935);
  add(body, G.box, tie, 0, 0.36, -0.205, { sx: 0.07, sy: 0.3, sz: 0.03 });
  add(body, G.coneLo, tie, 0, 0.17, -0.205, { sx: 0.085, sy: 0.12, sz: 0.025 }).rotation.x = PI;
  add(body, G.box, tie, 0, 0.55, -0.2, { sx: 0.09, sy: 0.07, sz: 0.04 });
  const collar = toon(WHITE);
  add(body, G.box, collar, -0.07, 0.57, -0.19, { sx: 0.11, sy: 0.04, sz: 0.03, rz: 0.5 });
  add(body, G.box, collar, 0.07, 0.57, -0.19, { sx: 0.11, sy: 0.04, sz: 0.03, rz: -0.5 });
  add(body, G.box, toon(0xfff59d), 0.14, 0.18, -0.203, { sx: 0.12, sy: 0.12, sz: 0.012 });
  add(body, G.box, basic(DARK), 0.14, 0.18, -0.21, { sx: 0.09, sy: 0.008, sz: 0.004 });

  // head
  const head = bgroup(body, 0, 0.85, 0);
  add(head, G.sphere, mSkin, 0, 0.0, 0, { sx: 0.3, sy: 0.3, sz: 0.28 });
  for (const s of [-1, 1]) add(head, G.sphereLo, mSkin, s * 0.29, -0.02, 0.02, { sx: 0.06, sy: 0.08, sz: 0.04 });
  // goofy mismatched eyes
  const white = toon(WHITE), dark = basic(DARK);
  add(head, G.sphereLo, white, -0.12, 0.07, -0.2, { s: 0.115 });
  add(head, G.sphereXS, dark, -0.1, 0.05, -0.305, { s: 0.05 });
  add(head, G.sphereXS, white, 0.12, 0.1, -0.2, { s: 0.078 });
  add(head, G.sphereXS, dark, 0.135, 0.12, -0.275, { s: 0.035 });
  add(head, G.sphereLo, mSkin, 0, -0.01, -0.27, { sx: 0.045, sy: 0.04, sz: 0.04 }); // nose
  // wobbly open grin
  add(head, G.sphereLo, basic(0x4a1d3d), 0, -0.13, -0.25, { sx: 0.14, sy: 0.06, sz: 0.03 });
  add(head, G.box, white, -0.05, -0.095, -0.272, { sx: 0.045, sy: 0.04, sz: 0.01 });
  add(head, G.box, white, 0.06, -0.095, -0.272, { sx: 0.04, sy: 0.035, sz: 0.01 });
  add(head, G.sphereLo, toon(0xff8fab), 0, -0.155, -0.268, { sx: 0.05, sy: 0.025, sz: 0.01 }); // tongue
  // headgear / hair
  const hat = (h >>> 9) % 6;
  if (hat <= 1) {
    add(head, G.cone, toon(0xff7a00), 0, 0.42, 0, { sx: 0.2, sy: 0.4, sz: 0.2 });
    add(head, G.cyl, toon(WHITE), 0, 0.38, 0, { sx: 0.17, sy: 0.07, sz: 0.17 }).scale.set(0.17, 0.07, 0.17);
    add(head, G.cyl, toon(0xff7a00), 0, 0.23, 0, { sx: 0.3, sy: 0.04, sz: 0.3 });
  } else if (hat === 2) {
    add(head, G.cyl, toon(0x90a4ae), 0, 0.33, 0, { sx: 0.22, sy: 0.22, sz: 0.22 });
    add(head, G.cyl, toon(0xb0bec5), 0, 0.22, 0, { sx: 0.27, sy: 0.03, sz: 0.27 });
    add(head, G.cyl, toon(0x78909c), 0, 0.44, 0, { sx: 0.2, sy: 0.03, sz: 0.2 });
  } else if (hat === 3) {
    // daisy on the head
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * PI * 2;
      add(head, G.sphereXS, toon(WHITE), Math.cos(a) * 0.075, 0.33 + Math.sin(a) * 0.075 * 0.4, Math.sin(a) * 0.075, { s: 0.055 });
    }
    add(head, G.sphereXS, toon(0xffd600), 0, 0.34, 0, { s: 0.05 });
    add(head, G.cyl, toon(0x4caf50), 0, 0.29, 0, { sx: 0.012, sy: 0.1, sz: 0.012 });
  } else {
    const hair = toon(0x37474f);
    for (let i = 0; i < 4; i++) {
      const c = add(head, G.coneLo, hair, (i - 1.5) * 0.07, 0.3, 0, { sx: 0.03, sy: 0.18 - Math.abs(i - 1.5) * 0.03, sz: 0.03 });
      c.rotation.z = (i - 1.5) * -0.28;
    }
  }

  // arms reaching forward, holding a gun between the hands
  const arms = [];
  for (const s of [-1, 1]) {
    const a = bgroup(body, s * 0.34, 0.52, 0);
    a.rotation.order = 'YXZ';
    add(a, G.cyl, mShirt, 0, -0.14, 0, { sx: 0.085, sy: 0.28, sz: 0.085 });
    add(a, G.cyl, mSkin, 0, -0.38, 0, { sx: 0.07, sy: 0.22, sz: 0.07 });
    add(a, G.sphereLo, mSkin, 0, -0.52, 0, { s: 0.1 });
    a.userData.s = s;
    arms.push(a);
  }
  const gunMount = kgroup(body, 0, 0.5, -0.48);
  let gun = null;
  let gunId = null;
  const setGun = (id) => {
    if (id === gunId) return;
    gunId = id;
    if (gun) gunMount.remove(gun);
    gun = makeGun(id || 'goo_blaster', 'zombie');
    gun.scale.setScalar(0.9);
    gunMount.add(gun);
  };
  setGun(e.weapon);

  // garage equipment: swaps in for the gun while held (built on first use, then just toggled)
  const toolMount = kgroup(body, 0, 0.5, -0.48);
  const barrowMount = kgroup(root, 0, 0, -0.52); // the whole wheelbarrow rides in front, not on the swaying body
  const backMount = kgroup(body, 0, 0.34, 0.28);
  const tools = {};
  let toolId = null;
  const setTool = (id) => {
    if (id === toolId) return;
    if (toolId && tools[toolId]) {
      tools[toolId].model.root.visible = false;
      if (tools[toolId].back) tools[toolId].back.visible = false;
    }
    toolId = id;
    if (!id) return;
    let t = tools[id];
    if (!t) {
      const model = makeItem(id);
      const back = makeItemBack(id);
      (id === 'wheelbarrow' ? barrowMount : toolMount).add(model.root);
      if (back) backMount.add(back);
      t = tools[id] = { model, back };
    }
    t.model.root.visible = true;
    if (t.back) t.back.visible = true;
  };
  let ice = null;

  let phase = seed;
  let kickT = 0;
  return {
    root,
    tagY: hat <= 2 ? 2.7 : 2.3,
    kick() { kickT = 1; },
    update(c) {
      setGun(c.e.weapon);
      const held = typeof c.e.item === 'string' && c.e.item ? c.e.item : null;
      setTool(held);
      gunMount.visible = !held;
      if (held) tools[held].model.update({ t: c.t, dt: c.dt, using: !!c.e.using, speed: c.speed });
      if (c.e.slowed && !ice) { ice = makeIce(); root.add(ice); }
      if (ice) { ice.visible = !!c.e.slowed; ice.rotation.y = c.t * 0.6; }
      const w = clamp01(c.speed / 4);
      phase += c.dt * (2.5 + c.speed * 1.4);
      const sw = Math.sin(phase);
      const ride = c.riding;
      legs[0].rotation.x = ride ? 1.35 : sw * 0.8 * w;
      legs[1].rotation.x = ride ? 1.35 : -sw * 0.8 * w;
      body.rotation.z = Math.sin(phase * 0.5) * 0.12 * w + Math.sin(c.t * 1.7 + seed) * 0.025;
      body.rotation.x = -(0.05 + 0.07 * w);
      body.scale.y = 1 + Math.sin(c.t * 2.2 + seed) * 0.015;
      rig.position.y = (ride ? 0.4 : 0) + Math.abs(sw) * 0.07 * w;
      head.rotation.z = Math.sin(phase * 0.5 + 0.8) * 0.2 * w + Math.sin(c.t * 1.1 + seed) * 0.05;
      head.rotation.x = Math.sin(phase) * 0.06 * w;
      kickT = Math.max(0, kickT - c.dt * 7);
      for (let i = 0; i < 2; i++) {
        const a = arms[i];
        a.rotation.y = a.userData.s * 0.45;
        a.rotation.x = 1.4 + Math.sin(c.t * 3 + i * 2 + seed) * 0.06 + sw * 0.05 * w - kickT * 0.15;
      }
      gunMount.position.z = -0.48 + kickT * 0.1;
    },
  };
}

/* ------------------------------------------------------------------ */
/* plant soldier (sunflower-headed)                                    */
/* ------------------------------------------------------------------ */

function buildSoldier(e) {
  const gardener = e.kind === 'bot'; // the lone computer defender wears a straw hat and carries a watering can
  const h = hash(e.id);
  const seed = (h % 628) / 100;
  const leafG = toon(0x66bb6a), leafD = toon(0x388e3c), boot = toon(0x6d4c41);
  const petalA = toon(0xffd93b), petalB = toon(0xffb300);
  const root = new THREE.Group();
  const rig = bgroup(root);
  const legs = [];
  for (const s of [-1, 1]) {
    const p = bgroup(rig, s * 0.14, 0.62, 0);
    add(p, G.cyl, leafG, 0, -0.31, 0, { sx: 0.085, sy: 0.62, sz: 0.085 });
    add(p, G.box, boot, 0, -0.6, -0.05, { sx: 0.17, sy: 0.12, sz: 0.3 });
    legs.push(p);
  }
  const body = bgroup(rig, 0, 0.62, 0);
  add(body, G.cyl, leafG, 0, 0.3, 0, { sx: 0.24, sy: 0.6, sz: 0.18 });
  add(body, G.cyl, toon(0x8d6e63), 0, 0.04, 0, { sx: 0.255, sy: 0.08, sz: 0.195 });
  add(body, G.box, toon(0xffd54f), 0, 0.04, -0.2, { sx: 0.08, sy: 0.07, sz: 0.02 });
  // leafy vest + shoulder leaves
  add(body, G.cyl, leafD, 0, 0.36, 0, { sx: 0.255, sy: 0.2, sz: 0.195 });
  for (const s of [-1, 1]) leafMesh(body, leafD, s * 0.27, 0.56, 0, 0.14, 0.09, 0, 0, s * -1.0);
  // head: sunflower
  const head = bgroup(body, 0, 0.88, 0);
  head.scale.setScalar(0.85);
  add(head, G.cyl, leafG, 0, -0.3, 0, { sx: 0.05, sy: 0.18, sz: 0.05 }); // neck
  const N = 14;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * PI * 2;
    leafMesh(head, petalB, Math.cos(a) * 0.4, Math.sin(a) * 0.4, 0.04, 0.17, 0.085, 0, 0, a - PI / 2);
  }
  for (let i = 0; i < N; i++) {
    const a = ((i + 0.5) / N) * PI * 2;
    leafMesh(head, petalA, Math.cos(a) * 0.34, Math.sin(a) * 0.34, -0.005, 0.16, 0.085, 0, 0, a - PI / 2);
  }
  const disc = add(head, G.cyl, toon(0x9c6a3c), 0, 0, -0.02, { sx: 0.3, sy: 0.12, sz: 0.3 });
  disc.rotation.x = PI / 2;
  eyePair(head, 0.07, -0.09, 0.1, 0.06);
  smile(head, 0, -0.04, -0.09, 0.1);
  for (const s of [-1, 1]) add(head, G.sphereLo, toon(0xff8a80), s * 0.17, -0.05, -0.09, { sx: 0.05, sy: 0.03, sz: 0.01 });
  if (gardener) {
    const straw = toon(0xe8c46a), strawD = toon(0xc99a3a);
    add(head, G.cyl, straw, 0, 0.6, 0.02, { sx: 0.5, sy: 0.04, sz: 0.5 }).rotation.z = 0.08;
    add(head, G.sphere, straw, 0, 0.66, 0.02, { sx: 0.27, sy: 0.17, sz: 0.27 });
    add(head, G.cyl, toon(0xe53935), 0, 0.63, 0.02, { sx: 0.275, sy: 0.05, sz: 0.275 });
    add(head, G.torus, strawD, 0, 0.6, 0.02, { s: 0.5 }).rotation.x = PI / 2;
    // watering can on the hip
    const can = toon(0x4fc3f7);
    add(body, G.cyl, can, -0.31, 0.02, 0.12, { sx: 0.1, sy: 0.17, sz: 0.1 });
    add(body, G.cone, can, -0.31, 0.04, -0.06, { sx: 0.035, sy: 0.22, sz: 0.035, rx: -1.0 });
    add(body, G.torus, toon(0x0288d1), -0.31, 0.04, 0.2, { s: 0.07 }).rotation.y = PI / 2;
  }
  // sparkly stars for the wilted pose
  const stars = kgroup(head, 0, 0.5, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * PI * 2;
    add(stars, G.sphereXS, basic(0xfff176), Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25, { s: 0.06 });
  }
  stars.visible = false;

  // arms hold the gun forward
  const arms = [];
  for (const s of [-1, 1]) {
    const a = bgroup(body, s * 0.3, 0.5, 0);
    a.rotation.order = 'YXZ';
    add(a, G.cyl, leafG, 0, -0.22, 0, { sx: 0.065, sy: 0.44, sz: 0.065 });
    add(a, G.sphereXS, leafD, 0, -0.46, 0, { s: 0.085 });
    a.userData.s = s;
    arms.push(a);
  }
  const gunMount = kgroup(body, 0.04, 0.46, -0.4);
  let gun = null;
  let gunId = null;
  const setGun = (id) => {
    if (id === gunId) return;
    gunId = id;
    if (gun) gunMount.remove(gun);
    gun = makeGun(id || 'pea_blaster', 'plant');
    gun.scale.setScalar(0.9);
    gunMount.add(gun);
  };
  setGun(e.weapon);
  let ice = null;

  let phase = seed, kickT = 0, down = 0;
  return {
    root,
    tagY: gardener ? 2.7 : 2.35,
    kick() { kickT = 1; },
    update(c) {
      setGun(c.e.weapon);
      if (c.e.slowed && !ice) { ice = makeIce(); root.add(ice); }
      if (ice) { ice.visible = !!c.e.slowed; ice.rotation.y = c.t * 0.6; }
      const wilted = c.state === 'wilted';
      down = lerp(down, wilted ? 1 : 0, clamp01(c.dt * 6));
      const w = clamp01(c.speed / 4) * (1 - down);
      phase += c.dt * (2.8 + c.speed * 1.3);
      const sw = Math.sin(phase);
      legs[0].rotation.x = sw * 0.75 * w;
      legs[1].rotation.x = -sw * 0.75 * w;
      body.rotation.z = Math.sin(phase * 0.5) * 0.06 * w;
      body.rotation.x = -0.04 * w + down * -0.4;
      rig.position.y = Math.abs(sw) * 0.06 * w + down * 0.28;
      rig.rotation.z = down * 1.45;
      rig.position.x = down * 0.55;
      head.rotation.z = Math.sin(c.t * 1.6 + seed) * 0.06 + Math.sin(phase * 0.5) * 0.05 * w + down * 0.5;
      head.rotation.x = down * 0.5;
      head.rotation.y = Math.sin(c.t * 0.9 + seed) * 0.05;
      stars.visible = down > 0.5;
      stars.rotation.y = c.t * 4;
      kickT = Math.max(0, kickT - c.dt * 7);
      for (let i = 0; i < 2; i++) {
        const a = arms[i];
        a.rotation.y = a.userData.s * 0.5;
        a.rotation.x = 1.3 + sw * 0.05 * w - kickT * 0.12;
      }
      gunMount.position.z = -0.4 + kickT * 0.09;
    },
  };
}

/* ------------------------------------------------------------------ */
/* sprout (converted human zombie digging back in)                     */
/* ------------------------------------------------------------------ */

function buildSprout() {
  const root = new THREE.Group();
  root.userData.bake = true;
  add(root, G.sphereLo, toon(0x8a5a3c), 0, 0.0, 0, { sx: 0.55, sy: 0.16, sz: 0.55 });
  add(root, G.sphereLo, toon(0x6d4430), 0, 0.02, 0, { sx: 0.35, sy: 0.14, sz: 0.35 });
  const plant = bgroup(root, 0, 0.05, 0);
  add(plant, G.cyl, toon(0x66bb6a), 0, 0.22, 0, { sx: 0.04, sy: 0.44, sz: 0.04 });
  const leaves = [];
  for (const s of [-1, 1]) {
    const lf = bgroup(plant, 0, 0.44, 0);
    leafMesh(lf, toon(0x8bd450), s * 0.17, 0.04, 0, 0.17, 0.1, 0, 0, s * -1.2);
    leaves.push(lf);
  }
  add(plant, G.sphereXS, toon(0xb9f57d), 0, 0.5, 0, { s: 0.06 });
  eyePair(plant, 0.46, -0.05, 0.035, 0.028);
  return {
    root,
    tagY: 1.2,
    kick() {},
    update(c) {
      const b = Math.sin(c.t * 5) * 0.5 + 0.5;
      plant.scale.y = 1 + b * 0.12;
      plant.scale.x = plant.scale.z = 1 - b * 0.05;
      leaves[0].rotation.z = Math.sin(c.t * 6) * 0.25;
      leaves[1].rotation.z = -Math.sin(c.t * 6) * 0.25;
    },
  };
}

/* ------------------------------------------------------------------ */
/* peashooter turret                                                   */
/* ------------------------------------------------------------------ */

function buildPeashooter(e) {
  const h = hash(e.id);
  const seed = (h % 628) / 100;
  const green = toon(0x7ed321), greenD = toon(0x3e9b2f), greenL = toon(0xa5e84f);
  const root = new THREE.Group();
  root.userData.bake = true;
  // base leaves + stem
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * PI * 2 + 0.5;
    leafMesh(root, greenD, Math.cos(a) * 0.3, 0.12, Math.sin(a) * 0.3, 0.3, 0.14, 0, 0, 0).rotation.set(1.2 * Math.sin(a), 0, -1.2 * Math.cos(a));
  }
  add(root, G.cyl, greenD, 0, 0.4, 0, { sx: 0.09, sy: 0.8, sz: 0.09 });
  const head = bgroup(root, 0, 1.0, 0);
  head.rotation.order = 'YXZ';
  add(head, G.sphere, green, 0, 0, 0, { sx: 0.38, sy: 0.36, sz: 0.38 });
  // mouth tube
  add(head, G.cyl, greenL, 0, -0.02, -0.4, { sx: 0.17, sy: 0.3, sz: 0.17, rx: PI / 2 });
  add(head, G.cyl, basic(0x14471a), 0, -0.02, -0.552, { sx: 0.125, sy: 0.02, sz: 0.125, rx: PI / 2 });
  add(head, G.torus, toon(0xd7f56a), 0, -0.02, -0.55, { s: 0.16 });
  // face
  eyePair(head, 0.12, -0.3, 0.15, 0.085, 0);
  for (const s of [-1, 1]) {
    add(head, G.sphereLo, toon(0xff8a80), s * 0.27, -0.06, -0.24, { sx: 0.06, sy: 0.035, sz: 0.015 }).rotation.y = s * 0.7;
    // eyebrow leaves
    add(head, G.box, basic(0x2e6b22), s * 0.15, 0.24, -0.31, { sx: 0.1, sy: 0.022, sz: 0.01, rz: s * -0.3 });
  }
  // leafy crest
  for (let i = 0; i < 3; i++) {
    leafMesh(head, greenD, (i - 1) * 0.1, 0.38, 0.05 + i * 0.02, 0.2, 0.07, -0.2, 0, (i - 1) * -0.5);
  }
  leafMesh(head, greenD, 0, 0.0, 0.4, 0.17, 0.09, 1.2, 0, 0); // tail leaf

  let kickT = 0;
  return {
    root,
    ownYaw: true,
    tagY: 1.95,
    top: 1.6,
    kick() { kickT = 1; },
    update(c) {
      kickT = Math.max(0, kickT - c.dt * 8);
      head.rotation.set(c.pitch, c.yaw, Math.sin(c.t * 1.8 + seed) * 0.04);
      head.position.y = 1.0 + Math.sin(c.t * 2.4 + seed) * 0.025 - kickT * 0.03;
      const sq = 1 + kickT * 0.1;
      head.scale.set(1 / sq, sq, 1 / sq);
      head.position.z = kickT * 0.07 * Math.cos(c.yaw);
      head.position.x = kickT * 0.07 * Math.sin(c.yaw);
    },
  };
}

/* ------------------------------------------------------------------ */
/* cactus turret                                                       */
/* ------------------------------------------------------------------ */

const capsuleCache = new Map();
function capsule(r, len) {
  const k = r + ':' + len;
  let g = capsuleCache.get(k);
  if (!g) { g = new THREE.CapsuleGeometry(r, len, 3, 10); capsuleCache.set(k, g); }
  return g;
}

function buildCactus(e) {
  const h = hash(e.id);
  const seed = (h % 628) / 100;
  const green = toon(0x43b05a), greenD = toon(0x2b8a45), spike = toon(0xfff6c9), pink = toon(0xff6fa8);
  const root = new THREE.Group();
  const turret = group(root);
  const body = bgroup(turret);
  add(body, capsule(0.33, 0.6), green, 0, 0.63, 0);
  // ridges
  for (const a of [-0.7, 0.7]) {
    add(body, capsule(0.04, 0.8), greenD, Math.sin(a) * 0.335, 0.63, -Math.cos(a) * 0.335);
  }
  // arms
  for (const s of [-1, 1]) {
    const arm = group(body, s * 0.28, s < 0 ? 0.55 : 0.75, 0);
    add(arm, capsule(0.095, 0.2), green, s * 0.14, 0, 0, { rz: PI / 2 });
    add(arm, capsule(0.095, 0.24), green, s * 0.27, 0.2, 0);
    add(arm, G.cone, spike, s * 0.27, 0.45, 0, { sx: 0.03, sy: 0.1, sz: 0.03 });
  }
  // spikes sprinkled on the body (deterministic)
  const rnd = mulberry(3);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 16; i++) {
    const a = rnd() * PI * 2;
    const y = 0.35 + rnd() * 0.65;
    const dir = new THREE.Vector3(Math.sin(a), 0.1, -Math.cos(a)).normalize();
    if (dir.z < -0.5 && y > 0.5 && y < 0.95) continue; // keep the face clear
    const sp = add(body, G.coneLo, spike, dir.x * 0.34, y, dir.z * 0.34, { sx: 0.022, sy: 0.12, sz: 0.022 });
    sp.quaternion.setFromUnitVectors(up, dir);
  }
  // face
  eyePair(body, 0.78, -0.3, 0.12, 0.075);
  smile(body, 0, 0.66, -0.325, 0.09);
  for (const s of [-1, 1]) add(body, G.sphereLo, toon(0xff8a80), s * 0.2, 0.67, -0.28, { sx: 0.06, sy: 0.04, sz: 0.015 }).rotation.y = s * 0.5;
  // flower on top
  const fl = bgroup(body, 0, 1.27, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * PI * 2;
    leafMesh(fl, pink, Math.cos(a) * 0.11, 0.0, Math.sin(a) * 0.11, 0.1, 0.07, 0, 0, 0).rotation.set(Math.sin(a) * -1.1, 0, Math.cos(a) * -1.1);
  }
  add(fl, G.sphereXS, toon(0xffeb3b), 0, 0.02, 0, { s: 0.065 });

  let kickT = 0;
  return {
    root,
    ownYaw: true,
    tagY: 1.95,
    top: 1.45,
    kick() { kickT = 1; },
    update(c) {
      kickT = Math.max(0, kickT - c.dt * 8);
      turret.rotation.y = c.yaw;
      body.rotation.z = Math.sin(c.t * 1.5 + seed) * 0.04;
      const sq = 1 + kickT * 0.09;
      body.scale.set(1 / sq, sq, 1 / sq);
      fl.rotation.y = c.t * 0.8;
    },
  };
}

/* ------------------------------------------------------------------ */
/* the rest of the garden: repeater ... house plant                    */
/* ------------------------------------------------------------------ */

/** Every plant type the garden can hold, in unlock order. */
export const PLANT_KINDS = ['peashooter', 'cactus', 'repeater', 'snowpea', 'spikesquash', 'melonpult', 'wallnut', 'gatling', 'houseplant'];

const torusLo = new THREE.TorusGeometry(1, 0.16, 5, 12);
const _up = new THREE.Vector3(0, 1, 0);
const _front = new THREE.Vector3(0, 0, -1);
const _zax = new THREE.Vector3(0, 0, 1);
const _nv = new THREE.Vector3();
const _qa = new THREE.Quaternion();

/** z of the front (-z) surface of an ellipsoid with radii rx,ry,rz at offset (x,y) from its centre. */
function zOn(rx, ry, rz, x, y) {
  return -rz * Math.sqrt(Math.max(0.04, 1 - (x / rx) ** 2 - (y / ry) ** 2));
}

/**
 * Stick a mesh onto the front of an ellipsoid (radii R, centre C) at the front-view offset (x, y); its local -z
 * points along the surface normal. out = how far it pokes out, roll = spin about the normal.
 */
function stick(parent, geo, mat, R, C, x, y, o = null, out = 0, roll = 0) {
  const z = zOn(R[0], R[1], R[2], x, y);
  _nv.set(x / (R[0] * R[0]), y / (R[1] * R[1]), z / (R[2] * R[2])).normalize();
  const m = add(parent, geo, mat, C[0] + x + _nv.x * out, C[1] + y + _nv.y * out, C[2] + z + _nv.z * out, o);
  m.quaternion.setFromUnitVectors(_front, _nv);
  if (roll) m.quaternion.multiply(_qa.setFromAxisAngle(_zax, roll));
  return m;
}

/** Cone spike standing on a surface point `dist` from (cx,cy,cz) along unit vector `dir`. */
function spikeOut(parent, mat, cx, cy, cz, dir, dist, len, r) {
  const c = add(parent, G.coneLo, mat, cx + dir.x * dist + dir.x * len * 0.35, cy + dir.y * dist + dir.y * len * 0.35, cz + dir.z * dist + dir.z * len * 0.35, { sx: r, sy: len, sz: r });
  c.quaternion.setFromUnitVectors(_up, dir);
  return c;
}

function cheeks(parent, R, C, x, y, w = 0.06) {
  const m = toon(0xff8a80);
  for (const s of [-1, 1]) stick(parent, G.sphereXS, m, R, C, s * x, y, { sx: w, sy: w * 0.58, sz: w * 0.25 }, 0.0);
}

/** Eyebrows: tilt > 0 = determined / grumpy (inner ends down), tilt < 0 = worried (inner ends up). */
function brows(parent, R, C, x, y, len, tilt, mat, th = 0.03) {
  for (const s of [-1, 1]) stick(parent, G.box, mat, R, C, s * x, y, { sx: len, sy: th, sz: 0.02 }, 0.0, s * tilt);
}

/** A pair of eyes stuck to an ellipsoid front. */
function eyesOn(parent, R, C, x, y, r, look = 0) {
  const white = toon(WHITE), dark = basic(DARK);
  for (const s of [-1, 1]) {
    stick(parent, G.sphereXS, white, R, C, s * x, y, { s: r }, 0.0);
    stick(parent, G.sphereXS, dark, R, C, s * x + look * r * 0.3, y, { s: r * 0.55 }, r * 0.72);
  }
}

/** The ring of base leaves the pea family stands in. */
function peaLeaves(root, mat, n = 3, size = 0.3, len = 0.3) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * PI * 2 + 0.5;
    leafMesh(root, mat, Math.cos(a) * size, 0.12, Math.sin(a) * size, len, 0.14, 0, 0, 0).rotation.set(1.2 * Math.sin(a), 0, -1.2 * Math.cos(a));
  }
}

function headGroup(parent, y) {
  const h = bgroup(parent, 0, y, 0);
  h.rotation.order = 'YXZ';
  return h;
}

/** Same bob / aim / recoil as the peashooter's head. */
function aimHead(head, baseY, c, seed, kickT, recoil = 0.07) {
  const yaw = c.yaw || 0;
  head.rotation.set(c.pitch || 0, yaw, Math.sin(c.t * 1.8 + seed) * 0.04);
  head.position.set(kickT * recoil * Math.sin(yaw), baseY + Math.sin(c.t * 2.4 + seed) * 0.025 - kickT * 0.03, kickT * recoil * Math.cos(yaw));
  const sq = 1 + kickT * 0.1;
  head.scale.set(1 / sq, sq, 1 / sq);
}

const seedOf = (e) => (hash(e.id) % 628) / 100;

/* ---- repeater: two mouths, darker green, determined brows ---- */

function buildRepeater(e) {
  const seed = seedOf(e);
  const green = toon(0x46a328), greenD = toon(0x276f22), greenL = toon(0x86d146), rim = toon(0xc9ef5a), hole = basic(0x14471a);
  const root = new THREE.Group();
  root.userData.bake = true;
  peaLeaves(root, greenD);
  add(root, G.cyl, greenD, 0, 0.4, 0, { sx: 0.1, sy: 0.8, sz: 0.1 });
  const head = headGroup(root, 1.0);
  const R = [0.43, 0.38, 0.42], C = [0, 0, 0];
  add(head, G.sphere, green, 0, 0, 0, { sx: R[0], sy: R[1], sz: R[2] });
  // twin mouths side by side
  for (const s of [-1, 1]) {
    add(head, G.cyl, greenL, s * 0.165, -0.1, -0.42, { sx: 0.13, sy: 0.32, sz: 0.13, rx: PI / 2 });
    add(head, G.cyl, hole, s * 0.165, -0.1, -0.583, { sx: 0.1, sy: 0.02, sz: 0.1, rx: PI / 2 });
    add(head, G.torus, rim, s * 0.165, -0.1, -0.58, { s: 0.135 });
  }
  eyesOn(head, R, C, 0.16, 0.17, 0.085);
  brows(head, R, C, 0.15, 0.3, 0.17, 0.5, basic(0x153d10), 0.04);
  cheeks(head, R, C, 0.31, -0.02);
  // a taller, spikier crest than the plain peashooter
  for (let i = 0; i < 4; i++) {
    leafMesh(head, greenD, (i - 1.5) * 0.1, 0.38, 0.05 + (i % 2) * 0.03, 0.22 + (i % 2) * 0.05, 0.07, -0.2, 0, (i - 1.5) * -0.45);
  }
  leafMesh(head, greenD, 0, 0.0, 0.4, 0.17, 0.09, 1.2, 0, 0);
  // small stacked pea pods on the back of the head: a second helping of ammo
  for (const s of [-1, 1]) add(head, G.sphereLo, greenL, s * 0.2, 0.12, 0.38, { sx: 0.1, sy: 0.1, sz: 0.1 });

  let kickT = 0;
  return {
    root,
    ownYaw: true,
    tagY: 2.0,
    top: 1.68,
    kick() { kickT = 1; },
    update(c) {
      kickT = Math.max(0, kickT - c.dt * 8);
      aimHead(head, 1.0, c, seed, kickT);
    },
  };
}

/* ---- snow pea: icy blue, frost crystals, ice-cube leaves, cold breath ---- */

function buildSnowPea(e) {
  const seed = seedOf(e);
  const ice = toon(0x6ec3f0), iceL = toon(0xbfeaff), frost = toon(0xeefaff), crystal = toon(0xd2f2ff, { emissive: 0x2a6f9a });
  const deepBlue = toon(0x3a8fd2), stem = toon(0x3aa6a3), hole = basic(0x1f5fa8);
  const root = new THREE.Group();
  root.userData.bake = true;
  // ice-cube "leaves" around the foot
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * PI * 2 + 0.5;
    const cube = add(root, G.box, crystal, Math.cos(a) * 0.34, 0.14, Math.sin(a) * 0.34, { s: 0.25 });
    cube.rotation.set(0.5 + i * 0.7, a, 0.4 - i * 0.3);
  }
  for (let i = 0; i < 2; i++) {
    const a = 1.6 + i * 3.1;
    leafMesh(root, stem, Math.cos(a) * 0.22, 0.12, Math.sin(a) * 0.22, 0.26, 0.12, 0, 0, 0).rotation.set(1.2 * Math.sin(a), 0, -1.2 * Math.cos(a));
  }
  add(root, G.cyl, stem, 0, 0.4, 0, { sx: 0.09, sy: 0.8, sz: 0.09 });
  const head = headGroup(root, 1.0);
  const R = [0.4, 0.37, 0.4], C = [0, 0, 0];
  add(head, G.sphere, ice, 0, 0, 0, { sx: R[0], sy: R[1], sz: R[2] });
  // frosty mouth tube
  add(head, G.cyl, iceL, 0, -0.04, -0.4, { sx: 0.17, sy: 0.3, sz: 0.17, rx: PI / 2 });
  add(head, G.cyl, hole, 0, -0.04, -0.552, { sx: 0.125, sy: 0.02, sz: 0.125, rx: PI / 2 });
  add(head, G.torus, frost, 0, -0.04, -0.55, { s: 0.16 });
  eyesOn(head, R, C, 0.15, 0.14, 0.085);
  cheeks(head, R, C, 0.29, -0.04);
  // crown of ice crystals + frost spikes round the back of the head
  for (let i = 0; i < 5; i++) {
    const k = i - 2;
    const cone = add(head, G.coneLo, i % 2 ? frost : iceL, k * 0.1, 0.38 + (2 - Math.abs(k)) * 0.03, 0.04, { sx: 0.055, sy: 0.2 + (2 - Math.abs(k)) * 0.06, sz: 0.055 });
    cone.rotation.z = k * -0.3;
  }
  for (const th of [-1.3, 0, 1.3]) {
    const dir = new THREE.Vector3(Math.sin(th) * 0.95, 0.35, Math.cos(th) * 0.95).normalize();
    spikeOut(head, th > 0 ? frost : iceL, 0, 0, 0, dir, 0.36, 0.17, 0.05);
  }
  // icicles under the chin
  for (const x of [-0.13, 0, 0.13]) {
    const ic = add(head, G.coneLo, frost, x, -0.38, -0.12, { sx: 0.035, sy: 0.12, sz: 0.035 });
    ic.rotation.x = PI;
  }
  // snowflake on the forehead
  const flake = bgroup(head, 0, 0.3, zOn(R[0], R[1], R[2], 0, 0.3) - 0.01);
  for (let i = 0; i < 3; i++) add(flake, G.box, frost, 0, 0, 0, { sx: 0.16, sy: 0.022, sz: 0.012, rz: (i * PI) / 3 });
  leafMesh(head, deepBlue, 0, 0.0, 0.4, 0.17, 0.09, 1.2, 0, 0);

  // cold breath puffs drifting out of the mouth
  const breath = kgroup(head, 0, -0.04, -0.58);
  const puffMat = basic(0xeaf8ff, { transparent: true, opacity: 0.75, depthWrite: false });
  const puffs = [0, 1, 2].map(() => add(breath, G.sphereXS, puffMat, 0, 0, 0, { s: 0.01 }));

  let kickT = 0;
  return {
    root,
    ownYaw: true,
    tagY: 2.0,
    top: 1.62,
    kick() { kickT = 1; },
    update(c) {
      kickT = Math.max(0, kickT - c.dt * 8);
      aimHead(head, 1.0, c, seed, kickT);
      for (let i = 0; i < 3; i++) {
        const p = (c.t * 0.7 + i / 3 + seed) % 1;
        const s = 0.13 * p * (1 - p * p) * 1.6;
        puffs[i].position.set(Math.sin(c.t * 3 + i * 2) * 0.03, p * 0.14 + 0.02, -p * 0.5);
        puffs[i].scale.setScalar(Math.max(0.001, s));
      }
    },
  };
}

/* ---- spike squash: squat grumpy gourd covered in spikes, short wide muzzle ---- */

const flareGeo = new THREE.CylinderGeometry(1, 0.7, 1, 14);

function buildSpikeSquash(e) {
  const seed = seedOf(e);
  const orangeA = toon(0xffa22a), orangeB = toon(0xf98412), flare = toon(0xc85a0a), cream = toon(0xfff3cc), vine = toon(0x5f8f2a);
  const root = new THREE.Group();
  root.userData.bake = true;
  // a few leaves around the foot
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * PI * 2 + 0.3;
    leafMesh(root, vine, Math.cos(a) * 0.42, 0.1, Math.sin(a) * 0.42, 0.3, 0.14, 0, 0, 0).rotation.set(1.25 * Math.sin(a), 0, -1.25 * Math.cos(a));
  }
  const head = headGroup(root, 0.52);
  const R = [0.5, 0.36, 0.5], C = [0, 0, 0];
  add(head, G.sphere, orangeA, 0, 0, 0, { sx: 0.44, sy: 0.34, sz: 0.45 });
  // gourd lobes
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * PI * 2;
    add(head, G.sphereLo, i % 2 ? orangeA : orangeB, Math.sin(a) * 0.25, 0, Math.cos(a) * 0.25, { sx: 0.25, sy: 0.36, sz: 0.25 });
  }
  // stem + curly vine on top
  add(head, G.cylLo, vine, 0, 0.36, 0.02, { sx: 0.055, sy: 0.16, sz: 0.055 });
  leafMesh(head, vine, 0.12, 0.42, 0.04, 0.16, 0.09, 0, 0, -1.0);
  // grumpy face
  eyesOn(head, R, C, 0.19, 0.15, 0.095);
  brows(head, R, C, 0.19, 0.27, 0.24, 0.6, basic(0x4a2200), 0.055);
  cheeks(head, R, C, 0.35, 0.0, 0.055);
  // wide, short flared muzzle (a blunderbuss)
  add(head, flareGeo, flare, 0, -0.12, -0.5, { sx: 0.22, sy: 0.24, sz: 0.22, rx: -PI / 2 });
  add(head, G.cyl, basic(0x3b1a0a), 0, -0.12, -0.625, { sx: 0.185, sy: 0.02, sz: 0.185, rx: PI / 2 });
  add(head, G.torus, toon(0xffe0a3), 0, -0.12, -0.62, { s: 0.22 });
  // spikes everywhere but the face
  const rnd = mulberry(41);
  for (let i = 0, n = 0; i < 200 && n < 26; i++) {
    const a = rnd() * PI * 2, el = Math.asin(rnd() * 2 - 1);
    const dir = new THREE.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el));
    if (dir.z < -0.3 && dir.y > -0.55 && dir.y < 0.65) continue; // keep the face clear
    n++;
    const len = 0.2 + rnd() * 0.14;
    const rr = 1 / Math.sqrt((dir.x / 0.5) ** 2 + (dir.y / 0.34) ** 2 + (dir.z / 0.5) ** 2);
    spikeOut(head, cream, 0, 0, 0, dir, rr * 0.92, len, 0.06);
  }

  let kickT = 0;
  return {
    root,
    ownYaw: true,
    tagY: 1.6,
    top: 1.15,
    kick() { kickT = 1; },
    update(c) {
      kickT = Math.max(0, kickT - c.dt * 7);
      const yaw = c.yaw || 0;
      head.rotation.set(c.pitch || 0, yaw, Math.sin(c.t * 1.6 + seed) * 0.03);
      head.position.set(kickT * 0.12 * Math.sin(yaw), 0.52 + Math.sin(c.t * 2.2 + seed) * 0.015 - kickT * 0.04, kickT * 0.12 * Math.cos(yaw));
      const sq = 1 - kickT * 0.14;
      head.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    },
  };
}

/* ---- melon-pult: a bulb with a vine catapult arm and a striped melon in the bowl ---- */

function buildMelonPult(e) {
  const seed = seedOf(e);
  const bulb = toon(0x62bf45), bulbD = toon(0x3f9a37), leafD = toon(0x2f8a32), vine = toon(0x6e9a2c), bowlM = toon(0x8bc34a), rimM = toon(0x4f8a2a);
  const root = new THREE.Group();
  const turret = group(root);
  const body = bgroup(turret);
  const R = [0.45, 0.43, 0.44], C = [0, 0.5, 0.05];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * PI * 2 + 0.9;
    leafMesh(body, leafD, Math.cos(a) * 0.42, 0.12, Math.sin(a) * 0.42, 0.3, 0.15, 0, 0, 0).rotation.set(1.2 * Math.sin(a), 0, -1.2 * Math.cos(a));
  }
  add(body, G.sphere, bulb, C[0], C[1], C[2], { sx: R[0], sy: R[1], sz: R[2] });
  add(body, torusLo, bulbD, 0, 0.18, 0.05, { s: 0.38 }).rotation.x = PI / 2; // belt of darker green
  for (const s of [-1, 1]) leafMesh(body, leafD, s * 0.5, 0.62, 0.08, 0.34, 0.17, 0.2, 0, s * -1.15);
  eyesOn(body, R, C, 0.16, 0.1, 0.085);
  stick(body, G.smile, basic(DARK), R, C, 0, -0.1, { s: 0.1 }, 0.0, PI);
  cheeks(body, R, C, 0.3, -0.04);
  add(body, G.cylLo, bulbD, 0, 0.84, 0.28, { sx: 0.1, sy: 0.14, sz: 0.1 }); // knuckle the arm pivots on
  // the catapult arm
  const REST = 0.72;
  const arm = bgroup(turret, 0, 0.9, 0.3);
  arm.rotation.x = REST;
  add(arm, G.sphereLo, vine, 0, 0, 0, { s: 0.11 });
  add(arm, G.cyl, vine, 0, 0, -0.34, { sx: 0.07, sy: 0.84, sz: 0.07, rx: PI / 2 });
  add(arm, G.sphereLo, bulbD, 0, 0, 0.12, { sx: 0.13, sy: 0.12, sz: 0.16 }); // counterweight
  for (const s of [-1, 1]) leafMesh(arm, leafD, s * 0.06, 0.0, -0.22, 0.22, 0.09, 0, 0, 0).rotation.set(-PI / 2, 0, s * 0.55);
  const bowlG = kgroup(arm, 0, 0.02, -0.78);
  const bowlBake = bgroup(bowlG);
  add(bowlBake, G.sphereLo, bowlM, 0, 0, 0, { sx: 0.37, sy: 0.14, sz: 0.37 });
  add(bowlBake, torusLo, rimM, 0, 0.08, 0, { s: 0.35 }).rotation.x = PI / 2;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * PI * 2 + 0.4;
    leafMesh(bowlBake, rimM, Math.cos(a) * 0.35, 0.1, Math.sin(a) * 0.35, 0.13, 0.07, 0, 0, 0).rotation.set(0.8 * Math.sin(a), 0, -0.8 * Math.cos(a));
  }
  const melonBase = [0.31, 0.29, 0.32];
  const melon = add(bowlG, G.sphere, melonMaterial(), 0, 0.22, 0, { sx: melonBase[0], sy: melonBase[1], sz: melonBase[2] });
  const melonNub = add(bowlG, G.sphereXS, toon(0x5d4037), 0, 0.22 + melonBase[1] * 0.95, 0, { s: 0.04 });

  let kickT = 0;
  return {
    root,
    ownYaw: true,
    tagY: 2.3,
    top: 1.85,
    ringR: 1.0,
    kick() { kickT = 1; },
    update(c) {
      kickT = Math.max(0, kickT - c.dt * 1.4);
      turret.rotation.y = c.yaw || 0;
      body.rotation.z = Math.sin(c.t * 1.5 + seed) * 0.03;
      const u = 1 - kickT;
      let off = 0;
      if (kickT > 0) off = u < 0.12 ? u / 0.12 : Math.pow(1 - (u - 0.12) / 0.88, 2) * (1 + 0.2 * Math.cos((u - 0.12) * 16));
      arm.rotation.x = REST + Math.sin(c.t * 1.3 + seed) * 0.03 + off * 0.95;
      bowlG.rotation.x = -arm.rotation.x + 0.02;
      const m = kickT <= 0 ? 1 : u < 0.4 ? 0.001 : easeOutBack(clamp01((u - 0.4) / 0.6));
      melon.scale.set(melonBase[0] * m, melonBase[1] * m, melonBase[2] * m);
      melon.position.y = 0.22 + Math.sin(c.t * 2 + seed) * 0.012;
      melonNub.visible = m > 0.5;
      melonNub.position.y = melon.position.y + melonBase[1] * 0.95 * m;
    },
  };
}

/* ---- wall-nut: big worried walnut, no attack ---- */

function buildWallNut(e) {
  const seed = seedOf(e);
  const shell = toon(0xd9a85b), shellD = toon(0xb98840), shellL = toon(0xf0cd8c), crack = basic(0x6b4623), brow = toon(0x7a5230);
  const root = new THREE.Group();
  const body = bgroup(root);
  const R = [0.8, 0.74, 0.74], C = [0, 0.75, 0];
  add(body, G.sphere, shell, C[0], C[1], C[2], { sx: R[0], sy: R[1], sz: R[2] });
  // the seam of the shell, wrinkles and bumps
  const rnd = mulberry(77);
  for (let i = 0, n = 0; i < 80 && n < 16; i++) {
    const a = rnd() * PI * 2, el = Math.asin(rnd() * 2 - 1);
    const dir = new THREE.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el));
    if (dir.z < -0.15 && dir.y > -0.55) continue; // the face side stays smooth
    n++;
    add(body, G.sphereXS, i % 3 ? shellD : shellL, C[0] + dir.x * R[0] * 0.97, C[1] + dir.y * R[1] * 0.97, C[2] + dir.z * R[2] * 0.97, { sx: 0.08, sy: 0.055, sz: 0.08 + rnd() * 0.04 });
  }
  // a shiny highlight, a crack and a tiny sprout
  stick(body, G.sphereLo, shellL, R, C, 0.36, 0.5, { sx: 0.09, sy: 0.19, sz: 0.03 }, 0.0, -0.45);
  stick(body, G.sphereLo, shellL, R, C, 0.5, 0.28, { sx: 0.035, sy: 0.05, sz: 0.02 }, 0.0, -0.45);
  const zig = [[-0.44, 0.58], [-0.36, 0.5], [-0.42, 0.42], [-0.32, 0.35]];
  for (let i = 0; i < zig.length - 1; i++) {
    const [x0, y0] = zig[i], [x1, y1] = zig[i + 1];
    stick(body, G.box, crack, R, C, (x0 + x1) / 2, (y0 + y1) / 2, { sx: Math.hypot(x1 - x0, y1 - y0) * 1.05, sy: 0.022, sz: 0.012 }, 0.0, Math.atan2(y1 - y0, x1 - x0));
  }
  add(body, G.cylLo, toon(0x4c9a3a), 0, C[1] + R[1] - 0.02, 0.0, { sx: 0.035, sy: 0.14, sz: 0.035 });
  leafMesh(body, toon(0x66bb6a), -0.11, C[1] + R[1] + 0.13, 0, 0.14, 0.08, 0, 0, 0.9);
  leafMesh(body, toon(0x7ed35d), 0.11, C[1] + R[1] + 0.15, 0, 0.14, 0.08, 0, 0, -0.9);
  // big worried googly eyes
  const white = toon(WHITE), dark = basic(DARK);
  const er = 0.21;
  const lids = kgroup(body);
  const lidMeshes = [];
  for (const s of [-1, 1]) {
    const ex = s * 0.3, ey = 0.1;
    stick(body, G.sphereLo, dark, R, C, ex, ey, { s: er * 1.1 }, -er * 0.2);
    stick(body, G.sphereLo, white, R, C, ex, ey, { s: er }, 0.0);
    stick(body, G.sphereXS, dark, R, C, ex + s * -0.025, ey + 0.045, { s: er * 0.38 }, er * 0.86);
    stick(body, G.sphereXS, basic(WHITE), R, C, ex + s * -0.045, ey + 0.085, { s: er * 0.12 }, er * 1.14);
    const lid = stick(lids, G.sphereLo, shell, R, C, ex, ey, { s: 0.001 }, er * 0.1);
    lidMeshes.push(lid);
  }
  brows(body, R, C, 0.3, 0.38, 0.27, -0.42, brow, 0.055);
  cheeks(body, R, C, 0.5, -0.16, 0.08);
  stick(body, G.smile, basic(DARK), R, C, 0, -0.2, { sx: 0.12, sy: 0.08, sz: 0.12 }, 0.01);

  let kickT = 0, blinkIn = 1.5 + (seed % 2), blink = 1;
  return {
    root,
    ownYaw: true,
    tagY: 1.95,
    top: 1.78,
    ringR: 1.2,
    kick() { kickT = 1; },
    update(c) {
      kickT = Math.max(0, kickT - c.dt * 6);
      const hpf = c.e && c.e.maxHp > 0 && Number.isFinite(c.e.hp) ? clamp01(c.e.hp / c.e.maxHp) : 1;
      const shiver = (1 - hpf) * 0.03; // more nervous the more battered it is
      body.rotation.z = Math.sin(c.t * 1.3 + seed) * 0.035 + Math.sin(c.t * 31 + seed) * shiver;
      body.rotation.x = Math.sin(c.t * 0.9 + seed * 2) * 0.02;
      const sq = 1 - kickT * 0.14, w = 1 + kickT * 0.1;
      body.scale.set(w, sq, w);
      blinkIn -= c.dt;
      if (blinkIn <= 0 && blink >= 1) { blink = 0; blinkIn = 2.2 + Math.random() * 3; }
      if (blink < 1) blink = Math.min(1, blink + c.dt / 0.2);
      const lk = blink < 1 ? Math.sin(blink * PI) : 0;
      for (const l of lidMeshes) l.scale.setScalar(Math.max(0.001, er * 1.13 * Math.min(1, lk * 1.6)));
    },
  };
}

/* ---- gatling pea: four spinning barrels and an army helmet ---- */

const starShape = (() => {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.46 : 1;
    const a = PI / 2 + (i * PI) / 5;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i) s.lineTo(x, y); else s.moveTo(x, y);
  }
  s.closePath();
  return s;
})();
/** Chunky five-point star, radius 1, facing +-z. Shared by the level stars and the helmet badge. */
const starGeo = (() => {
  const g = new THREE.ExtrudeGeometry(starShape, { depth: 0.26, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.07, bevelSegments: 1, steps: 1 });
  g.translate(0, 0, -0.13);
  return g;
})();

function buildGatling(e) {
  const seed = seedOf(e);
  const green = toon(0x5aa02c), greenD = toon(0x2f6f25), metal = toon(0x66727a), metalD = toon(0x3d474d), hole = basic(0x10171a);
  const helmet = toon(0x66742c), helmetD = toon(0x434f1d), helmetL = toon(0x8a9a3c), gold = toon(0xffd54f);
  const root = new THREE.Group();
  root.userData.bake = true;
  peaLeaves(root, greenD);
  add(root, G.cyl, greenD, 0, 0.4, 0, { sx: 0.1, sy: 0.8, sz: 0.1 });
  const head = headGroup(root, 1.0);
  const R = [0.42, 0.4, 0.41], C = [0, 0, 0];
  add(head, G.sphere, green, 0, 0, 0, { sx: R[0], sy: R[1], sz: R[2] });
  // the four-barrel bundle
  const bundle = bgroup(head, 0, -0.14, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * PI * 2 + PI / 4;
    const bx = Math.cos(a) * 0.1, by = Math.sin(a) * 0.1;
    add(bundle, G.cyl, metal, bx, by, -0.56, { sx: 0.07, sy: 0.5, sz: 0.07, rx: PI / 2 });
    add(bundle, G.cyl, hole, bx, by, -0.812, { sx: 0.05, sy: 0.02, sz: 0.05, rx: PI / 2 });
  }
  add(bundle, G.cyl, metalD, 0, 0, -0.55, { sx: 0.06, sy: 0.5, sz: 0.06, rx: PI / 2 });
  add(bundle, torusLo, gold, 0, 0, -0.5, { s: 0.2 });
  add(bundle, torusLo, gold, 0, 0, -0.7, { s: 0.2 });
  add(bundle, G.cyl, metalD, 0, 0, -0.38, { sx: 0.17, sy: 0.08, sz: 0.17, rx: PI / 2 });
  eyesOn(head, R, C, 0.16, 0.1, 0.085);
  brows(head, R, C, 0.15, 0.2, 0.15, 0.35, basic(0x1d3a10), 0.035);
  cheeks(head, R, C, 0.33, -0.08);
  // helmet: dome, brim band, camo patches, gold star, a leaf poking out the top
  add(head, G.sphere, helmet, 0, 0.3, 0.02, { sx: 0.44, sy: 0.23, sz: 0.44 });
  add(head, torusLo, helmetD, 0, 0.22, 0.02, { s: 0.4 }).rotation.x = PI / 2;
  for (const [x, y, z, sx, sy] of [[-0.2, 0.43, -0.12, 0.1, 0.05], [0.18, 0.44, -0.05, 0.12, 0.05], [0.0, 0.46, 0.14, 0.11, 0.05], [-0.3, 0.38, 0.1, 0.08, 0.05]]) {
    add(head, G.sphereXS, x < 0 ? helmetD : helmetL, x, y, z, { sx, sy, sz: 0.09 });
  }
  add(head, starGeo, gold, 0, 0.37, -0.405, { s: 0.07, rx: 0.4 });
  leafMesh(head, toon(0x6fc23a), 0.05, 0.56, 0.0, 0.2, 0.07, -0.1, 0, -0.35);
  leafMesh(head, toon(0x4caf32), -0.07, 0.55, 0.02, 0.16, 0.06, 0.1, 0, 0.5);

  let kickT = 0, spin = 0, spinV = 2, recent = 0;
  return {
    root,
    ownYaw: true,
    tagY: 2.05,
    top: 1.75,
    kick() { kickT = 1; recent = 1; },
    update(c) {
      kickT = Math.max(0, kickT - c.dt * 10);
      recent = Math.max(0, recent - c.dt * 1.2);
      aimHead(head, 1.0, c, seed, kickT, 0.05);
      spinV += ((1.5 + 26 * recent) - spinV) * clamp01(c.dt * 7);
      spin += spinV * c.dt;
      bundle.rotation.z = spin;
    },
  };
}

/* ---- house plant: the boss. A cottage with a monstera head growing out of the roof, one big mouth cannon ---- */

/** A big monstera leaf (long axis +y before rotation) with split slits cut through it. */
function monstera(parent, mat, slit, x, y, z, len, wid, rx, ry, rz) {
  const g = group(parent, x, y, z);
  g.rotation.set(rx || 0, ry || 0, rz || 0);
  add(g, G.petal, mat, 0, len * 0.5, 0, { sx: wid, sy: len * 0.5, sz: wid * 0.16 });
  for (let i = 0; i < 3; i++) {
    const yy = len * (0.28 + i * 0.22), xx = wid * (0.66 - i * 0.14);
    for (const s of [-1, 1]) add(g, G.box, slit, s * xx, yy, 0, { sx: wid * 0.4, sy: len * 0.04, sz: wid * 0.2 }).rotation.z = s * -0.55;
  }
  return g;
}

function buildHousePlant(e) {
  const seed = seedOf(e);
  const wall = toon(0xf5dfae), wallD = toon(0xe0c488), stone = toon(0x9a8478), roof = toon(0xd8452a), roofD = toon(0xa83420), door = toon(0x7a4a2b);
  const glass = toon(0x8fd6f5, { emissive: 0x2a5a7a }), frame = toon(WHITE), brick = toon(0xb0553a);
  const leafA = toon(0x35a043), leafB = toon(0x4cbf58), leafC = toon(0x2a8a39), headM = toon(0x58b947), cannon = toon(0x9be048), rim = toon(0xd7f56a), slit = basic(0x113d17);
  const root = new THREE.Group();
  root.userData.bake = true;
  // the cottage
  add(root, G.cyl, stone, 0, 0.12, 0, { sx: 1.04, sy: 0.24, sz: 1.04 });
  add(root, G.cyl, wall, 0, 0.62, 0, { sx: 0.94, sy: 0.8, sz: 0.94 });
  add(root, G.cyl, wallD, 0, 0.5, 0, { sx: 0.955, sy: 0.07, sz: 0.955 });
  // door
  add(root, G.box, door, 0, 0.5, -0.93, { sx: 0.42, sy: 0.56, sz: 0.1 });
  add(root, G.cylLo, door, 0, 0.78, -0.93, { sx: 0.21, sy: 0.1, sz: 0.21, rx: PI / 2 });
  add(root, G.sphereXS, toon(0xffd54f), 0.12, 0.52, -0.99, { s: 0.04 });
  add(root, G.box, frame, 0, 0.23, -1.0, { sx: 0.6, sy: 0.05, sz: 0.2 }); // step
  // round windows with flower boxes
  for (const th of [-0.95, 0.95]) {
    const wx = Math.sin(th) * 0.9, wz = -Math.cos(th) * 0.9;
    const w = add(root, G.box, glass, wx, 0.64, wz, { sx: 0.32, sy: 0.32, sz: 0.08 });
    w.rotation.y = -th;
    const f = add(root, G.box, frame, wx, 0.64, wz, { sx: 0.4, sy: 0.4, sz: 0.06 });
    f.rotation.y = -th;
    const bx = add(root, G.box, door, Math.sin(th) * 0.98, 0.43, -Math.cos(th) * 0.98, { sx: 0.4, sy: 0.1, sz: 0.14 });
    bx.rotation.y = -th;
    for (let i = -1; i <= 1; i++) {
      const fx = Math.sin(th) * 1.0 + Math.cos(th) * i * 0.13, fz = -Math.cos(th) * 1.0 + Math.sin(th) * i * 0.13;
      add(root, G.sphereXS, i % 2 ? toon(0xffd93b) : toon(0xff6fa8), fx, 0.53, fz, { s: 0.06 });
    }
  }
  // roof
  add(root, G.cone, roof, 0, 1.45, 0, { sx: 1.14, sy: 0.9, sz: 1.14 });
  add(root, G.torus, roofD, 0, 1.03, 0, { s: 1.1 }).rotation.x = PI / 2;
  add(root, G.box, brick, 0.62, 1.5, 0.28, { sx: 0.24, sy: 0.5, sz: 0.24 }); // chimney
  add(root, G.box, stone, 0.62, 1.78, 0.28, { sx: 0.3, sy: 0.07, sz: 0.3 });
  // the plant growing out of the roof
  add(root, G.cyl, leafC, 0, 1.9, 0, { sx: 0.2, sy: 0.9, sz: 0.2 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * PI * 2 + 0.3;
    monstera(root, i % 2 ? leafA : leafB, slit, Math.cos(a) * 0.12, 1.55, Math.sin(a) * 0.12, 0.85, 0.36, Math.sin(a) * 1.15, 0, -Math.cos(a) * 1.15);
  }
  const hy = 2.15;
  const head = headGroup(root, hy);
  const R = [0.72, 0.66, 0.7], C = [0, 0, 0];
  add(head, G.sphere, headM, 0, 0, 0, { sx: R[0], sy: R[1], sz: R[2] });
  // one big mouth cannon
  add(head, G.cyl, cannon, 0, -0.2, -0.82, { sx: 0.3, sy: 0.6, sz: 0.3, rx: PI / 2 });
  add(head, G.cyl, basic(0x14471a), 0, -0.2, -1.12, { sx: 0.23, sy: 0.02, sz: 0.23, rx: PI / 2 });
  add(head, G.torus, rim, 0, -0.2, -1.11, { s: 0.32 });
  add(head, G.torus, rim, 0, -0.2, -0.62, { s: 0.33 });
  eyesOn(head, R, C, 0.3, 0.26, 0.16);
  brows(head, R, C, 0.3, 0.5, 0.3, 0.3, basic(0x153d10), 0.06);
  cheeks(head, R, C, 0.55, -0.0, 0.1);
  // giant monstera mane around the back of the head
  const fan = [
    [0, 0.45, 0.25, 0.7, 0.45, 0.55, 0, 0], [-0.35, 0.4, 0.2, 0.7, 0.4, 0.4, 0, 0.55], [0.35, 0.4, 0.2, 0.7, 0.4, 0.4, 0, -0.55],
    [-0.6, 0.1, 0.15, 0.7, 0.38, 0.2, 0, 1.15], [0.6, 0.1, 0.15, 0.7, 0.38, 0.2, 0, -1.15],
    [-0.35, -0.15, 0.5, 0.6, 0.36, 0.9, 0, 0.7], [0.35, -0.15, 0.5, 0.6, 0.36, 0.9, 0, -0.7],
  ];
  fan.forEach(([x, y, z, len, wid, rx, ry, rz], i) => monstera(head, i % 3 === 0 ? leafC : i % 3 === 1 ? leafA : leafB, slit, x, y, z, len, wid, rx, ry, rz));

  let kickT = 0;
  return {
    root,
    ownYaw: true,
    tagY: 3.7,
    top: 3.15,
    ringR: 1.35,
    kick() { kickT = 1; },
    update(c) {
      kickT = Math.max(0, kickT - c.dt * 5);
      aimHead(head, hy, c, seed, kickT, 0.14);
    },
  };
}

/* ------------------------------------------------------------------ */
/* plant levels: grow a little, wear gold stars                        */
/* ------------------------------------------------------------------ */

const LEVEL_SCALE = [1, 1.15, 1.3];
const levelOf = (e) => {
  const n = Math.round(Number(e && e.level));
  return n >= 3 ? 3 : n >= 2 ? 2 : 1;
};
const starMat = toon(0xffc928, { emissive: 0xc57a00 });
const glowRingGeo = new THREE.RingGeometry(0.84, 1, 40).rotateX(-PI / 2);
const glowDiscGeo = new THREE.CircleGeometry(1, 32).rotateX(-PI / 2);
const glowRingMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.55, depthWrite: false });
const glowDiscMat = new THREE.MeshBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.16, depthWrite: false });

/**
 * Wrap a garden plant model: level 1/2/3 => scale 1 / 1.15 / 1.3 (with a bouncy pop when it goes up), no stars / 2 stars /
 * 3 stars floating above the head, and a faint gold glow ring on the ground at level 3.
 */
function withLevel(m) {
  const wrap = new THREE.Group();
  wrap.add(m.root);
  const top = m.top !== undefined ? m.top : m.tagY - 0.4;
  const ringR = m.ringR || 0.95;
  const starS = top > 2.5 ? 0.32 : 0.17;
  let row = null, stars = null, glow = null, ring = null;
  let lvl = 0, cur = 1, from = 1, to = 1, popT = 1;
  const out = {
    root: wrap,
    ownYaw: m.ownYaw,
    tagY: m.tagY,
    kick() { m.kick(); },
    update(c) {
      const L = levelOf(c.e);
      if (L !== lvl) {
        to = LEVEL_SCALE[L - 1];
        if (lvl === 0) { cur = from = to; popT = 1; } else { from = cur; popT = 0; }
        lvl = L;
        if (L >= 2 && !row) {
          row = new THREE.Group();
          stars = [0, 1, 2].map((i) => {
            const s = new THREE.Mesh(starGeo, starMat);
            row.add(s);
            return s;
          });
          wrap.add(row);
        }
        if (L >= 3 && !glow) {
          glow = new THREE.Group();
          ring = new THREE.Mesh(glowRingGeo, glowRingMat);
          glow.add(ring, new THREE.Mesh(glowDiscGeo, glowDiscMat));
          glow.scale.set(ringR, 1, ringR);
          wrap.add(glow);
        }
        if (row) {
          const n = L === 2 ? 2 : 3;
          row.visible = L >= 2;
          for (let i = 0; i < 3; i++) stars[i].visible = i < n;
        }
        if (glow) glow.visible = L >= 3;
      }
      let wob = 0;
      if (popT < 1) {
        popT = Math.min(1, popT + c.dt / 0.7);
        const k = popT;
        const ease = 1 - (1 - k) * (1 - k) * (1 - k);
        cur = from + (to - from) * ease + 0.2 * Math.sin(PI * k) * (1 - k) * to;
        wob = 0.1 * Math.sin(PI * 2 * k) * (1 - k);
      } else {
        cur = to;
      }
      wrap.scale.set(cur, cur * (1 + wob), cur);
      m.update(c);
      out.tagY = m.tagY * cur + (lvl >= 2 ? 0.28 : 0);
      if (row && lvl >= 2) {
        const fy = Number.isFinite(c.faceYaw) ? c.faceYaw : 0;
        row.rotation.y = fy;
        row.position.y = top + (top > 2.5 ? 0.45 : 0.3);
        const three = lvl >= 3;
        for (let i = 0; i < (three ? 3 : 2); i++) {
          const s = stars[i];
          const x = three ? (i - 1) * 0.38 * (starS / 0.17) : (i - 0.5) * 0.44 * (starS / 0.17);
          const arc = three ? (i === 1 ? 0.1 : -0.02) * (starS / 0.17) : 0;
          s.position.set(x, arc + Math.sin(c.t * 2.2 + i * 2.1) * 0.04, 0);
          s.rotation.set(0, Math.sin(c.t * 1.1 + i) * 0.5, c.t * (i % 2 ? -1.3 : 1.3) + i);
          s.scale.setScalar(starS * (i === 1 && three ? 1.2 : 1) * (1 + Math.sin(c.t * 3.1 + i * 1.7) * 0.08));
        }
      }
      if (glow && lvl >= 3) {
        glow.position.y = 0.2 / cur;
        const p = 1 + Math.sin(c.t * 2.4) * 0.035;
        glow.scale.set(ringR * p, 1, ringR * p);
        glowRingMat.opacity = 0.5 + Math.sin(c.t * 2.4) * 0.12;
      }
    },
  };
  return out;
}

/* ------------------------------------------------------------------ */
/* lawnmower                                                           */
/* ------------------------------------------------------------------ */

function buildMower() {
  const root = new THREE.Group();
  const rig = bgroup(root);
  const red = toon(0xe53935), redD = toon(0xb71c1c), grey = toon(0xb0bec5), black = toon(0x37474f), yellow = toon(0xffd54f);
  add(rig, G.box, grey, 0, 0.25, -0.05, { sx: 1.1, sy: 0.14, sz: 1.2 });
  add(rig, G.box, red, 0, 0.5, 0.0, { sx: 0.85, sy: 0.4, sz: 1.2 });
  add(rig, G.box, redD, 0, 0.62, -0.5, { sx: 0.68, sy: 0.3, sz: 0.4 }); // hood
  add(rig, G.box, toon(WHITE), 0, 0.5, -0.0, { sx: 0.87, sy: 0.07, sz: 1.22 }); // stripe
  // seat
  add(rig, G.box, black, 0, 0.78, 0.38, { sx: 0.5, sy: 0.12, sz: 0.4 });
  add(rig, G.box, black, 0, 1.0, 0.54, { sx: 0.5, sy: 0.4, sz: 0.1 });
  // steering wheel
  const wheelPost = add(rig, G.cyl, grey, 0, 0.95, -0.15, { sx: 0.03, sy: 0.4, sz: 0.03 });
  wheelPost.rotation.x = -0.4;
  const sw = add(rig, G.torus, black, 0, 1.12, -0.24, { s: 0.2 });
  sw.rotation.x = -1.0;
  // wheels
  const wheels = [];
  for (const [x, z, r] of [[-0.55, 0.45, 0.34], [0.55, 0.45, 0.34], [-0.5, -0.5, 0.25], [0.5, -0.5, 0.25]]) {
    const w = bgroup(rig, x, r, z);
    add(w, G.cyl, black, 0, 0, 0, { sx: r, sy: 0.2, sz: r, rz: PI / 2 });
    add(w, G.cyl, yellow, x < 0 ? -0.11 : 0.11, 0, 0, { sx: r * 0.5, sy: 0.04, sz: r * 0.5, rz: PI / 2 });
    wheels.push(w);
  }
  // headlights + exhaust
  const lightMat = basic(0xfff59d);
  for (const s of [-1, 1]) add(rig, G.sphereXS, lightMat, s * 0.25, 0.65, -0.72, { s: 0.09 });
  add(rig, G.cyl, black, 0.32, 0.9, 0.2, { sx: 0.045, sy: 0.4, sz: 0.045 });
  // little flag to make it friendly
  add(rig, G.cyl, grey, -0.38, 1.1, 0.5, { sx: 0.012, sy: 0.7, sz: 0.012 });
  const flag = kgroup(rig, -0.38, 1.38, 0.5);
  add(flag, G.box, toon(0xff7043), 0, 0, -0.15, { sx: 0.01, sy: 0.14, sz: 0.3 });

  let spin = 0;
  return {
    root,
    tagY: 1.9,
    kick() {},
    update(c) {
      const st = c.state;
      const shake = st === 'driving' ? 0.012 : st === 'starting' ? 0.03 : 0;
      rig.position.y = shake ? Math.sin(c.t * 70) * shake : 0;
      rig.rotation.z = shake ? Math.sin(c.t * 55) * shake * 1.5 : 0;
      spin += c.dt * (st === 'driving' ? c.speed * 3.5 : 0);
      for (const w of wheels) w.rotation.x = -spin;
      flag.rotation.y = Math.sin(c.t * 6) * 0.3;
    },
  };
}

/* ------------------------------------------------------------------ */
/* sun pickup                                                          */
/* ------------------------------------------------------------------ */

let glowTex = null;
function getGlowTex() {
  if (glowTex) return glowTex;
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(cv);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
export { getGlowTex };

function buildSun(e) {
  const seed = (hash(e.id) % 628) / 100;
  const root = new THREE.Group();
  const orb = bgroup(root, 0, 0, 0);
  const spin = bgroup(orb);
  add(spin, G.sphere, basic(0xffe14a), 0, 0, 0, { s: 0.32 });
  add(spin, G.sphere, basic(0xffb300, { transparent: true, opacity: 0.35 }), 0, 0, 0, { s: 0.42 });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * PI * 2;
    const r = add(spin, G.cone, basic(i % 2 ? 0xffd54f : 0xffa726), Math.cos(a) * 0.46, Math.sin(a) * 0.46, 0, { sx: 0.1, sy: 0.24, sz: 0.1 });
    r.rotation.z = a - PI / 2;
  }
  // face stays facing -z-ish; the group spins around z so rays whirl
  eyePair(orb, 0.05, -0.28, 0.1, 0.055);
  smile(orb, 0, -0.06, -0.3, 0.1);
  const tex = getGlowTex();
  if (tex) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffe066, transparent: true, depthWrite: false, opacity: 0.8 }));
    sp.scale.setScalar(2.1);
    orb.add(sp);
  }
  return {
    root,
    tagY: 0,
    faceCamera: true,
    kick() {},
    update(c) {
      spin.rotation.z = c.t * 1.6;
      orb.position.y = Math.sin(c.t * 2.5 + seed) * 0.12;
      const p = 1 + Math.sin(c.t * 4 + seed) * 0.05;
      orb.scale.setScalar(p);
      orb.rotation.y = c.faceYaw || 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/* projectiles                                                         */
/* ------------------------------------------------------------------ */

function glowBall(color, halo, r, haloScale = 1.7, stretch = 1.4) {
  const root = new THREE.Group();
  const core = add(root, G.sphereLo, basic(color), 0, 0, 0, { sx: r, sy: r, sz: r * stretch });
  add(root, G.sphereLo, basic(halo, { transparent: true, opacity: 0.32, depthWrite: false }), 0, 0, 0, { sx: r * haloScale, sy: r * haloScale, sz: r * haloScale * stretch });
  return { root, core };
}

/* ---- big glowing enemy shots: emissive orb + additive halo sprite + a fading comet tail ---- */

// Cone with its wide end at the orb (z = 0) and its tip trailing behind (+z). Vertex colours fade to black at the
// tip, which under additive blending reads as a soft fade-out: the whole trail is a single draw call.
const tailGeo = (() => {
  const g = new THREE.ConeGeometry(1, 1, 10, 1, true).rotateX(PI / 2).translate(0, 0, 0.5);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) col.fill(pos.getZ(i) < 0.01 ? 1 : 0, i * 3, i * 3 + 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
})();
const tailMats = new Map();
function tailMat(color) {
  let m = tailMats.get(color);
  if (!m) {
    // dimmed: it stacks (additively) with the orb and halo, and a full-strength tail washes out to white
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.55), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    tailMats.set(color, m);
  }
  return m;
}
const haloMats = new Map();
function haloMat(color, opacity = 0.9) {
  const key = color + ':' + opacity;
  let m = haloMats.get(key);
  if (!m) {
    m = new THREE.SpriteMaterial({ map: getGlowTex(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    haloMats.set(key, m);
  }
  return m;
}

/**
 * o: { r (core radius, m), core (outer colour), hot (inner bright colour), halo, tail, haloK (halo diameter / r),
 *      tailLen (m), stretch }
 */
function glowOrb(o) {
  const root = new THREE.Group();
  const st = o.stretch || 1;
  // one opaque emissive core (an in-between of its two colours), the halo and the tail: 3 draw calls per shot
  const mix = new THREE.Color(o.core).lerp(new THREE.Color(o.hot), 0.55).getHex();
  add(root, G.sphereLo, basic(mix), 0, 0, 0, { sx: o.r, sy: o.r, sz: o.r * st });
  let halo = null;
  if (getGlowTex()) {
    halo = new THREE.Sprite(haloMat(o.halo));
    halo.scale.setScalar(o.r * (o.haloK || 6));
    halo.renderOrder = 6;
    root.add(halo);
  }
  const tail = add(root, tailGeo, tailMat(o.tail || o.halo), 0, 0, 0, { sx: o.r * 0.8, sy: o.r * 0.8, sz: (o.tailLen || 1.6) * 0.85 });
  tail.renderOrder = 6;
  return { root, halo, haloBase: halo ? halo.scale.x : 0 };
}

function buildProjectile(e) {
  let b;
  let upd = null;
  const ph = (hash(e.id) % 628) / 100;
  switch (e.projKind) {
    case 'spike': {
      const root = new THREE.Group();
      const c = add(root, G.coneLo, toon(0xfff3c4, { emissive: 0x6b5a1a }), 0, 0, 0, { sx: 0.075, sy: 0.55, sz: 0.075 });
      c.rotation.x = PI / 2 * -1; // tip toward -z
      c.rotation.x = -PI / 2;
      add(root, G.sphereXS, toon(0xff6fa8), 0, 0, 0.3, { s: 0.07 });
      b = { root };
      break;
    }
    case 'housepea': {
      b = glowBall(0x76e03a, 0xc8ff6a, 0.46, 1.35, 1.0);
      eyePair(b.root, 0.06, -0.38, 0.14, 0.08);
      smile(b.root, 0, -0.14, -0.43, 0.14);
      break;
    }
    case 'snow': {
      b = glowBall(0xcdf3ff, 0x7fd8ff, 0.18, 1.9, 1.3);
      const star = new THREE.Group();
      for (let i = 0; i < 3; i++) add(star, G.box, basic(0xffffff), 0, 0, 0, { sx: 0.5, sy: 0.03, sz: 0.03, rz: (i * PI) / 3 });
      b.root.add(star);
      if (getGlowTex()) {
        const sp = new THREE.Sprite(haloMat(0x9ae6ff, 0.8));
        sp.scale.setScalar(0.9);
        b.root.add(sp);
      }
      const tl = add(b.root, tailGeo, tailMat(0x7fd8ff), 0, 0, 0, { sx: 0.17, sy: 0.17, sz: 0.9 });
      tl.renderOrder = 6;
      upd = (c) => { star.rotation.z = c.t * 7 + ph; const k = 0.8 + 0.3 * Math.sin(c.t * 13 + ph); star.scale.setScalar(k); };
      break;
    }
    case 'melon': {
      const root = new THREE.Group();
      const pivot = new THREE.Group();
      root.add(pivot);
      add(pivot, G.sphere, melonMaterial(), 0, 0, 0, { sx: 0.42, sy: 0.38, sz: 0.46 });
      add(pivot, G.sphereXS, toon(0x5d4037), 0, 0.37, 0, { s: 0.05 });
      if (getGlowTex()) {
        const sp = new THREE.Sprite(haloMat(0x9cff7a, 0.45));
        sp.scale.setScalar(1.7);
        root.add(sp);
      }
      b = { root };
      upd = (c) => { pivot.rotation.x = c.t * 6.5 + ph; pivot.rotation.z = c.t * 3.1 + ph; };
      break;
    }
    case 'bullet':
      b = glowOrb({ r: 0.3, core: 0xb04bff, hot: 0xffd6ff, halo: 0xc65bff, tail: 0xb03cff, haloK: 6.5, tailLen: 1.7 });
      break;
    case 'slime':
      b = glowOrb({ r: 0.34, core: 0x8bff2a, hot: 0xf4ffc0, halo: 0x7dff2a, tail: 0x6ee01a, haloK: 6.2, tailLen: 1.5, stretch: 1.15 });
      break;
    case 'bone': {
      b = glowOrb({ r: 0.2, core: 0xff3ccf, hot: 0xffc2ee, halo: 0xff3ccf, tail: 0xff3ccf, haloK: 8.5, tailLen: 1.6 });
      const bone = new THREE.Group();
      add(bone, G.cylLo, toon(0xf6f1de, { emissive: 0x6b6450 }), 0, 0, 0, { sx: 0.075, sy: 0.62, sz: 0.075 });
      for (const y of [-0.31, 0.31]) for (const x of [-0.07, 0.07]) add(bone, G.sphereXS, toon(0xf6f1de, { emissive: 0x6b6450 }), x, y, 0, { s: 0.09 });
      b.root.add(bone);
      upd = (c) => { bone.rotation.z = c.t * 14 + ph; bone.rotation.x = c.t * 5 + ph; };
      break;
    }
    case 'sludge':
      b = glowOrb({ r: 0.23, core: 0x7a2fd0, hot: 0x3b1470, halo: 0xa855f7, tail: 0x8a3ff0, haloK: 6, tailLen: 1.2 });
      break;
    case 'brain': {
      b = glowOrb({ r: 0.5, core: 0xff6fa8, hot: 0xffd1e3, halo: 0xff4fa0, tail: 0xff4fa0, haloK: 6, tailLen: 2.4 });
      const deep = toon(0xff3f8e, { emissive: 0x6b1038 });
      const rnd = mulberry(5);
      for (let i = 0; i < 9; i++) {
        const a = rnd() * PI * 2, el = (rnd() - 0.5) * 2.2;
        add(b.root, G.sphereXS, deep, Math.cos(a) * Math.cos(el) * 0.46, Math.sin(el) * 0.46, Math.sin(a) * Math.cos(el) * 0.46, { s: 0.12 });
      }
      add(b.root, G.box, deep, 0, 0.5, 0, { sx: 0.03, sy: 0.04, sz: 0.5 });
      upd = (c) => {
        const k = 1 + Math.sin(c.t * 9 + ph) * 0.1;
        b.root.children[0].scale.set(0.5 * k, 0.5 * k, 0.5 * k);
        if (b.halo) b.halo.scale.setScalar(b.haloBase * (0.9 + 0.2 * Math.sin(c.t * 9 + ph)));
      };
      break;
    }
    case 'pea':
    default: {
      // unknown shots from zombies still read as enemy goo; unknown plant shots as peas
      if (e.team === 'zombie') {
        b = glowOrb({ r: 0.3, core: 0xb04bff, hot: 0xffd6ff, halo: 0xc65bff, tail: 0xb03cff, haloK: 6.5, tailLen: 1.7 });
      } else {
        b = glowBall(0x7ee03a, 0xd0ff7a, 0.16, 1.7, 1.3);
      }
      break;
    }
  }
  return {
    root: b.root,
    projectile: true,
    tagY: 0,
    kick() {},
    update: upd || (() => {}),
  };
}

/* ------------------------------------------------------------------ */
/* garage rack with its tool                                           */
/* ------------------------------------------------------------------ */

function buildRackItem(e) {
  const id = rackItemId(e);
  const root = new THREE.Group();
  const frame = bgroup(root);
  const wood = toon(0xc8955a), woodD = toon(0x8d5a2b), peg = toon(0xffd54f);
  // freestanding wooden rack (the server puts it 3 m in front of the back wall): board, braces and four pegs
  add(frame, G.box, wood, 0, 1.3, 0.08, { sx: 1.7, sy: 1.9, sz: 0.1 });
  for (const x of [-0.85, 0.85]) {
    add(frame, G.box, woodD, x, 1.17, 0.1, { sx: 0.12, sy: 2.34, sz: 0.14 });
    const brace = add(frame, G.box, woodD, x, 1.1, 0.55, { sx: 0.1, sy: 2.4, sz: 0.1 });
    brace.rotation.x = -0.37;
  }
  for (const y of [0.34, 2.26]) add(frame, G.box, woodD, 0, y, 0.1, { sx: 1.84, sy: 0.12, sz: 0.14 });
  for (const [x, y] of [[-0.5, 1.7], [0.5, 1.7], [-0.5, 0.8], [0.5, 0.8]]) {
    add(frame, G.cylLo, peg, x, y, -0.1, { sx: 0.045, sy: 0.22, sz: 0.045, rx: PI / 2 });
    add(frame, G.sphereXS, peg, x, y, -0.21, { s: 0.06 });
  }
  const shelf = add(frame, G.box, woodD, 0, 0.05, -0.1, { sx: 1.7, sy: 0.1, sz: 0.5 }); // floor mat
  shelf.scale.y = 0.05;
  bakeAll(root);
  // the tool itself: hangs on the pegs while available
  const hang = new THREE.Group();
  let tool = null;
  try { tool = makeItem(id); } catch (_) { tool = null; }
  if (tool) {
    hang.add(tool.root);
    switch (id) {
      case 'weed_eater': tool.root.rotation.set(-PI / 2 - 0.05, 0, 0); hang.position.set(0.05, 2.15, -0.22); tool.root.scale.setScalar(1.0); break;
      case 'leaf_blower': tool.root.rotation.set(0, PI / 2, 0); hang.position.set(0.55, 1.2, -0.22); break;
      case 'hedge_trimmer': tool.root.rotation.set(0, PI / 2, 0); hang.position.set(0.7, 1.25, -0.22); tool.root.scale.setScalar(0.85); break;
      case 'wheelbarrow': tool.root.rotation.set(0, PI / 2 - 0.3, 0); hang.position.set(0.95, 0, -0.7); tool.root.scale.setScalar(0.8); break;
      default: hang.position.set(0, 1.2, -0.22);
    }
  }
  root.add(hang);
  // an unpowered tool shows the part it still needs, bobbing above its hook
  const needsKind = (ITEMS[id] && ITEMS[id].needs) || null;
  let needMark = null;
  if (needsKind && PART_INFO[needsKind]) {
    needMark = new THREE.Group();
    const pm = makePartMesh(needsKind);
    pm.scale.setScalar(1.3);
    needMark.add(pm);
    add(needMark, G.torus, basic(0xff5252, { transparent: true, opacity: 0.9 }), 0, 0, 0, { s: 0.42, rx: PI / 2 });
    needMark.position.set(0, 2.85, -0.1);
    root.add(needMark);
  }
  let shown = 1;
  let prev = true;
  let age = 0;
  return {
    root,
    tagY: 2.6,
    kick() {},
    update(c) {
      if (needMark) {
        const need = c.e.powered === false;
        needMark.visible = need;
        if (need) {
          needMark.position.y = 2.85 + Math.sin(c.t * 2.4) * 0.08;
          needMark.rotation.y = c.t * 1.2;
        }
      }
      const avail = c.e.available !== false;
      if (avail && !prev) age = 0;
      prev = avail;
      age += c.dt;
      shown += ((avail ? 1 : 0) - shown) * Math.min(1, c.dt * 10);
      hang.visible = shown > 0.05;
      const pop = avail ? easeOutBack(clamp01(age / 0.4)) : 1;
      hang.scale.setScalar(Math.max(0.01, pop));
      if (tool && avail) tool.update({ t: c.t, dt: c.dt, using: false, speed: 0 });
    },
  };
}

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function rackItemId(e) {
  if (typeof e.itemId === 'string' && e.itemId) return e.itemId;
  return String(e.id || '').replace(/^rack_/, '');
}

/* ------------------------------------------------------------------ */
/* factory                                                             */
/* ------------------------------------------------------------------ */

/** What model an entity needs; changes mean the view must be rebuilt. */
export function modelKey(e) {
  const k = e.kind;
  if ((k === 'player' || k === 'bot') && e.state === 'sprout') return 'sprout';
  if (k === 'player' || k === 'bot') return 'char:' + (e.team === 'plant' ? (k === 'bot' ? 'plant:gardener' : 'plant') : 'zombie');
  if (k === 'rack_item') return 'rack:' + rackItemId(e);
  if (k === 'garden') return 'garden:' + (PLANT_KINDS.includes(e.plantKind) ? e.plantKind : 'peashooter');
  if (k === 'projectile') return 'proj:' + (e.projKind || 'pea');
  if (k === 'mower') return e.state === 'destroyed' ? null : 'mower'; // a wrecked mower vanishes until it respawns
  if (k === 'sun') return 'sun';
  if (k === 'part') return 'part:' + (PART_INFO[e.partKind] ? e.partKind : 'battery');
  return null; // unknown: don't render
}

export function buildModel(e) {
  const m = buildModelRaw(e);
  if (m && !m.projectile) bakeAll(m.root);
  return m;
}

function buildModelRaw(e) {
  const key = modelKey(e);
  switch (key) {
    case null: return null;
    case 'sprout': return buildSprout(e);
    case 'char:plant': case 'char:plant:gardener': return buildSoldier(e);
    case 'char:zombie': return buildZombie(e);
    case 'garden:peashooter': return withLevel(buildPeashooter(e));
    case 'garden:cactus': return withLevel(buildCactus(e));
    case 'garden:repeater': return withLevel(buildRepeater(e));
    case 'garden:snowpea': return withLevel(buildSnowPea(e));
    case 'garden:spikesquash': return withLevel(buildSpikeSquash(e));
    case 'garden:melonpult': return withLevel(buildMelonPult(e));
    case 'garden:wallnut': return withLevel(buildWallNut(e));
    case 'garden:gatling': return withLevel(buildGatling(e));
    case 'garden:houseplant': return withLevel(buildHousePlant(e));
    case 'mower': return buildMower(e);
    case 'sun': return buildSun(e);
    default:
      if (key.startsWith('part:')) return buildPart(e);
      if (key.startsWith('proj:')) return buildProjectile(e);
      if (key.startsWith('rack:')) return buildRackItem(e);
      return null;
  }
}

/** Soft round ground shadow. Shared geometry/material. */
const blobMat = new THREE.MeshBasicMaterial({ color: 0x0a1a10, transparent: true, opacity: 0.28, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const blobGeo = new THREE.CircleGeometry(1, 20).rotateX(-PI / 2);
export function makeBlob(radius) {
  const m = new THREE.Mesh(blobGeo, blobMat);
  m.scale.set(radius, 1, radius);
  m.renderOrder = 1;
  return m;
}

export const SHADOW_RADIUS = { char: 0.6, garden: 0.55, mower: 0.9, sprout: 0.45, sun: 0.0, proj: 0.0, rack: 0.0, part: 0.0 };

/** Free a whole tree's GPU resources (geometry, instance buffers, materials, their textures), except what is shared for the session. */
export function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    if (o.isInstancedMesh) o.dispose();
    const m = o.material;
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) {
      if (mm.userData.shared) continue;
      if (mm.map) mm.map.dispose();
      mm.dispose();
    }
  });
}
