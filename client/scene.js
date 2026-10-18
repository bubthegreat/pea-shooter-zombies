// The backyard: static scenery, night-to-sunrise sky, and the layer that turns interpolated
// server entities into animated models.
import * as THREE from 'three';
import {
  toon, basic, G, add, buildModel, modelKey, makeBlob, SHADOW_RADIUS, getGlowTex, mulberry, gradientMap, itemInfo,
} from './models.js';
import { tagAlpha } from './tags.js';

const PI = Math.PI;
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ------------------------------------------------------------------ */
/* default world layout (overridden by welcome.config.world if present) */
/* ------------------------------------------------------------------ */

export const LAYOUT = {
  bounds: { minX: -30, maxX: 30, minZ: -50, maxZ: 30 },
  gate: { z: -48, minX: -20, maxX: 20 },
  garden: {
    columns: 9, startX: -16, stepX: 4,
    rows: [
      { z: 0, kind: 'peashooter' }, { z: 4, kind: 'cactus' }, { z: 8, kind: 'cactus' }, { z: 12, kind: 'peashooter' },
    ],
  },
  house: { minX: -25, maxX: 10, minZ: 30, maxZ: 45, height: 8 },
  garage: { minX: 12, maxX: 28, minZ: 30, maxZ: 45, height: 4, doorMinX: 14, doorMaxX: 26 },
  mowerHome: { x: 20, y: 0, z: 34 },
};

export function gardenSlots() {
  const g = LAYOUT.garden;
  const out = [];
  for (const row of g.rows) {
    for (let c = 0; c < g.columns; c++) out.push({ x: g.startX + c * g.stepX, z: row.z, kind: row.kind });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* canvas textures                                                     */
/* ------------------------------------------------------------------ */

function canvasTex(w, h, draw, rx = 1, ry = 1, repeat = true) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 4;
  return t;
}

function grassTexture(rx, ry, stripes = true, tint = 0) {
  return canvasTex(512, 512, (g, w, h) => {
    const light = tint ? '#5fb544' : '#7ad152';
    const dark = tint ? '#52a63a' : '#69c247';
    g.fillStyle = light;
    g.fillRect(0, 0, w, h);
    if (stripes) { g.fillStyle = dark; g.fillRect(0, h / 2, w, h / 2); }
    const r = mulberry(11 + tint);
    for (let i = 0; i < 2600; i++) {
      const x = r() * w, y = r() * h, len = 4 + r() * 9;
      g.strokeStyle = r() < 0.5 ? 'rgba(235,255,170,0.22)' : 'rgba(20,100,40,0.2)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 4, y - len);
      g.stroke();
    }
    for (let i = 0; i < 36; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.8)' : 'rgba(255,240,120,0.8)';
      g.beginPath();
      g.arc(r() * w, r() * h, 1.8, 0, PI * 2);
      g.fill();
    }
  }, rx, ry);
}

function dirtTexture(rx, ry) {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#8d5b3b';
    g.fillRect(0, 0, w, h);
    const r = mulberry(5);
    for (let i = 0; i < 700; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(60,30,15,0.3)' : 'rgba(210,160,110,0.25)';
      g.beginPath();
      g.arc(r() * w, r() * h, 1 + r() * 3, 0, PI * 2);
      g.fill();
    }
  }, rx, ry);
}

function pathTexture(rx, ry) {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#e8d5ae';
    g.fillRect(0, 0, w, h);
    const r = mulberry(9);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const ox = (y % 2) * 32;
        g.fillStyle = `hsl(${35 + r() * 10}, ${25 + r() * 15}%, ${70 + r() * 10}%)`;
        g.strokeStyle = 'rgba(120,90,50,0.55)';
        g.lineWidth = 3;
        const rx0 = x * 64 + ox + 3, ry0 = y * 64 + 3;
        g.beginPath();
        g.roundRect(rx0, ry0, 58, 58, 14);
        g.fill();
        g.stroke();
      }
    }
  }, rx, ry);
}

function sidingTexture(base, rx, ry) {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) {
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fillRect(0, y + 13, w, 3);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(0, y, w, 2);
    }
  }, rx, ry);
}

function shingleTexture(base, rx, ry) {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 3;
    for (let y = 0; y < 4; y++) {
      const oy = y * 32;
      for (let x = -1; x < 4; x++) {
        const ox = x * 32 + (y % 2) * 16;
        g.beginPath();
        g.arc(ox + 16, oy, 16, 0, PI);
        g.stroke();
      }
    }
  }, rx, ry);
}

function textSignTexture(text, bg, fg, w = 512, h = 128) {
  return canvasTex(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = fg;
    g.lineWidth = 8;
    g.strokeRect(8, 8, w - 16, h - 16);
    g.fillStyle = fg;
    let size = 76;
    const face = '"Comic Sans MS","Chalkboard SE","Trebuchet MS",sans-serif';
    g.font = `bold ${size}px ${face}`;
    while (size > 20 && g.measureText(text).width > w - 56) {
      size -= 4;
      g.font = `bold ${size}px ${face}`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 4);
  }, 1, 1, false);
}

function moonTexture() {
  return canvasTex(256, 256, (g) => {
    const grd = g.createRadialGradient(128, 128, 60, 128, 128, 128);
    grd.addColorStop(0, 'rgba(255,250,210,0.5)');
    grd.addColorStop(1, 'rgba(255,250,210,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#fff6c9';
    g.beginPath(); g.arc(128, 128, 78, 0, PI * 2); g.fill();
    g.fillStyle = 'rgba(210,195,140,0.55)';
    for (const [x, y, r] of [[100, 100, 14], [155, 150, 18], [120, 165, 9], [160, 100, 8]]) { g.beginPath(); g.arc(x, y, r, 0, PI * 2); g.fill(); }
    g.strokeStyle = '#6a5a3a'; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.arc(104, 120, 9, 0.15 * PI, 0.85 * PI); g.stroke();
    g.beginPath(); g.arc(152, 120, 9, 0.15 * PI, 0.85 * PI); g.stroke();
    g.beginPath(); g.arc(128, 135, 16, 0.1 * PI, 0.9 * PI); g.stroke();
  }, 1, 1, false);
}

function sunTexture() {
  return canvasTex(256, 256, (g) => {
    const grd = g.createRadialGradient(128, 128, 40, 128, 128, 128);
    grd.addColorStop(0, 'rgba(255,230,120,0.7)');
    grd.addColorStop(1, 'rgba(255,200,80,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#ffd93b';
    g.beginPath(); g.arc(128, 128, 62, 0, PI * 2); g.fill();
    g.fillStyle = '#ffe97a';
    g.beginPath(); g.arc(114, 112, 30, 0, PI * 2); g.fill();
    g.fillStyle = '#ffb300';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * PI * 2;
      g.save(); g.translate(128, 128); g.rotate(a);
      g.beginPath(); g.moveTo(-9, -72); g.lineTo(9, -72); g.lineTo(0, -102); g.closePath(); g.fill();
      g.restore();
    }
    g.fillStyle = '#5b3a1a';
    g.beginPath(); g.arc(108, 118, 7, 0, PI * 2); g.fill();
    g.beginPath(); g.arc(148, 118, 7, 0, PI * 2); g.fill();
    g.strokeStyle = '#5b3a1a'; g.lineWidth = 6; g.lineCap = 'round';
    g.beginPath(); g.arc(128, 128, 28, 0.15 * PI, 0.85 * PI); g.stroke();
    g.fillStyle = 'rgba(255,120,100,0.55)';
    g.beginPath(); g.arc(94, 140, 9, 0, PI * 2); g.fill();
    g.beginPath(); g.arc(162, 140, 9, 0, PI * 2); g.fill();
  }, 1, 1, false);
}

function emojiTexture(emoji, bg) {
  return canvasTex(128, 128, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    g.font = '84px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(emoji, 64, 70);
  }, 1, 1, false);
}

