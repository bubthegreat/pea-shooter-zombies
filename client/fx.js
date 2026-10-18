// Particle effects: soft puffs / sparkles (one Points object) and tumbling leaves (one InstancedMesh).
// Everything is pooled; spawning an effect allocates nothing.
import * as THREE from 'three';

const N_PART = 900;
const N_LEAF = 120;

function softTexture() {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

const VERT = `
attribute float size;
attribute float alpha;
attribute vec3 pcolor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = alpha;
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = min(size * uScale / max(-mv.z, 0.2), 220.0);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform sampler2D map;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(map, gl_PointCoord);
  float a = t.a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}`;

const tmpColor = new THREE.Color();
const rnd = (a, b) => a + Math.random() * (b - a);

export class Fx {
  constructor(scene) {
    this.scene = scene;
    // --- puffs
    this.n = N_PART;
    this.px = new Float32Array(N_PART * 3);
    this.vel = new Float32Array(N_PART * 3);
    this.age = new Float32Array(N_PART).fill(1e9);
    this.life = new Float32Array(N_PART).fill(1);
    this.s0 = new Float32Array(N_PART);
    this.s1 = new Float32Array(N_PART);
    this.a0 = new Float32Array(N_PART);
    this.drag = new Float32Array(N_PART);
    this.grav = new Float32Array(N_PART);
    this.size = new Float32Array(N_PART);
    this.alpha = new Float32Array(N_PART);
    this.col = new Float32Array(N_PART * 3);
    this.head = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.px, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { map: { value: softTexture() }, uScale: { value: 600 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    // --- leaves
    const leafShape = new THREE.Shape();
    leafShape.moveTo(0, -0.5);
    leafShape.quadraticCurveTo(0.42, -0.1, 0, 0.5);
    leafShape.quadraticCurveTo(-0.42, -0.1, 0, -0.5);
    const lg = new THREE.ShapeGeometry(leafShape);
    this.leafMesh = new THREE.InstancedMesh(lg, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), N_LEAF);
    this.leafMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.leafMesh.frustumCulled = false;
    this.leaf = [];
    for (let i = 0; i < N_LEAF; i++) {
      this.leaf.push({ age: 1e9, life: 1, p: new THREE.Vector3(), v: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), s: 0.3 });
      this.leafMesh.setColorAt(i, tmpColor.set(0x66bb6a));
    }
    this.leafHead = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._one = new THREE.Vector3();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < N_LEAF; i++) this.leafMesh.setMatrixAt(i, this._zero);
    scene.add(this.leafMesh);
  }

  setViewport(heightPx, fovDeg) {
    this.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  /* ---- emitters ---- */

  emit(x, y, z, vx, vy, vz, life, s0, s1, color, a0 = 0.9, drag = 1.5, grav = 0) {
    const i = this.head;
    this.head = (this.head + 1) % this.n;
    const k = i * 3;
    this.px[k] = x; this.px[k + 1] = y; this.px[k + 2] = z;
    this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
    this.age[i] = 0; this.life[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a0;
    this.drag[i] = drag; this.grav[i] = grav;
    tmpColor.set(color);
    this.col[k] = tmpColor.r; this.col[k + 1] = tmpColor.g; this.col[k + 2] = tmpColor.b;
  }

  leafBurst(x, y, z, count = 14, colors = [0x66bb6a, 0x8bd450, 0xa5e84f, 0x43a047], speed = 5, up = 5, scale = 1) {
    for (let n = 0; n < count; n++) {
      const l = this.leaf[this.leafHead];
      const i = this.leafHead;
      this.leafHead = (this.leafHead + 1) % N_LEAF;
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(0.4, 1) * speed;
      l.age = 0; l.life = rnd(0.9, 1.6);
      l.p.set(x, y, z);
      l.v.set(Math.cos(a) * sp, rnd(0.4, 1) * up, Math.sin(a) * sp);
      l.spin.set(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8));
      l.rot.set(rnd(0, 6), rnd(0, 6), rnd(0, 6));
      l.s = rnd(0.2, 0.4) * scale;
      this.leafMesh.setColorAt(i, tmpColor.set(colors[(Math.random() * colors.length) | 0]));
    }
    if (this.leafMesh.instanceColor) this.leafMesh.instanceColor.needsUpdate = true;
  }

  /** Green poof when a zombie is converted. */
  convert(x, y, z) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(0.5, 3);
      this.emit(x + Math.cos(a) * 0.3, y + rnd(-0.4, 0.5), z + Math.sin(a) * 0.3, Math.cos(a) * sp, rnd(0.5, 2.5), Math.sin(a) * sp,
        rnd(0.6, 1.1), 0.7, rnd(1.8, 3), i % 3 === 0 ? 0xb9f57d : 0x7ed957, 0.85, 2.2, -0.5);
    }
    for (let i = 0; i < 10; i++) {
      this.emit(x, y + 0.5, z, rnd(-2, 2), rnd(1, 4), rnd(-2, 2), rnd(0.5, 0.9), 0.25, 0.05, 0xfff59d, 1, 1.2, 4);
    }
    this.leafBurst(x, y + 0.6, z, 16);
  }

  /** Pretty flower poof where a computer-controlled plant bot turns into sunshine: petals, sparkles, soft puffs. */
  flowerPoof(x, y, z) {
    this.leafBurst(x, y + 0.3, z, 22, [0xff8fb8, 0xffd93b, 0xffffff, 0xff9e4a, 0xc58bff, 0xff6fa8], 4.2, 5.5);
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(0.6, 2.4);
      this.emit(x + Math.cos(a) * 0.25, y + rnd(-0.3, 0.6), z + Math.sin(a) * 0.25, Math.cos(a) * sp, rnd(0.6, 2.4), Math.sin(a) * sp,
        rnd(0.6, 1.0), 0.6, rnd(1.6, 2.4), i % 2 ? 0xffd1e3 : 0xfff3b0, 0.7, 2.2, -0.4);
    }
    this.sparkle(x, y + 0.6, z, 0xfff59d, 12, 1.4);
    this.sparkle(x, y + 0.9, z, 0xffffff, 6, 0.8);
  }

  /** Splash impact. kind: melon (green juice + seeds) | brain (pink goo) | anything else (generic). radius in metres. */
  explode(x, y, z, radius = 3, kind = '') {
    const r = Math.max(0.8, Math.min(8, radius));
    const v0 = r * 3.1; // with the drag below the spray travels ~radius metres
    const melon = kind === 'melon';
    const brain = kind === 'brain';
    const pal = melon ? [0x66d33f, 0xb9f57d, 0xff6f91, 0xffb3c6] : brain ? [0xff6fa8, 0xff9ec4, 0xffc2d9, 0xd94f93] : [0xffffff, 0xffe082];
    const n = 20;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const sp = v0 * rnd(0.5, 1);
      this.emit(x, y + 0.3, z, Math.cos(a) * sp, rnd(0.6, 3.2), Math.sin(a) * sp, rnd(0.45, 0.8), 0.7, rnd(1.4, 2.4), pal[i % pal.length], 0.9, 2.6, -2);
    }
    for (let i = 0; i < 10; i++) {
      this.emit(x + rnd(-0.3, 0.3), y + 0.4, z + rnd(-0.3, 0.3), rnd(-1.5, 1.5), rnd(2.5, 6), rnd(-1.5, 1.5), rnd(0.6, 1.0), 0.45, 0.2, pal[(i + 1) % pal.length], 0.95, 0.8, -9);
    }
    if (melon) {
      this.leafBurst(x, y + 0.5, z, 10, [0x111111, 0x222222], v0 * 0.55, 7, 0.3); // seeds
      this.leafBurst(x, y + 0.5, z, 12, [0xff4d6d, 0xff6f91, 0x66d33f], v0 * 0.5, 6, 0.6); // rind & flesh chunks
    } else if (brain) {
      this.sparkle(x, y + 0.5, z, 0xffd1e3, 10, r * 0.5);
    }
    this.dust(x, y, z, melon ? 0x8bd450 : brain ? 0xff8fb8 : 0xb08a5a, 8);
  }

  /** Little puff where the leaf blower swatted a pea. */
  deflect(x, y, z) {
    for (let i = 0; i < 6; i++) {
      this.emit(x, y, z, rnd(-2.5, 2.5), rnd(-1, 2.5), rnd(-2.5, 2.5), rnd(0.25, 0.45), 0.3, 0.9, 0xeaf6ff, 0.8, 2.5, 0);
    }
    this.sparkle(x, y, z, 0xffffff, 4, 0.6);
  }

  /** One airy streak of blown wind; call a few times a frame while a leaf blower is on. dir is a unit vector. */
  wind(x, y, z, dx, dy, dz, speed = 13) {
    const sp = speed * rnd(0.8, 1.15);
    this.emit(x, y, z, dx * sp + rnd(-1.2, 1.2), dy * sp + rnd(-0.8, 0.8), dz * sp + rnd(-1.2, 1.2), rnd(0.35, 0.6), 0.14, rnd(0.55, 0.95), 0xeaf6ff, 0.26, 0.3, 0);
  }

  /** Tiny ice-crystal glitter around a slowed fighter. */
  ice(x, y, z) {
    this.emit(x + rnd(-0.4, 0.4), y + rnd(0.1, 1.7), z + rnd(-0.4, 0.4), rnd(-0.3, 0.3), rnd(-0.1, 0.5), rnd(-0.3, 0.3), rnd(0.5, 0.9), 0.22, 0.04, Math.random() < 0.5 ? 0xbdf0ff : 0xffffff, 1, 1.0, 0);
  }

  /** Wooden splinters (wheelbarrow thunk / breaking). big = the barrow fell apart. */
  splinters(x, y, z, big = false) {
    this.leafBurst(x, y, z, big ? 18 : 7, [0xc8955a, 0x8d5a2b, 0xe0b074], big ? 6 : 3.4, big ? 6 : 3.5, 0.6);
    this.dust(x, y - 0.2, z, 0xb08a5a, big ? 9 : 4);
  }

  /** Mower conks out: sputtering black smoke, a few sparks. */
  mowerBoom(x, y, z) {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(0.3, 2.2);
      this.emit(x + Math.cos(a) * 0.4, y + 0.6, z + Math.sin(a) * 0.4, Math.cos(a) * sp, rnd(0.8, 3), Math.sin(a) * sp, rnd(0.8, 1.5), 0.5, rnd(1.6, 2.8), i % 3 ? 0x4a4a52 : 0x8d949b, 0.75, 1.2, 0.3);
    }
    this.sparkle(x, y + 0.8, z, 0xffb74d, 10, 1.5);
    this.leafBurst(x, y + 0.5, z, 5, [0xe53935, 0xb71c1c, 0xcfd8dc], 4.5, 5, 0.5);
  }

  /** Bigger gold spark for a headshot. */
  headHit(x, y, z) {
    for (let i = 0; i < 9; i++) {
      this.emit(x, y, z, rnd(-3, 3), rnd(0, 3.5), rnd(-3, 3), rnd(0.25, 0.5), 0.38, 0.05, i % 2 ? 0xffe14a : 0xffffff, 1, 2.5, 0);
    }
  }

  /** Dusty little puff (planting, stomping). */
  dust(x, y, z, color = 0xb08a5a, n = 8) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(0.4, 1.8);
      this.emit(x, y + 0.1, z, Math.cos(a) * sp, rnd(0.3, 1.4), Math.sin(a) * sp, rnd(0.4, 0.8), 0.4, 1.3, color, 0.7, 2.5, -0.5);
    }
  }

  plantPop(x, y, z) {
    this.dust(x, y, z, 0x9b6b43, 10);
    this.leafBurst(x, y + 0.4, z, 6, [0x66bb6a, 0x8bd450], 2.5, 3.5);
    this.sparkle(x, y + 0.8, z, 0xfff59d, 6);
  }

  sparkle(x, y, z, color = 0xfff59d, n = 10, radius = 1.2) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(0.5, 1) * radius * 2;
      this.emit(x, y, z, Math.cos(a) * sp, rnd(0.5, 3), Math.sin(a) * sp, rnd(0.5, 0.9), 0.3, 0.05, color, 1, 2, 2);
    }
  }

  /** Little spark where a shot lands. */
  hit(x, y, z, color = 0xffffff) {
    for (let i = 0; i < 5; i++) {
      this.emit(x, y, z, rnd(-2, 2), rnd(0, 2.5), rnd(-2, 2), rnd(0.2, 0.4), 0.28, 0.05, color, 1, 2.5, 0);
    }
  }

  /** Yellow petals fluttering down when a plant wilts. */
  wilt(x, y, z) {
    this.leafBurst(x, y + 1.2, z, 12, [0xffd93b, 0xffb300, 0xfff176], 2.2, 1.5);
    this.dust(x, y, z, 0xcdb85a, 5);
  }

  /** Crunchy grass spray when the mower eats a plant. */
  mow(x, y, z) {
    this.leafBurst(x, y + 0.5, z, 20, [0x66bb6a, 0x8bd450, 0x43a047, 0xffe082], 7, 5);
    this.dust(x, y, z, 0x8bd450, 8);
  }

  smoke(x, y, z) {
    this.emit(x + rnd(-0.1, 0.1), y, z + rnd(-0.1, 0.1), rnd(-0.3, 0.3), rnd(0.8, 1.6), rnd(-0.3, 0.3), rnd(0.7, 1.1), 0.3, 1.1, 0xcfd8dc, 0.55, 0.5, 0);
  }

  /** A battered mower coughing dark smoke. */
  mowerSputter(x, y, z) {
    this.emit(x, y, z, rnd(-0.3, 0.3), rnd(0.8, 1.6), rnd(-0.3, 0.3), rnd(0.8, 1.3), 0.3, 1.2, 0x3e3e46, 0.6, 0.5, 0);
  }

  /** Celebration confetti around a point. */
  confetti(x, y, z) {
    this.leafBurst(x, y, z, 24, [0xff6fa8, 0xffd93b, 0x4fc3f7, 0x8bd450, 0xba68c8], 6, 9);
  }

  muzzle(x, y, z, color = 0xfff59d) {
    this.emit(x, y, z, 0, 0, 0, 0.09, 0.45, 0.8, color, 0.9, 0, 0);
  }

  /* ---- update ---- */

  update(dt) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const age = this.age[i];
      if (age >= this.life[i]) {
        this.alpha[i] = 0; this.size[i] = 0;
        continue;
      }
      const a = age + dt;
      this.age[i] = a;
      const k = i * 3;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[k] *= d; this.vel[k + 1] = this.vel[k + 1] * d + this.grav[i] * dt; this.vel[k + 2] *= d;
      this.px[k] += this.vel[k] * dt; this.px[k + 1] += this.vel[k + 1] * dt; this.px[k + 2] += this.vel[k + 2] * dt;
      if (this.px[k + 1] < 0.02) this.px[k + 1] = 0.02;
      const f = a / this.life[i];
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * f;
      this.alpha[i] = this.a0[i] * (1 - f) * (f < 0.1 ? f * 10 : 1);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
    g.attributes.pcolor.needsUpdate = true;

    let anyLeaf = false;
    const m = this._m, q = this._q, one = this._one;
    for (let i = 0; i < N_LEAF; i++) {
      const l = this.leaf[i];
      if (l.age >= l.life) {
        if (l.age < 1e8) { this.leafMesh.setMatrixAt(i, this._zero); l.age = 1e9; anyLeaf = true; }
        continue;
      }
      anyLeaf = true;
      l.age += dt;
      l.v.y -= 7 * dt;
      l.v.x *= 1 - 0.8 * dt; l.v.z *= 1 - 0.8 * dt;
      l.p.addScaledVector(l.v, dt);
      if (l.p.y < 0.05) { l.p.y = 0.05; l.v.set(0, 0, 0); l.spin.multiplyScalar(0.5); }
      l.rot.x += l.spin.x * dt; l.rot.y += l.spin.y * dt; l.rot.z += l.spin.z * dt;
      q.setFromEuler(l.rot);
      const k = 1 - Math.max(0, (l.age / l.life - 0.7) / 0.3);
      one.setScalar(l.s * Math.max(0.01, k));
      m.compose(l.p, q, one);
      this.leafMesh.setMatrixAt(i, m);
    }
    if (anyLeaf) this.leafMesh.instanceMatrix.needsUpdate = true;
  }
}
