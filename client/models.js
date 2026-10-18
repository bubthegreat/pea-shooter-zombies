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

/** Merge the meshes under `g` (not inside nested bake/keep groups) into one mesh per material. */
export function bakeGroup(g) {
  g.updateMatrixWorld(true);
  _inv.copy(g.matrixWorld).invert();
  const buckets = new Map();
  const doomed = [];
  const visit = (o) => {
    for (const c of o.children) {
      if (c.userData.bake || c.userData.keep) continue;
      if (c.isMesh && c.geometry) {
        let b = buckets.get(c.material.uuid);
        if (!b) { b = { mat: c.material, pos: [], nor: [] }; buckets.set(c.material.uuid, b); }
        const geo = c.geometry.index ? c.geometry.toNonIndexed() : c.geometry.clone();
        geo.applyMatrix4(_rel.multiplyMatrices(_inv, c.matrixWorld));
        b.pos.push(geo.attributes.position.array);
        b.nor.push(geo.attributes.normal.array);
        geo.dispose();
        doomed.push(c);
      } else if (!c.isSprite) {
        visit(c);
      }
    }
  };
  visit(g);
  for (const c of doomed) c.parent.remove(c);
  const cat = (arrs) => {
    let n = 0;
    for (const a of arrs) n += a.length;
    const out = new Float32Array(n);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  };
  for (const b of buckets.values()) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cat(b.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(cat(b.nor), 3));
    geo.computeBoundingSphere();
    geo.userData.baked = true;
    g.add(new THREE.Mesh(geo, b.mat));
  }
  return g;
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
  // plant ladder
  pea_blaster: { name: 'Pea Blaster', rate: 4, proj: 'pea', team: 'plant' },
  double_pea: { name: 'Double Pea', rate: 5, proj: 'pea', team: 'plant' },
  pea_rifle: { name: 'Pea Rifle', rate: 9, proj: 'pea', team: 'plant' },
  snow_pea: { name: 'Snow Pea', rate: 3.5, proj: 'snow', team: 'plant' },
  spike_shotgun: { name: 'Spike Shotgun', rate: 1.3, proj: 'spike', team: 'plant' },
  repeater: { name: 'Repeater', rate: 14, proj: 'pea', team: 'plant' },
  melon_lobber: { name: 'Melon Lobber', rate: 0.8, proj: 'melon', team: 'plant' },
  house_gun: { name: 'House Gun', rate: 1.5, proj: 'housepea', team: 'plant' },
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
    };
  }
}