function tombTexture(text) {
  return canvasTex(128, 192, (g, w, h) => {
    g.fillStyle = '#c7ced6';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let i = 0; i < 30; i++) g.fillRect((i * 37) % w, (i * 53) % h, 6, 3);
    g.fillStyle = '#5c6670';
    g.font = 'bold 44px "Comic Sans MS","Chalkboard SE",sans-serif';
    g.textAlign = 'center';
    g.fillText(text, w / 2, 90);
    g.font = '40px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    g.fillText('\u{1F47B}', w / 2, 150);
  }, 1, 1, false);
}

/* ------------------------------------------------------------------ */
/* static mesh merging: keeps scenery to a few dozen draw calls         */
/* ------------------------------------------------------------------ */

function mergeStatic(root) {
  root.updateMatrixWorld(true);
  const buckets = new Map();
  const keep = [];
  root.traverse((o) => {
    if (o === root) return;
    if (!o.isMesh || o.isInstancedMesh || !o.geometry) return;
    const key = o.material.uuid + '|' + (o.castShadow ? 1 : 0) + (o.receiveShadow ? 1 : 0) + '|' + o.renderOrder;
    let b = buckets.get(key);
    if (!b) { b = { mat: o.material, cast: o.castShadow, receive: o.receiveShadow, ro: o.renderOrder, pos: [], nor: [], uv: [] }; buckets.set(key, b); }
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    b.pos.push(g.attributes.position.array);
    b.nor.push(g.attributes.normal.array);
    b.uv.push(g.attributes.uv ? g.attributes.uv.array : new Float32Array((g.attributes.position.count) * 2));
    g.dispose();
    keep.push(o);
  });
  for (const o of keep) o.parent.remove(o);
  const out = new THREE.Group();
  for (const b of buckets.values()) {
    const cat = (arrs) => {
      let n = 0;
      for (const a of arrs) n += a.length;
      const r = new Float32Array(n);
      let off = 0;
      for (const a of arrs) { r.set(a, off); off += a.length; }
      return r;
    };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cat(b.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(cat(b.nor), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(cat(b.uv), 2));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, b.mat);
    m.castShadow = b.cast;
    m.receiveShadow = b.receive;
    m.renderOrder = b.ro;
    m.matrixAutoUpdate = false;
    out.add(m);
  }
  // anything left (instanced meshes, sprites, groups with them) stays
  const rest = root.children.slice();
  for (const c of rest) out.add(c);
  return out;
}

/* ------------------------------------------------------------------ */
/* World                                                                */
/* ------------------------------------------------------------------ */

const KEYS = [
  // t, top, mid, hemiSky, hemiGround, hemiI, dir, dirI, stars, cloud
  [0.00, 0x0a1038, 0x2a3a88, 0x8c9cf0, 0x37523f, 1.55, 0xa8b8ff, 1.4, 1.0, 0x3a4a8a],
  [0.50, 0x141a55, 0x3f3d92, 0x8f94e8, 0x3a5a45, 1.55, 0xb0b8ff, 1.4, 1.0, 0x4a4a96],
  [0.75, 0x2a3a82, 0x9a5aa0, 0xc79ad0, 0x4a6a48, 1.75, 0xffb0c0, 1.6, 0.6, 0xc68aa8],
  [0.88, 0x4a78c8, 0xff9a6a, 0xffc0a0, 0x587a4a, 1.9, 0xffc890, 1.9, 0.1, 0xffb59a],
  [1.00, 0x4fb0f5, 0xcdeeff, 0xcfe9ff, 0x6a9a50, 2.0, 0xfff2d0, 2.3, 0.0, 0xffffff],
];
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

function sampleKeys(t, i, out) {
  // i: color column index; returns Color in out
  let a = KEYS[0], b = KEYS[KEYS.length - 1];
  for (let k = 0; k < KEYS.length - 1; k++) {
    if (t >= KEYS[k][0] && t <= KEYS[k + 1][0]) { a = KEYS[k]; b = KEYS[k + 1]; break; }
  }
  const f = a === b ? 0 : (t - a[0]) / (b[0] - a[0]);
  return out.copy(_c1.set(a[i])).lerp(_c2.set(b[i]), f);
}
function sampleNum(t, i) {
  let a = KEYS[0], b = KEYS[KEYS.length - 1];
  for (let k = 0; k < KEYS.length - 1; k++) {
    if (t >= KEYS[k][0] && t <= KEYS[k + 1][0]) { a = KEYS[k]; b = KEYS[k + 1]; break; }
  }
  const f = a === b ? 0 : (t - a[0]) / (b[0] - a[0]);
  return lerp(a[i], b[i], f);
}

export class World {
  constructor() {
    this.scene = new THREE.Scene();
    this.viewScene = new THREE.Scene(); // first-person gun lives here (separate depth)
    this.time01 = 0;
    this.shadowDone = false;
    this.windowMats = [];
    this.lanterns = [];
    this._buildLights();
    this._buildSky();
    this.props = new THREE.Group();
    this._buildGround();
    this._buildGarden();
    this._buildFence();
    this._buildHouse();
    this._buildGarage();
    this._buildScenery();
    const merged = mergeStatic(this.props);
    this.scene.add(merged);
    this._buildInstanced();
    this._buildSlotRing();
    this.setTime(0, 1);
  }

  /* ---- lights & sky ---- */

  _buildLights() {
    const s = this.scene;
    this.hemi = new THREE.HemisphereLight(0x8c9cf0, 0x37523f, 1.6);
    this.dirLight = new THREE.DirectionalLight(0xa8b8ff, 1.4);
    this.dirLight.target.position.set(0, 0, -8);
    this.dirLight.position.set(-30, 62, 52);
    this.dirLight.castShadow = true;
    const sh = this.dirLight.shadow;
    sh.mapSize.set(2048, 2048);
    sh.camera.left = -62; sh.camera.right = 62; sh.camera.top = 78; sh.camera.bottom = -78;
    sh.camera.near = 10; sh.camera.far = 220;
    sh.bias = -0.0006;
    sh.normalBias = 0.06;
    s.add(this.hemi, this.dirLight, this.dirLight.target);
    // garage light
    this.garageLight = new THREE.PointLight(0xffd9a0, 25, 18, 1.5);
    this.garageLight.position.set(20, 3.4, 37);
    s.add(this.garageLight);

    // first-person scene mirrors the main lighting (no shadows, no fog)
    this.vHemi = new THREE.HemisphereLight(0x8c9cf0, 0x37523f, 1.6);
    this.vDir = new THREE.DirectionalLight(0xa8b8ff, 1.4);
    this.vDir.position.set(0.6, 1, 0.8);
    this.viewScene.add(this.vHemi, this.vDir);
  }

