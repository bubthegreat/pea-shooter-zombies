// The backyard: static scenery, night-to-sunrise sky, and the layer that turns interpolated
// server entities into animated models.
import * as THREE from 'three';
import {
  toon, basic, G, add, buildModel, modelKey, makeBlob, SHADOW_RADIUS, getGlowTex, mulberry, gradientMap, itemInfo, makePartMesh, PART_INFO,
} from './models.js';
import { tagAlpha } from './tags.js';
import { Level } from './level.js';
import { CoverLayer } from './cover3d.js';
import { canvasTex, grassTexture, dirtTexture, pathTexture, sidingTexture, shingleTexture, textSignTexture, moonTexture, sunTexture, emojiTexture, tombTexture, mergeStatic } from './textures.js';

const PI = Math.PI;
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

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
    this.level = null;
    this.cover = null;
    this.map = null;
    this.state = { fridgeN: 0, gateOpen: false };
    this._buildLights();
    this._buildSky();
    this._buildBackdrop();
    this._buildSlotRing();
    this.setTime(0, 1);
  }

  /** A cozy lawn with a few trees for the lobby backdrop, until the first welcome brings the real map. */
  _buildBackdrop() {
    const g = new THREE.Group();
    const og = new THREE.PlaneGeometry(900, 900).rotateX(-PI / 2);
    const om = new THREE.Mesh(og, new THREE.MeshToonMaterial({ map: grassTexture(60, 60, false, 1), gradientMap, color: 0xcfe8c0 }));
    om.receiveShadow = true;
    g.add(om);
    const r = mulberry(77);
    const trunk = toon(0x8d5a2b);
    const greens = [toon(0x4caf50), toon(0x66bb6a), toon(0x2e9e4f)];
    const P = new THREE.Group();
    for (let i = 0; i < 22; i++) {
      const a = r() * PI * 2, d = 22 + r() * 40;
      const x = Math.cos(a) * d, z = 3 + Math.sin(a) * d, s = 0.9 + r() * 1.2;
      add(P, G.cyl, trunk, x, 2.2 * s, z, { sx: 0.5 * s, sy: 4.4 * s, sz: 0.5 * s });
      add(P, G.sphereLo, greens[i % 3], x, 5.6 * s, z, { sx: 3.2 * s, sy: 2.9 * s, sz: 3.2 * s });
    }
    g.add(mergeStatic(P));
    this.backdrop = g;
    this.scene.add(g);
  }

  /** Build (or rebuild) the level from the server's static map. */
  setMap(map) {
    if (this.level) {
      this.scene.remove(this.level.group);
      this.level.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    this.windowMats.length = 0;
    this.lanterns.length = 0;
    if (this.backdrop) { this.scene.remove(this.backdrop); this.backdrop = null; }
    this.map = map;
    this.level = new Level(map, this);
    this.cover = new CoverLayer(this.level, map);
    this.scene.add(this.level.group);
    this.setTime(this.time01, 1);
    this.shadowDone = false;
  }

  /** Terrain height at (x, z) (0 before a map arrived). */
  groundAt(x, z) {
    return this.map ? this.map.groundHeight(x, z) : 0;
  }

  _buildLights() {
    const s = this.scene;
    this.hemi = new THREE.HemisphereLight(0x8c9cf0, 0x37523f, 1.6);
    this.dirLight = new THREE.DirectionalLight(0xa8b8ff, 1.4);
    this.dirLight.target.position.set(0, 0, -4);
    this.dirLight.position.set(-30, 62, 52);
    this.dirLight.castShadow = true;
    const sh = this.dirLight.shadow;
    sh.mapSize.set(2048, 2048);
    sh.camera.left = -58; sh.camera.right = 58; sh.camera.top = 66; sh.camera.bottom = -66;
    sh.camera.near = 10; sh.camera.far = 220;
    sh.bias = -0.0006;
    sh.normalBias = 0.06;
    s.add(this.hemi, this.dirLight, this.dirLight.target);

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
      const cloud = mergeStatic(g); // one draw call per cloud
      cloud.position.set(Math.cos(a) * 320, 95 + cr() * 50, Math.sin(a) * 320 - 40);
      cloud.userData.speed = 1.2 + cr() * 1.5;
      this.scene.add(cloud);
      this.clouds.push(cloud);
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
    if (this.level) this.level.setNight(night);
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
    if (this.level) {
      this.level.update(dt, now / 1000, this.state);
      this.cover.update(dt);
    }
    // slot ring pulse
    if (this.slotRing.visible) {
      const s = 1 + Math.sin(now * 0.008) * 0.08;
      this.slotRing.scale.set(s, s, s);
    }
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

  showSlot(x, z, ok, y = 0.16) {
    this.slotRing.visible = true;
    this.slotRing.position.set(x, y, z);
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
      const gy = ctx.ground ? ctx.ground(x, z, y) : 0;
      rec.blob.position.y = gy - y + 0.03;
      const sh = clamp(1 - (y - gy) * 0.25, 0.4, 1);
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
    this._carry(rec, e, ctx);
    this._updateTag(rec, e, ctx);
  }

  /** A part in a zombie's hands floats over his head. */
  _carry(rec, e, ctx) {
    const kind = typeof e.carry === 'string' && PART_INFO[e.carry] ? e.carry : null;
    if (!kind) {
      if (rec.carry) {
        rec.root.remove(rec.carry.g);
        rec.carry = null;
      }
      return;
    }
    if (!rec.carry || rec.carry.kind !== kind) {
      if (rec.carry) rec.root.remove(rec.carry.g);
      const g = new THREE.Group();
      const m = makePartMesh(kind);
      m.scale.setScalar(1.25);
      g.add(m);
      const tex = getGlowTex();
      if (tex) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: PART_INFO[kind].color, transparent: true, depthWrite: false, opacity: 0.7 }));
        sp.scale.setScalar(1.3);
        g.add(sp);
      }
      rec.root.add(g);
      rec.carry = { kind, g };
    }
    rec.carry.g.position.y = (rec.model.tagY || 2) + 0.6 + Math.sin(ctx.t * 3) * 0.06;
    rec.carry.g.rotation.y = ctx.t * 1.6;
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