function prettyId(id) {
  return String(id).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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
  switch (id) {
    case 'pea_blaster': {
      const pod = toon(0x7ed957), pea = toon(0xb9f57d), barrel = toon(0x2e7d32), grip = toon(0x8d5a2b);
      add(g, G.sphereLo, pod, 0, 0, -0.16, { sx: 0.085, sy: 0.085, sz: 0.3 });
      for (let i = 0; i < 3; i++) add(g, G.sphereXS, pea, 0, 0.085, -0.04 - i * 0.12, { s: 0.052 });
      cyl(g, barrel, 0, 0, -0.44, 0.04, 0.26);
      add(g, G.torus, toon(0xffe066), 0, 0, -0.57, { s: 0.055 });
      add(g, G.box, grip, 0, -0.11, 0.02, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.6);
      break;
    }
    case 'pea_rifle': {
      const body = toon(0x43a047), pea = toon(0xb9f57d), barrel = toon(0x1b5e20), grip = toon(0x8d5a2b);
      add(g, G.sphereLo, body, 0, 0, -0.2, { sx: 0.075, sy: 0.085, sz: 0.4 });
      for (let i = 0; i < 4; i++) {
        add(g, G.sphereXS, pea, 0.075, 0, -0.06 - i * 0.12, { s: 0.048 });
        add(g, G.sphereXS, pea, -0.075, 0, -0.06 - i * 0.12, { s: 0.048 });
      }
      cyl(g, barrel, 0, 0, -0.62, 0.035, 0.45);
      cyl(g, toon(0xffd54f), 0, 0.12, -0.2, 0.035, 0.24); // scope
      add(g, G.sphereXS, toon(0x4fc3f7), 0, 0.12, -0.33, { s: 0.04 });
      add(g, G.torus, toon(0xffe066), 0, 0, -0.84, { s: 0.05 });
      add(g, G.box, grip, 0, -0.11, 0.0, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      add(g, G.box, grip, 0, -0.02, 0.26, { sx: 0.06, sy: 0.12, sz: 0.2 }); // stock
      muzzle.position.set(0, 0, -0.88);
      break;
    }
    case 'spike_shotgun': {
      const cactus = toon(0x2fa05a), spike = toon(0xfff3c4), pink = toon(0xff6fa8);
      cyl(g, cactus, 0, 0, -0.3, 0.085, 0.7);
      const rnd = mulberry(7);
      for (let i = 0; i < 12; i++) {
        const a = rnd() * PI * 2, z = -0.05 - rnd() * 0.55;
        const c = add(g, G.coneLo, spike, Math.cos(a) * 0.085, Math.sin(a) * 0.085, z, { sx: 0.014, sy: 0.07, sz: 0.014 });
        c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
      }
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * PI * 2;
        add(g, G.sphereXS, pink, Math.cos(a) * 0.05, 0.1 + Math.sin(a) * 0.05, 0.02, { s: 0.035 });
      }
      add(g, G.sphereXS, toon(0xffeb3b), 0, 0.1, 0.02, { s: 0.03 });
      add(g, G.torus, toon(0x1b7a3c), 0, 0, -0.66, { s: 0.1 });
      add(g, G.sphereLo, cactus, 0, -0.1, -0.35, { sx: 0.06, sy: 0.05, sz: 0.14 }); // pump
      add(g, G.box, toon(0x8d5a2b), 0, -0.12, 0.05, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.7);
      break;
    }
    case 'house_gun': {
      const wall = toon(0xffe9a8), roof = toon(0xe53935), barrel = toon(0xff9800), door = toon(0x6d4c41);
      add(g, G.box, wall, 0, 0.02, 0.1, { sx: 0.2, sy: 0.18, sz: 0.3 });
      add(g, G.box, roof, 0.075, 0.15, 0.1, { sx: 0.14, sy: 0.02, sz: 0.34, rz: -0.65 });
      add(g, G.box, roof, -0.075, 0.15, 0.1, { sx: 0.14, sy: 0.02, sz: 0.34, rz: 0.65 });
      add(g, G.box, toon(0xb0463a), 0.07, 0.21, 0.2, { sx: 0.05, sy: 0.1, sz: 0.05 }); // chimney
      add(g, G.box, door, 0, -0.03, 0.255, { sx: 0.06, sy: 0.1, sz: 0.01 });
      add(g, G.box, toon(0x81d4fa), 0.07, 0.04, 0.255, { sx: 0.05, sy: 0.05, sz: 0.01 });
      add(g, G.box, toon(0x81d4fa), -0.07, 0.04, 0.255, { sx: 0.05, sy: 0.05, sz: 0.01 });
      cyl(g, barrel, 0, 0.02, -0.38, 0.1, 0.62);
      add(g, G.torus, roof, 0, 0.02, -0.7, { s: 0.115 });
      add(g, G.torus, roof, 0, 0.02, -0.1, { s: 0.105 });
      add(g, G.box, toon(0x8d5a2b), 0, -0.13, 0.02, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0.02, -0.74);
      break;
    }
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
    case 'double_pea': {
      const pod = toon(0x9be15d), pea = toon(0xd4ff8a), barrel = toon(0x2e7d32), grip = toon(0x8d5a2b), gold = toon(0xffe066);
      for (const s of [-1, 1]) {
        add(g, G.sphereLo, pod, s * 0.068, 0, -0.17, { sx: 0.066, sy: 0.08, sz: 0.3 });
        for (let i = 0; i < 3; i++) add(g, G.sphereXS, pea, s * 0.068, 0.078, -0.06 - i * 0.12, { s: 0.044 });
        cyl(g, barrel, s * 0.068, 0, -0.47, 0.036, 0.28);
        add(g, G.torus, gold, s * 0.068, 0, -0.61, { s: 0.05 });
      }
      add(g, G.box, gold, 0, 0, -0.3, { sx: 0.22, sy: 0.03, sz: 0.045 });
      add(g, G.box, gold, 0, 0, -0.08, { sx: 0.22, sy: 0.03, sz: 0.045 });
      add(g, G.box, grip, 0, -0.11, 0.02, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.64);
      break;
    }
    case 'snow_pea': {
      const ice = toon(0x7cc8f5), blue = toon(0x2f86d0), pale = toon(0xd4f2ff), white = toon(WHITE), grip = toon(0x5d6b7a);
      add(g, G.sphereLo, ice, 0, 0, -0.17, { sx: 0.09, sy: 0.09, sz: 0.3 });
      for (let i = 0; i < 3; i++) add(g, G.sphereXS, pale, 0, 0.09, -0.04 - i * 0.12, { s: 0.05 });
      cyl(g, blue, 0, 0, -0.46, 0.042, 0.28);
      const rnd = mulberry(11);
      const up = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < 9; i++) {
        // frost crystals bristling from the pod
        const a = -0.9 + rnd() * 1.8;
        const dir = new THREE.Vector3(Math.sin(a), Math.cos(a), 0).normalize();
        const c = add(g, G.coneLo, i % 3 ? white : toon(0x9ae6ff), dir.x * 0.095, dir.y * 0.095, -0.02 - rnd() * 0.3, { sx: 0.02, sy: 0.09 + rnd() * 0.06, sz: 0.02 });
        c.quaternion.setFromUnitVectors(up, dir);
      }
      // snowflake at the muzzle
      for (let i = 0; i < 3; i++) add(g, G.box, white, 0, 0, -0.62, { sx: 0.15, sy: 0.018, sz: 0.018, rz: (i * PI) / 3 });
      add(g, G.sphereXS, basic(0x9ae6ff), 0, 0, -0.62, { s: 0.035 });
      add(g, G.box, grip, 0, -0.11, 0.02, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      muzzle.position.set(0, 0, -0.66);
      break;
    }
    case 'repeater': {
      const body = toon(0x2e7d32), drum = toon(0xff8f00), pea = toon(0xb9f57d), dark = toon(0x1b5e20), gold = toon(0xffe066);
      add(g, G.box, body, 0, 0, -0.12, { sx: 0.11, sy: 0.14, sz: 0.42 });
      cyl(g, dark, 0, 0.04, -0.56, 0.032, 0.4);
      cyl(g, dark, 0, -0.035, -0.56, 0.032, 0.4);
      add(g, G.torus, gold, 0, 0.04, -0.76, { s: 0.05 });
      add(g, G.torus, gold, 0, -0.035, -0.76, { s: 0.05 });
      // big round pea magazine on top
      add(g, G.cyl, drum, 0, 0.15, -0.14, { sx: 0.085, sy: 0.14, sz: 0.085, rz: PI / 2 });
      add(g, G.cyl, gold, 0, 0.15, -0.14, { sx: 0.035, sy: 0.18, sz: 0.035, rz: PI / 2 });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * PI * 2;
        for (const sx of [-1, 1]) add(g, G.sphereXS, pea, sx * 0.074, 0.15 + Math.sin(a) * 0.075, -0.14 + Math.cos(a) * 0.075, { s: 0.03 });
      }
      add(g, G.torus, drum, 0, 0.1, -0.3, { s: 0.05 }).rotation.y = PI / 2;
      add(g, G.box, toon(0x8d5a2b), 0, -0.11, 0.02, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      add(g, G.box, toon(0x8d5a2b), 0, -0.02, 0.26, { sx: 0.06, sy: 0.12, sz: 0.2 });
      muzzle.position.set(0, 0, -0.8);
      break;
    }
    case 'melon_lobber': {
      const rind = toon(0x2f8f3a), stripe = toon(0x1b5e20), flesh = toon(0xff6f91), gold = toon(0xffe066);
      cyl(g, rind, 0, 0, -0.24, 0.12, 0.42);
      for (const z of [-0.08, -0.24]) add(g, G.torus, stripe, 0, 0, z, { s: 0.128 });
      add(g, G.torus, flesh, 0, 0, -0.45, { s: 0.14 });
      add(g, G.torus, gold, 0, 0, -0.47, { s: 0.15 });
      add(g, G.sphere, melonMaterial(), 0, 0.02, -0.62, { sx: 0.2, sy: 0.19, sz: 0.21 });
      add(g, G.sphereLo, rind, 0, -0.1, -0.3, { sx: 0.07, sy: 0.05, sz: 0.12 }); // pump
      for (let i = 0; i < 5; i++) add(g, G.sphereXS, basic(0x222222), 0.115, 0.04 - i * 0.025, -0.1 - i * 0.07, { sx: 0.012, sy: 0.02, sz: 0.012 }); // seeds
      add(g, G.box, toon(0x8d5a2b), 0, -0.13, 0.04, { sx: 0.05, sy: 0.15, sz: 0.06, rx: 0.25 });
      add(g, G.box, rind, 0, -0.02, 0.1, { sx: 0.1, sy: 0.12, sz: 0.14 });
      muzzle.position.set(0, 0.02, -0.84);
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
      const isPlant = team === 'plant';
      const body = toon(isPlant ? 0x7ed957 : 0x7e57c2);
      const goo = basic(isPlant ? 0xb9f57d : 0x9cff57);
      add(g, G.sphereLo, body, 0, 0, -0.14, { sx: 0.09, sy: 0.09, sz: 0.26 });
      const jar = add(g, G.sphereXS, goo, 0, 0.1, -0.1, { s: 0.065 });
      jar.material = basic(isPlant ? 0xb9f57d : 0x9cff57, { transparent: true, opacity: 0.9 });
      cyl(g, toon(isPlant ? 0x2e7d32 : 0x4a3470), 0, 0, -0.36, 0.05, 0.22);
      add(g, G.cyl, toon(isPlant ? 0x2e7d32 : 0x4a3470), 0, 0, -0.5, { sx: 0.075, sy: 0.05, sz: 0.075, rx: PI / 2 });
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
  let shown = 1;
  let prev = true;
  let age = 0;
  return {
    root,
    tagY: 2.6,
    kick() {},
    update(c) {
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
  if (k === 'garden') return 'garden:' + (e.plantKind === 'cactus' ? 'cactus' : 'peashooter');
  if (k === 'projectile') return 'proj:' + (e.projKind || 'pea');
  if (k === 'mower') return e.state === 'destroyed' ? null : 'mower'; // a wrecked mower vanishes until it respawns
  if (k === 'sun') return 'sun';
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
    case 'garden:cactus': return buildCactus(e);
    case 'garden:peashooter': return buildPeashooter(e);
    case 'mower': return buildMower(e);
    case 'sun': return buildSun(e);
    default:
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

export const SHADOW_RADIUS = { char: 0.6, garden: 0.55, mower: 0.9, sprout: 0.45, sun: 0.0, proj: 0.0, rack: 0.0 };