  _buildSky() {
    const s = this.scene;
    s.fog = new THREE.Fog(0x2a3a88, 90, 430);
    s.background = new THREE.Color(0x2a3a88);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x0a1038) }, mid: { value: new THREE.Color(0x2a3a88) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; varying vec3 vP;
        void main(){ float h = normalize(vP).y; vec3 c = mix(mid, top, pow(clamp(h, 0.0, 1.0), 0.55));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(600, 24, 16), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    s.add(this.sky);

    // stars
    const n = 420;
    const pos = new Float32Array(n * 3);
    const r = mulberry(99);
    for (let i = 0; i < n; i++) {
      const th = r() * PI * 2, ph = Math.acos(0.05 + r() * 0.95);
      pos[i * 3] = Math.sin(ph) * Math.cos(th) * 560;
      pos[i * 3 + 1] = Math.cos(ph) * 560;
      pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * 560;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 1, fog: false, depthWrite: false });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    s.add(this.stars);

    // moon & sun are sprites that follow the camera
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTexture(), fog: false, depthWrite: false, transparent: true }));
    this.moon.scale.setScalar(70);
    this.moon.renderOrder = -8;
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTexture(), fog: false, depthWrite: false, transparent: true }));
    this.sunSprite.scale.setScalar(120);
    this.sunSprite.renderOrder = -8;
    s.add(this.moon, this.sunSprite);

    // clouds
    this.clouds = [];
    this.cloudMat = new THREE.MeshBasicMaterial({ color: 0x3a4a8a, fog: false });
    const cr = mulberry(31);
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group();
      const parts = 4 + ((cr() * 3) | 0);
      for (let k = 0; k < parts; k++) {
        add(g, G.sphereLo, this.cloudMat, (k - parts / 2) * 14 + cr() * 6, cr() * 5, cr() * 8, { sx: 14 + cr() * 8, sy: 8 + cr() * 4, sz: 10 + cr() * 4 });
      }
      const a = (i / 9) * PI * 2 + cr();
      g.position.set(Math.cos(a) * 320, 95 + cr() * 50, Math.sin(a) * 320 - 40);
      g.userData.speed = 1.2 + cr() * 1.5;
      this.scene.add(g);
      this.clouds.push(g);
    }
  }

  /** t01: 0 = night start, 1 = sunrise. */
  setTime(t01, dt) {
    const prev = this.time01;
    // ease toward the target so round restarts / wins glide instead of snap
    this.time01 = Math.abs(t01 - prev) < 0.0005 ? t01 : lerp(prev, t01, clamp(dt * 3, 0, 1));
    const t = clamp(this.time01, 0, 1);
    sampleKeys(t, 1, this.skyMat.uniforms.top.value);
    sampleKeys(t, 2, this.skyMat.uniforms.mid.value);
    this.scene.background.copy(this.skyMat.uniforms.mid.value);
    this.scene.fog.color.copy(this.skyMat.uniforms.mid.value);
    sampleKeys(t, 3, this.hemi.color);
    sampleKeys(t, 4, this.hemi.groundColor);
    this.hemi.intensity = sampleNum(t, 5);
    sampleKeys(t, 6, this.dirLight.color);
    this.dirLight.intensity = sampleNum(t, 7);
    this.vHemi.color.copy(this.hemi.color);
    this.vHemi.groundColor.copy(this.hemi.groundColor);
    this.vHemi.intensity = this.hemi.intensity;
    this.vDir.color.copy(this.dirLight.color);
    this.vDir.intensity = this.dirLight.intensity * 0.8;
    this.starMat.opacity = sampleNum(t, 8);
    this.stars.visible = this.starMat.opacity > 0.02;
    sampleKeys(t, 9, this.cloudMat.color);
    // windows glow warm at night, pale by day
    const night = 1 - smooth(0.6, 1.0, t);
    for (const m of this.windowMats) m.color.setRGB(lerp(0.75, 1.0, night), lerp(0.85, 0.82, night), lerp(1.0, 0.45, night));
    this.garageLight.intensity = 25 * night;
    this.moonFade = 1 - smooth(0.62, 0.8, t);
    this.sunUp = smooth(0.78, 1.0, t);
    this.moon.visible = this.moonFade > 0.01;
    this.moon.material.opacity = this.moonFade;
    this.sunSprite.visible = this.sunUp > 0.001;
    // shadow fades with weak light; keep the map static
  }

  update(dt, camera, now) {
    const p = camera.position;
    this.sky.position.copy(p);
    this.stars.position.copy(p);
    const t = this.time01;
    const sunY = lerp(-0.12, 0.42, this.sunUp);
    this.sunSprite.position.set(p.x + 60, p.y + 300 * sunY, p.z - 330);
    const moonY = lerp(0.62, 0.14, clamp(t / 0.7, 0, 1));
    this.moon.position.set(p.x - 150, p.y + 300 * moonY, p.z - 330);
    for (const c of this.clouds) {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 420) c.position.x = -420;
    }
    for (const l of this.lanterns) l.material.opacity = 0.75 + Math.sin(now * 0.004 + l.position.x) * 0.2;
    // slot ring pulse
    if (this.slotRing.visible) {
      const s = 1 + Math.sin(now * 0.008) * 0.08;
      this.slotRing.scale.set(s, s, s);
    }
  }

  /* ---- ground, paths ---- */

  _P(parent, geo, mat, x, y, z, o, cast = true, receive = true) {
    const m = add(parent, geo, mat, x, y, z, o);
    m.castShadow = cast;
    m.receiveShadow = receive;
    return m;
  }

  _buildGround() {
    const P = this.props;
    const b = LAYOUT.bounds;
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    // wide meadow outside the fence
    const outer = grassTexture(60, 60, false, 1);
    const outerMat = new THREE.MeshToonMaterial({ map: outer, gradientMap, color: 0xcfe8c0 });
    const og = new THREE.PlaneGeometry(900, 900).rotateX(-PI / 2);
    this._P(P, og, outerMat, 0, -0.02, -40, null, false, true);
    // striped lawn
    const lawn = grassTexture(w / 8, d / 8, true);
    const lawnMat = new THREE.MeshToonMaterial({ map: lawn, gradientMap });
    const lg = new THREE.PlaneGeometry(w, d).rotateX(-PI / 2);
    this._P(P, lg, lawnMat, 0, 0, (b.minZ + b.maxZ) / 2, null, false, true);
    // stone paths
    const pathMat = (rx, ry) => new THREE.MeshToonMaterial({ map: pathTexture(rx, ry), gradientMap });
    const pathGeo = (pw, pd) => new THREE.PlaneGeometry(pw, pd).rotateX(-PI / 2);
    this._P(P, pathGeo(3.4, 49), pathMat(1.7, 24.5), 0, 0.02, -26.2, null, false, true);
    this._P(P, pathGeo(2.8, 16), pathMat(1.4, 8), -7.5, 0.02, 22, null, false, true);
    // concrete driveway
    const conc = new THREE.MeshToonMaterial({ color: 0xcfd8dc, gradientMap });
    this._P(P, pathGeo(12, 17), conc, 20, 0.02, 21.5, null, false, true);
    for (let z = 14; z < 30; z += 4) this._P(P, pathGeo(12, 0.12), toon(0xa9b4ba), 20, 0.03, z, null, false, true);
  }

  _buildGarden() {
    const P = this.props;
    const g = LAYOUT.garden;
    const dirt = new THREE.MeshToonMaterial({ map: dirtTexture(10, 0.7), gradientMap });
    const wood = toon(0xc8955a);
    const mound = toon(0x7a4a33);
    const x0 = g.startX - 3, x1 = g.startX + (g.columns - 1) * g.stepX + 3;
    const len = x1 - x0, cx = (x0 + x1) / 2;
    for (const row of g.rows) {
      this._P(P, G.box, dirt, cx, 0.06, row.z, { sx: len, sy: 0.12, sz: 2.7 }, false, true);
      // wooden edge boards
      this._P(P, G.box, wood, cx, 0.14, row.z - 1.4, { sx: len + 0.3, sy: 0.28, sz: 0.2 }, true, true);
      this._P(P, G.box, wood, cx, 0.14, row.z + 1.4, { sx: len + 0.3, sy: 0.28, sz: 0.2 }, true, true);
      this._P(P, G.box, wood, x0 - 0.05, 0.14, row.z, { sx: 0.2, sy: 0.28, sz: 2.9 }, true, true);
      this._P(P, G.box, wood, x1 + 0.05, 0.14, row.z, { sx: 0.2, sy: 0.28, sz: 2.9 }, true, true);
      for (let c = 0; c < g.columns; c++) {
        this._P(P, G.sphere, mound, g.startX + c * g.stepX, 0.1, row.z, { sx: 0.6, sy: 0.07, sz: 0.6 }, false, true);
      }
      // sign at the left end showing which plant lives in the row
      const isPea = row.kind === 'peashooter';
      const tex = emojiTexture(isPea ? '\u{1F331}' : '\u{1F335}', isPea ? '#d9f5b5' : '#ffe9b0');
      const signMat = new THREE.MeshToonMaterial({ map: tex, gradientMap });
      this._P(P, G.cyl, wood, x0 - 1.6, 0.5, row.z, { sx: 0.06, sy: 1.0, sz: 0.06 });
      this._P(P, G.box, signMat, x0 - 1.6, 1.15, row.z, { sx: 0.12, sy: 0.9, sz: 0.9 }, true, false).rotation.y = 0;
    }
    // watering can + sprinkler for coziness
    this._P(P, G.cyl, toon(0x4fc3f7), x1 + 2.3, 0.3, 14.5, { sx: 0.3, sy: 0.6, sz: 0.3 });
    this._P(P, G.cyl, toon(0x4fc3f7), x1 + 2.3 + 0.38, 0.45, 14.5, { sx: 0.06, sy: 0.5, sz: 0.06, rz: -0.9 });
  }

  _fenceSegments() {
    const b = LAYOUT.bounds;
    const gz = b.minZ;
    return [
      // far end: broken either side of the open gate
      { a: [b.minX, gz], b: [LAYOUT.gate.minX - 1.0, gz] },
      { a: [LAYOUT.gate.maxX + 1.0, gz], b: [b.maxX, gz] },
      // sides
      { a: [b.minX, gz], b: [b.minX, b.maxZ] },
      { a: [b.maxX, gz], b: [b.maxX, b.maxZ] },
      // house end, around the house and garage
      { a: [b.minX, b.maxZ], b: [LAYOUT.house.minX, b.maxZ] },
      { a: [LAYOUT.garage.maxX, b.maxZ], b: [b.maxX, b.maxZ] },
    ];
  }

  _buildFence() {
    const P = this.props;
    const rail = toon(0xe0c8a0);
    const segs = this._fenceSegments();
    this.picketXforms = [];
    for (const s of segs) {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
      const len = Math.hypot(dx, dz);
      const cx = (s.a[0] + s.b[0]) / 2, cz = (s.a[1] + s.b[1]) / 2;
      const along = Math.abs(dx) > Math.abs(dz); // runs along x
      for (const y of [0.55, 1.35]) {
        this._P(P, G.box, rail, cx, y, cz, along ? { sx: len, sy: 0.14, sz: 0.1 } : { sx: 0.1, sy: 0.14, sz: len });
      }
      const n = Math.floor(len / 0.55);
      for (let i = 0; i <= n; i++) {
        const k = i / n;
        this.picketXforms.push({ x: s.a[0] + dx * k, z: s.a[1] + dz * k, rot: along ? 0 : PI / 2 });
      }
    }
  }

  _buildInstanced() {
    const s = this.scene;
    // pickets: pointed top shape
    const shape = new THREE.Shape();
    shape.moveTo(-0.15, 0);
    shape.lineTo(0.15, 0);
    shape.lineTo(0.15, 1.75);
    shape.lineTo(0, 2.0);
    shape.lineTo(-0.15, 1.75);
    shape.closePath();
    const pg = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
    pg.translate(0, 0, -0.04);
    const n = this.picketXforms.length;
    const pm = new THREE.InstancedMesh(pg, new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap }), n);
    pm.castShadow = true;
    pm.receiveShadow = true;
    const d = new THREE.Object3D();
    const col = new THREE.Color();
    const r = mulberry(4);
    this.picketXforms.forEach((p, i) => {
      d.position.set(p.x, 0, p.z);
      d.rotation.set(0, p.rot, 0);
      d.scale.set(1, 0.88 + r() * 0.2, 1);
      d.updateMatrix();
      pm.setMatrixAt(i, d.matrix);
      pm.setColorAt(i, col.setHSL(0.1 + r() * 0.03, 0.6 + r() * 0.3, 0.88 + r() * 0.08));
    });
    s.add(pm);

    // flowers & tufts in the lawn
    const rnd = mulberry(21);
    const bad = (x, z) => {
      if (z > -2.6 && z < 14.6 && x > -22 && x < 22) return true; // garden
      if (Math.abs(x) < 2.4 && z < 0) return true; // path to gate
      if (Math.abs(x + 7.5) < 2.2 && z > 12) return true;
      if (x > 13 && x < 27 && z > 12) return true; // driveway
      if (x < -28 || x > 28 || z < -48 || z > 28.5) return true;
      return false;
    };
    const pts = [];
    while (pts.length < 170) {
      const x = -29 + rnd() * 58, z = -48 + rnd() * 76;
      if (!bad(x, z)) pts.push({ x, z });
    }
    const stemGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.4, 4).translate(0, 0.2, 0);
    const stems = new THREE.InstancedMesh(stemGeo, toon(0x3fa34d), pts.length);
    const headGeo = new THREE.SphereGeometry(0.09, 8, 6).translate(0, 0.42, 0);
    const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap }), pts.length);
    const pal = [0xff6fa8, 0xffd93b, 0xffffff, 0xb388ff, 0xff8a65, 0x4fc3f7];
    pts.forEach((p, i) => {
      d.position.set(p.x, 0, p.z);
      d.rotation.set(0, rnd() * 6, 0);
      const sc = 0.8 + rnd() * 0.7;
      d.scale.set(sc, sc, sc);
      d.updateMatrix();
      stems.setMatrixAt(i, d.matrix);
      heads.setMatrixAt(i, d.matrix);
      heads.setColorAt(i, col.set(pal[(rnd() * pal.length) | 0]));
    });
    s.add(stems, heads);

    const tN = 420;
    const tuftGeo = new THREE.ConeGeometry(0.05, 0.32, 4).translate(0, 0.16, 0);
    const tufts = new THREE.InstancedMesh(tuftGeo, new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap }), tN * 3);
    let ti = 0;
    for (let i = 0; i < tN; i++) {
      const x = -29 + rnd() * 58, z = -48 + rnd() * 76;
      if (bad(x, z)) continue;
      for (let k = 0; k < 3; k++) {
        d.position.set(x + (k - 1) * 0.08, 0, z + (rnd() - 0.5) * 0.1);
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

  /* ---- house ---- */

  _buildHouse() {
    const P = this.props;
    const h = LAYOUT.house;
    const w = h.maxX - h.minX, dp = h.maxZ - h.minZ, ht = h.height;
    const cx = (h.minX + h.maxX) / 2, cz = (h.minZ + h.maxZ) / 2;
    const siding = new THREE.MeshToonMaterial({ map: sidingTexture('#ffe2a6', 1, ht / 2), gradientMap });
    this._P(P, G.box, siding, cx, ht / 2, cz, { sx: w, sy: ht, sz: dp });
    // foundation
    this._P(P, G.box, toon(0xb0a99a), cx, 0.35, cz, { sx: w + 0.4, sy: 0.7, sz: dp + 0.4 });
    // roof
    const roofMat = new THREE.MeshToonMaterial({ map: shingleTexture('#c6554b', 10, 3), gradientMap, side: THREE.DoubleSide });
    const rise = 4.2, over = 0.9;
    const halfD = dp / 2 + over;
    const slope = Math.hypot(halfD, rise);
    const ang = Math.atan2(rise, halfD);
    const rz = cz;
    for (const sgn of [-1, 1]) {
      const m = this._P(P, G.box, roofMat, cx, ht + rise / 2 + 0.1, rz + sgn * halfD / 2, { sx: w + over * 2, sy: 0.3, sz: slope + 0.2 });
      m.rotation.x = sgn < 0 ? -ang : ang; // front slope rises toward +z
    }
    const gableMat = toon(0xffd68a, { side: THREE.DoubleSide });
    const sh = new THREE.Shape();
    sh.moveTo(-halfD + over, 0); sh.lineTo(halfD - over, 0); sh.lineTo(0, rise); sh.closePath();
    for (const [x, rot] of [[h.maxX + 0.01, PI / 2], [h.minX - 0.01, -PI / 2]]) {
      const gg = new THREE.ShapeGeometry(sh);
      const m = this._P(P, gg, gableMat, x, ht, cz, null);
      m.rotation.y = rot;
    }
    // chimney
    const brick = toon(0xb85c45);
    this._P(P, G.box, brick, h.minX + 8, ht + 3.2, cz + 1.5, { sx: 1.4, sy: 3.2, sz: 1.4 });
    this._P(P, G.box, toon(0x8d4a38), h.minX + 8, ht + 4.9, cz + 1.5, { sx: 1.7, sy: 0.3, sz: 1.7 });
    // front door
    const zf = h.minZ - 0.05;
    const doorX = -7.5;
    this._P(P, G.box, toon(0xffffff), doorX, 1.8, zf, { sx: 2.4, sy: 3.7, sz: 0.2 });
    this._P(P, G.box, toon(0x26a69a), doorX, 1.7, zf - 0.1, { sx: 1.9, sy: 3.4, sz: 0.15 });
    this._P(P, G.sphere, toon(0xffd54f), doorX + 0.65, 1.7, zf - 0.22, { s: 0.11 });
    this._P(P, G.cyl, toon(0xb2ebf2), doorX, 2.7, zf - 0.19, { sx: 0.45, sy: 0.04, sz: 0.45, rx: PI / 2 });
    this._P(P, G.box, toon(0xcfd8dc), doorX, 0.12, zf - 1.1, { sx: 3.2, sy: 0.24, sz: 1.8 });
    this._P(P, G.box, toon(0xb0bec5), doorX, 0.3, zf - 0.7, { sx: 3.0, sy: 0.2, sz: 1.0 });
    this._P(P, G.box, toon(0xe53935), doorX, 4.2, zf - 0.75, { sx: 3.2, sy: 0.14, sz: 1.8, rx: 0.35 });
    // porch light
    const glow = basic(0xfff3b0);
    this.windowMats.push(glow);
    this._P(P, G.sphere, glow, doorX + 1.9, 3.2, zf - 0.15, { s: 0.2 }, false, false);
    // windows
    const frame = toon(0xffffff);
    const glass = basic(0xffe9a0);
    this.windowMats.push(glass);
    const shutter = [toon(0x4fc3f7), toon(0xff8a65)];
    const winXs = [-21, -14, 0, 6];
    const mk = (x, y, i) => {
      this._P(P, G.box, frame, x, y, zf, { sx: 2.4, sy: 2.7, sz: 0.2 });
      this._P(P, G.box, glass, x, y, zf - 0.08, { sx: 2.0, sy: 2.3, sz: 0.1 }, false, false);
      this._P(P, G.box, frame, x, y, zf - 0.14, { sx: 0.1, sy: 2.3, sz: 0.08 });
      this._P(P, G.box, frame, x, y, zf - 0.14, { sx: 2.0, sy: 0.1, sz: 0.08 });
      for (const s of [-1, 1]) this._P(P, G.box, shutter[i % 2], x + s * 1.55, y, zf - 0.1, { sx: 0.7, sy: 2.7, sz: 0.1 });
      this._P(P, G.box, frame, x, y - 1.45, zf - 0.25, { sx: 2.7, sy: 0.14, sz: 0.5 });
    };
    winXs.forEach((x, i) => mk(x, 3.1, i));
    [-21, -14, doorX, 0, 6].forEach((x, i) => mk(x, 6.1, i + 1));
    // flower boxes under the lower windows
    const fr = mulberry(77);
    for (const x of winXs) {
      this._P(P, G.box, toon(0x8d5a2b), x, 1.5, zf - 0.55, { sx: 2.2, sy: 0.35, sz: 0.4 });
      for (let k = 0; k < 6; k++) {
        const col = [0xff6fa8, 0xffd93b, 0xb388ff, 0xff8a65][(fr() * 4) | 0];
        this._P(P, G.sphere, toon(col), x - 0.9 + k * 0.36, 1.82, zf - 0.55, { s: 0.14 }, false, false);
        this._P(P, G.sphere, toon(0x4caf50), x - 0.9 + k * 0.36 + 0.1, 1.72, zf - 0.6, { s: 0.12 }, false, false);
      }
    }
    // bushes + gnomes along the wall
    for (const x of [-24, -11, -3.5, 3, 9]) {
      this._P(P, G.sphereLo, toon(0x3fa34d), x, 0.6, h.minZ - 0.9, { sx: 1.0, sy: 0.7, sz: 0.8 });
      this._P(P, G.sphereLo, toon(0x57bb5e), x + 0.7, 0.5, h.minZ - 1.0, { sx: 0.7, sy: 0.55, sz: 0.6 });
    }
    // hedge filling the narrow gap between house and garage
    const hedge = toon(0x3a9a48);
    this._P(P, G.box, hedge, 11, 1.6, 36, { sx: 2, sy: 3.2, sz: 14 });
    for (let k = 0; k < 4; k++) this._P(P, G.sphereLo, toon(0x4cb55a), 11, 3.1, 31 + k * 1.2, { sx: 1.1, sy: 0.7, sz: 0.8 });
    this._gnome(P, -10.8, h.minZ - 1.0, 0x1e88e5);
    this._gnome(P, -4.2, h.minZ - 1.1, 0xe53935);
  }

  _gnome(P, x, z, hatColor) {
    this._P(P, G.cyl, toon(0x1565c0), x, 0.3, z, { sx: 0.17, sy: 0.6, sz: 0.17 });
    this._P(P, G.sphere, toon(0xffccaa), x, 0.7, z - 0.05, { s: 0.15 });
    this._P(P, G.cone, toon(WHITE_), x, 0.52, z - 0.12, { sx: 0.17, sy: 0.3, sz: 0.1 }).rotation.x = PI;
    this._P(P, G.cone, toon(hatColor), x, 1.0, z, { sx: 0.17, sy: 0.5, sz: 0.17 });
  }

  /* ---- garage ---- */

  _buildGarage() {
    const P = this.props;
    const g = LAYOUT.garage;
    const w = g.maxX - g.minX, dp = g.maxZ - g.minZ, ht = g.height;
    const cx = (g.minX + g.maxX) / 2, cz = (g.minZ + g.maxZ) / 2;
    const sid = new THREE.MeshToonMaterial({ map: sidingTexture('#bfe6ff', 1, ht / 2), gradientMap });
    const sidIn = new THREE.MeshToonMaterial({ map: sidingTexture('#f4efe2', 1, ht / 2), gradientMap, side: THREE.DoubleSide });
    const t = 0.4;
    // floor
    this._P(P, G.box, toon(0xb7c0c6), cx, 0.0, cz, { sx: w, sy: 0.04, sz: dp }, false, true);
    // back & side walls
    this._P(P, G.box, sid, cx, ht / 2, g.maxZ - t / 2, { sx: w, sy: ht, sz: t });
    this._P(P, G.box, sid, g.minX + t / 2, ht / 2, cz, { sx: t, sy: ht, sz: dp });
    this._P(P, G.box, sid, g.maxX - t / 2, ht / 2, cz, { sx: t, sy: ht, sz: dp });
    // inner skin so the room is lighter
    this._P(P, G.box, sidIn, cx, ht / 2, g.maxZ - t - 0.01, { sx: w - 2 * t, sy: ht, sz: 0.02 }, false, true);
    this._P(P, G.box, sidIn, g.minX + t + 0.01, ht / 2, cz, { sx: 0.02, sy: ht, sz: dp - 2 * t }, false, true);
    this._P(P, G.box, sidIn, g.maxX - t - 0.01, ht / 2, cz, { sx: 0.02, sy: ht, sz: dp - 2 * t }, false, true);
    // front: pillars either side of the door and a lintel
    const pw = g.doorMinX - g.minX;
    this._P(P, G.box, sid, g.minX + pw / 2, ht / 2, g.minZ + t / 2, { sx: pw, sy: ht, sz: t });
    this._P(P, G.box, sid, g.maxX - pw / 2, ht / 2, g.minZ + t / 2, { sx: pw, sy: ht, sz: t });
    const doorH = 3.2;
    this._P(P, G.box, sid, cx, (ht + doorH) / 2, g.minZ + t / 2, { sx: g.doorMaxX - g.doorMinX, sy: ht - doorH, sz: t });
    // door trim
    const trim = toon(0xffffff);
    this._P(P, G.box, trim, cx, doorH + 0.08, g.minZ - 0.02, { sx: g.doorMaxX - g.doorMinX + 0.5, sy: 0.18, sz: 0.2 });
    for (const x of [g.doorMinX, g.doorMaxX]) this._P(P, G.box, trim, x, doorH / 2, g.minZ - 0.02, { sx: 0.18, sy: doorH, sz: 0.2 });
    // rolled-up door at the top (stripes)
    this._P(P, G.box, toon(0xf5f5f5), cx, doorH - 0.2, g.minZ + 0.7, { sx: g.doorMaxX - g.doorMinX - 0.2, sy: 0.4, sz: 0.5 });
    // sign
    const signMat = new THREE.MeshToonMaterial({ map: textSignTexture('GARAGE', '#ffe082', '#6d4c41'), gradientMap });
    this._P(P, G.box, signMat, cx, ht - 0.35, g.minZ - 0.15, { sx: 4.4, sy: 0.55, sz: 0.1 }, true, false);
    // roof
    const roofMat = new THREE.MeshToonMaterial({ map: shingleTexture('#5c7cc0', 6, 2), gradientMap, side: THREE.DoubleSide });
    const rise = 2.4, over = 0.7, halfD = dp / 2 + over;
    const slope = Math.hypot(halfD, rise), ang = Math.atan2(rise, halfD);
    for (const sgn of [-1, 1]) {
      const m = this._P(P, G.box, roofMat, cx, ht + rise / 2 + 0.1, cz + sgn * halfD / 2, { sx: w + over * 2, sy: 0.28, sz: slope + 0.2 });
      m.rotation.x = sgn < 0 ? -ang : ang;
    }
    const sh = new THREE.Shape();
    sh.moveTo(-halfD + over, 0); sh.lineTo(halfD - over, 0); sh.lineTo(0, rise); sh.closePath();
    const gableMat = toon(0xa9d8f5, { side: THREE.DoubleSide });
    for (const [x, rot] of [[g.maxX + 0.01, PI / 2], [g.minX - 0.01, -PI / 2]]) {
      const m = this._P(P, new THREE.ShapeGeometry(sh), gableMat, x, ht, cz, null);
      m.rotation.y = rot;
    }
    // clutter inside
    const cr = mulberry(55);
    this._P(P, G.box, toon(0xa1887f), 26.4, 0.9, 40, { sx: 1.0, sy: 1.8, sz: 5 });
    for (let i = 0; i < 6; i++) {
      this._P(P, G.cyl, toon([0xff7043, 0x4fc3f7, 0xffd54f, 0x9ccc65][i % 4]), 26.4, 1.95, 38 + i * 0.9, { sx: 0.25, sy: 0.35, sz: 0.25 });
    }
    this._P(P, G.box, toon(0xd7a86e), 13.3, 0.5, 42, { sx: 1.0, sy: 1.0, sz: 1.0 });
    this._P(P, G.box, toon(0xe6b980), 13.4, 1.4, 42.2, { sx: 0.8, sy: 0.8, sz: 0.8, ry: 0.4 });
    this._P(P, G.box, toon(0x607d8b), 17, 0.45, 43.9, { sx: 3, sy: 0.9, sz: 0.8 });
    this._P(P, G.cyl, toon(0x37474f), 23.5, 0.5, 43.6, { sx: 0.5, sy: 1.0, sz: 0.5 });
    // bulb
    const bulb = basic(0xfff3b0);
    this.windowMats.push(bulb);
    this._P(P, G.cyl, toon(0x37474f), 20, 3.7, 37, { sx: 0.02, sy: 0.6, sz: 0.02 });
    this._P(P, G.sphere, bulb, 20, 3.35, 37, { s: 0.2 }, false, false);
    void cr;
  }

  /* ---- scenery beyond the fence ---- */

  _buildScenery() {
    const P = this.props;
    const r = mulberry(1234);
    const b = LAYOUT.bounds;
    // gate pillars with grinning lanterns
    for (const sx of [-1, 1]) {
      const x = sx * (LAYOUT.gate.maxX + 1.2), z = b.minZ;
      this._P(P, G.cyl, toon(0x9aa5ad), x, 1.8, z, { sx: 0.8, sy: 3.6, sz: 0.8 });
      this._P(P, G.cyl, toon(0xb0bec5), x, 3.7, z, { sx: 1.05, sy: 0.3, sz: 1.05 });
      const lantern = add(P, G.sphere, basic(0xb8f56a, { transparent: true, opacity: 0.9 }), x, 4.5, z, { s: 0.75 });
      this.lanterns.push(lantern);
      const faceZ = z + 0.62;
      add(P, G.sphere, basic(0x2b2438), x - 0.25, 4.65, faceZ, { s: 0.14 });
      add(P, G.sphere, basic(0x2b2438), x + 0.25, 4.65, faceZ, { s: 0.14 });
      const sm = add(P, G.smile, basic(0x2b2438), x, 4.4, faceZ, { s: 0.3 });
      sm.rotation.z = PI;
    }
    // zombie gate banner on two posts
    const bannerMat = new THREE.MeshToonMaterial({ map: textSignTexture('ZOMBIE GATE', '#7e57c2', '#f3e5f5'), gradientMap });
    for (const x of [-5.5, 5.5]) this._P(P, G.cyl, toon(0x6d4c41), x, 2.4, b.minZ - 1.2, { sx: 0.18, sy: 4.8, sz: 0.18 });
    this._P(P, G.box, bannerMat, 0, 4.6, b.minZ - 1.2, { sx: 11, sy: 2.0, sz: 0.2 }, true, false).rotation.y = PI;
    // fallen pickets near the gate
    for (let i = 0; i < 7; i++) {
      this._P(P, G.box, toon(0xf3e3c0), -14 + i * 4.5 + r() * 2, 0.06, b.minZ + 0.5 + r() * 1.2, { sx: 0.3, sy: 0.08, sz: 1.5, ry: r() * 3 }, false, true);
    }
    // tombstones beyond the gate
    const tMat = [new THREE.MeshToonMaterial({ map: tombTexture('BOO!'), gradientMap }), new THREE.MeshToonMaterial({ map: tombTexture('ZZZ'), gradientMap })];
    for (let i = 0; i < 9; i++) {
      const x = -26 + i * 6.5 + r() * 2, z = b.minZ - 5 - r() * 14;
      const m = this._P(P, G.box, tMat[i % 2], x, 1.0, z, { sx: 1.3, sy: 2.0, sz: 0.4 });
      m.rotation.set(0, PI + (r() - 0.5) * 0.5, (r() - 0.5) * 0.2);
      const top = this._P(P, G.cyl, toon(0xc7ced6), x, 2.0, z, { sx: 0.65, sy: 0.4, sz: 0.65 });
      top.rotation.order = 'YXZ';
      top.rotation.set(PI / 2, m.rotation.y, 0);
    }
    // trees + hills (merged: cheap)
    const trunk = toon(0x8d5a2b);
    const greens = [toon(0x4caf50), toon(0x66bb6a), toon(0x2e9e4f), toon(0x7ac74f)];
    const blossom = toon(0xff9ec4);
    const inside = (x, z) => x > -36 && x < 36 && z > -56 && z < 52;
    let placed = 0;
    while (placed < 55) {
      const x = -120 + r() * 240, z = -150 + r() * 220;
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
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * PI * 2 + r() * 0.3;
      const rad = 210 + r() * 90;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad - 20;
      const s = 40 + r() * 50;
      this._P(P, G.sphere, hillMat[i % 3], x, -s * 0.35, z, { sx: s * 1.6, sy: s * 0.8, sz: s * 1.2 }, false, false);
    }
    // neighbours' fence + a bird house far behind (just for charm)
    this._P(P, G.cyl, toon(0x8d5a2b), -40, 2.5, 18, { sx: 0.12, sy: 5, sz: 0.12 });
    this._P(P, G.box, toon(0xff8a65), -40, 5.3, 18, { sx: 0.8, sy: 0.8, sz: 0.8 });
    this._P(P, G.cone, toon(0x6d4c41), -40, 6.0, 18, { sx: 0.7, sy: 0.5, sz: 0.7 }).rotation.y = PI / 4;
  }

  /* ---- slot highlight ring ---- */

  _buildSlotRing() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 1.0, 28).rotateX(-PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xfff176, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.position.y = 0.16;
    ring.visible = false;
    ring.renderOrder = 2;
    this.scene.add(ring);
    this.slotRing = ring;
  }

  showSlot(x, z, ok) {
    this.slotRing.visible = true;
    this.slotRing.position.set(x, 0.16, z);
    this.slotRing.material.color.set(ok ? 0xb9f57d : 0xfff176);
  }

  hideSlot() {
    this.slotRing.visible = false;
  }
}

const WHITE_ = 0xffffff;

/* ------------------------------------------------------------------ */
/* entity layer                                                         */
/* ------------------------------------------------------------------ */

const barGeo = new THREE.PlaneGeometry(1, 1);
const barBgMat = new THREE.MeshBasicMaterial({ color: 0x1a1a2a, transparent: true, opacity: 0.55, depthWrite: false });
const barFillMats = {
  plant: new THREE.MeshBasicMaterial({ color: 0x6be04f, depthWrite: false }),
  zombie: new THREE.MeshBasicMaterial({ color: 0xb36bff, depthWrite: false }),
};
// Name-tag textures, drawn once per (team, name) and shared. Bounded: names can change mid-game, so old ones are dropped.
const nameTex = new Map(); // insertion order = least recently used first
const NAME_TEX_MAX = 120;
const TAG_COLORS = {
  plant: { fill: 'rgba(14,58,22,0.82)', stroke: '#7ee040' },
  zombie: { fill: 'rgba(52,22,86,0.82)', stroke: '#c08bff' },
};
function nameTexture(name, team) {
  const t = team === 'zombie' ? 'zombie' : 'plant';
  const key = t + '|' + name;
  let tex = nameTex.get(key);
  if (tex) {
    nameTex.delete(key);
    nameTex.set(key, tex);
    return tex;
  }
  const col = TAG_COLORS[t];
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = col.fill;
  g.beginPath(); g.roundRect(4, 6, 248, 52, 26); g.fill();
  g.lineWidth = 5;
  g.strokeStyle = col.stroke;
  g.stroke();
  const text = [...name].slice(0, 16).join('');
  let size = 32;
  const font = (px) => `bold ${px}px "Comic Sans MS","Chalkboard SE","Trebuchet MS",sans-serif`;
  g.font = font(size);
  while (size > 14 && g.measureText(text).width > 216) g.font = font((size -= 2)); // long names shrink to fit the pill
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.strokeText(text, 128, 35);
  g.fillStyle = '#fff';
  g.fillText(text, 128, 35);
  tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  nameTex.set(key, tex);
  if (nameTex.size > NAME_TEX_MAX) {
    const [oldKey, old] = nameTex.entries().next().value;
    nameTex.delete(oldKey);
    old.dispose();
  }
  return tex;
}

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

const _dir = new THREE.Vector3();

export class EntityLayer {
  constructor(scene) {
    this.scene = scene;
    this.recs = new Map();
    this.frame = 0;
    this.added = [];
    this.removed = [];
  }

  sync(entities, selfId, ctx) {
    this.frame++;
    this.added.length = 0;
    this.removed.length = 0;
    const mowers = [];
    for (const e of entities.values()) if (e.kind === 'mower' && (e.state === 'driving' || e.state === 'starting')) mowers.push(e);
    for (const [id, e] of entities) {
      if (id === selfId) continue;
      if (!Number.isFinite(e.x) || !Number.isFinite(e.z)) continue;
      const key = modelKey(e);
      let rec = this.recs.get(id);
      if (!key) {
        if (rec) this._remove(id, rec);
        continue;
      }
      if (rec && rec.key !== key) {
        this._remove(id, rec, true);
        rec = null;
      }
      if (!rec) rec = this._create(id, e, key);
      if (!rec) continue;
      rec.seen = this.frame;
      this._update(rec, e, ctx, mowers);
    }
    for (const [id, rec] of this.recs) if (rec.seen !== this.frame) this._remove(id, rec);
  }

  _create(id, e, key) {
    let model;
    try {
      model = buildModel(e);
    } catch (err) {
      console.error('model build failed for', e, err);
      return null;
    }
    if (!model) return null;
    const root = new THREE.Group();
    root.add(model.root);
    let blob = null;
    const kindKey = key.split(':')[0];
    const br = kindKey === 'garden' ? 0 : SHADOW_RADIUS[kindKey] || 0; // garden plants already sit on dark mounds
    if (br > 0) {
      blob = makeBlob(br);
      root.add(blob);
    }
    this.scene.add(root);
    const rec = {
      id, key, model, root, blob, tag: null, tagBar: null, tagName: null,
      x: e.x, y: e.y || 0, z: e.z, speed: 0, age: 0, seen: this.frame,
      dirX: 0, dirY: 0, dirZ: -1, e, kind: e.kind, team: e.team, hasDir: false,
    };
    this.recs.set(id, rec);
    this.added.push(rec);
    return rec;
  }

  _remove(id, rec, silent = false) {
    this.scene.remove(rec.root);
    rec.root.traverse((o) => { if (o.isMesh && o.geometry.userData.baked) o.geometry.dispose(); });
    if (rec.tag) this.scene.remove(rec.tag);
    if (rec.tagMat) rec.tagMat.dispose();
    this.recs.delete(id);
    if (!silent) this.removed.push(rec);
  }

  _update(rec, e, ctx, mowers) {
    const dt = ctx.dt;
    const x = e.x, y = Number.isFinite(e.y) ? e.y : 0, z = e.z;
    const dx = x - rec.x, dz = z - rec.z, dy = y - rec.y;
    if (dt > 0) {
      const sp = Math.hypot(dx, dz) / dt;
      rec.speed += (Math.min(sp, 30) - rec.speed) * Math.min(1, dt * 10);
    }
    const model = rec.model;
    rec.root.position.set(x, y, z);
    const yaw = Number.isFinite(e.yaw) ? e.yaw : 0;
    const pitch = Number.isFinite(e.pitch) ? e.pitch : 0;
    if (model.projectile) {
      // shots start right in front of the camera: shrink them there so they don't block the view
      const dc = Math.hypot(x - ctx.camera.position.x, y - ctx.camera.position.y, z - ctx.camera.position.z);
      rec.projScale = clamp((dc - 1.0) / 4, 0.04, 1);
      const m = Math.hypot(dx, dy, dz);
      if (m > 1e-4) {
        rec.dirX = dx / m; rec.dirY = dy / m; rec.dirZ = dz / m;
        rec.hasDir = true;
      } else if (!rec.hasDir) {
        rec.dirX = -Math.sin(yaw) * Math.cos(pitch); rec.dirY = Math.sin(pitch); rec.dirZ = -Math.cos(yaw) * Math.cos(pitch);
      }
      const h = Math.hypot(rec.dirX, rec.dirZ);
      rec.root.rotation.set(Math.atan2(rec.dirY, h), Math.atan2(-rec.dirX, -rec.dirZ), 0, 'YXZ');
    } else if (model.ownYaw) {
      rec.root.rotation.y = 0;
    } else if (model.faceCamera) {
      rec.root.rotation.y = 0;
    } else {
      rec.root.rotation.y = yaw;
    }
    rec.x = x; rec.y = y; rec.z = z;
    rec.age += dt;
    rec.e = e;
    // spawn pop
    if (!model.projectile && rec.age < 0.35) {
      const k = easeOutBack(clamp(rec.age / 0.35, 0, 1));
      rec.root.scale.setScalar(Math.max(0.01, k));
    } else if (model.projectile) {
      rec.root.scale.setScalar(rec.projScale);
    } else if (rec.root.scale.x !== 1) {
      rec.root.scale.setScalar(1);
    }
    if (rec.blob) {
      rec.blob.position.y = -y + 0.03;
      const sh = clamp(1 - y * 0.25, 0.4, 1);
      rec.blob.scale.x = rec.blob.scale.z = (rec.blob.userData.r || (rec.blob.userData.r = rec.blob.scale.x)) * sh;
    }
    let riding = false;
    if (rec.key === 'char:zombie') {
      for (const m of mowers) {
        // the server names the driver; fall back to proximity for servers that don't
        const rides = m.driver === undefined ? Math.hypot(m.x - x, m.z - z) < 1.6 : m.driver !== null && String(m.driver) === String(e.id);
        if (rides) { riding = true; break; }
      }
    }
    try {
      model.update({
        t: ctx.t, dt, speed: rec.speed, e, state: e.state, riding, yaw, pitch,
        faceYaw: Math.atan2(-(ctx.camera.position.x - x), -(ctx.camera.position.z - z)),
      });
    } catch (err) {
      if (!rec.errored) { rec.errored = true; console.error('model update failed', e, err); }
    }
    this._updateTag(rec, e, ctx);
  }

  _updateTag(rec, e, ctx) {
    let label = '';
    if ((e.kind === 'player' || e.kind === 'bot') && typeof e.name === 'string') label = e.name; // kids and the Gardener
    else if (e.kind === 'rack_item' && e.available !== false) {
      // tool labels on the garage rack: visible from across the garage, hidden up close (the prompt takes over)
      const dc = Math.hypot(ctx.camera.position.x - rec.x, ctx.camera.position.z - rec.z);
      if (dc > 3.5 && dc < 32) label = itemInfo(e.itemId || String(e.id).replace(/^rack_/, '')).name;
    }
    const hasName = label !== '';
    const hurt = Number.isFinite(e.hp) && Number.isFinite(e.maxHp) && e.maxHp > 0 && e.hp < e.maxHp && e.hp > 0;
    const show = (hasName || hurt) && rec.model.tagY > 0 && e.state !== 'wilted' && e.state !== 'sprout';
    if (!show) {
      if (rec.tag) rec.tag.visible = false;
      return;
    }
    if (!rec.tag) {
      rec.tag = new THREE.Group();
      rec.tag.renderOrder = 10;
      const bg = new THREE.Mesh(barGeo, barBgMat);
      bg.scale.set(1.1, 0.14, 1);
      bg.renderOrder = 10;
      const fill = new THREE.Mesh(barGeo, barFillMats[e.team === 'zombie' ? 'zombie' : 'plant']);
      fill.renderOrder = 11;
      fill.position.z = 0.01;
      rec.tag.add(bg, fill);
      rec.tagBar = { bg, fill };
      this.scene.add(rec.tag);
    }
    const tag = rec.tag;
    tag.visible = true;
    const dist = Math.hypot(ctx.camera.position.x - rec.x, ctx.camera.position.z - rec.z);
    const sc = clamp(dist / 12, 1, 3);
    tag.scale.setScalar(sc);
    tag.position.set(rec.x, rec.y + rec.model.tagY, rec.z);
    tag.quaternion.copy(ctx.camera.quaternion);
    const { bg, fill } = rec.tagBar;
    bg.visible = fill.visible = hurt;
    if (hurt) {
      const f = clamp(e.hp / e.maxHp, 0.02, 1);
      fill.scale.set(1.0 * f, 0.09, 1);
      fill.position.x = -0.5 * (1 - f);
    }
    const alpha = tagAlpha(dist);
    if (hasName && !rec.tagName) {
      rec.tagMat = new THREE.SpriteMaterial({ map: nameTexture(label, e.team), transparent: true, depthWrite: false });
      const sp = new THREE.Sprite(rec.tagMat);
      sp.scale.set(2.2, 0.55, 1);
      sp.position.y = 0.45;
      sp.renderOrder = 12;
      rec.tag.add(sp);
      rec.tagName = sp;
      rec.tagLabel = label;
    } else if (hasName && rec.tagLabel !== label) {
      rec.tagMat.map = nameTexture(label, e.team);
      rec.tagMat.needsUpdate = true;
      rec.tagLabel = label;
    }
    if (rec.tagName) {
      rec.tagMat.opacity = alpha;
      rec.tagName.visible = hasName && alpha > 0.03;
      rec.tagName.position.y = hurt ? 0.5 : 0.1;
    }
  }

  /** Make nearby shooters recoil when a shot appears. */
  kickNear(x, z, radius = 1.6) {
    for (const rec of this.recs.values()) {
      if (rec.model.projectile) continue;
      if (Math.hypot(rec.x - x, rec.z - z) < radius) rec.model.kick();
    }
  }

  clear() {
    for (const [id, rec] of this.recs) this._remove(id, rec, true);
  }
}
