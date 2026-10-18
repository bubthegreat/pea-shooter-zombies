// Canvas-drawn textures and the static-mesh merger shared by the scenery builders. Everything is generated in code.
import * as THREE from 'three';
import { mulberry, vcMat, isPlainToon } from './models.js';

const PI = Math.PI;

/* ------------------------------------------------------------------ */
/* canvas textures                                                     */
/* ------------------------------------------------------------------ */

export function canvasTex(w, h, draw, rx = 1, ry = 1, repeat = true) {
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

export function grassTexture(rx, ry, stripes = true, tint = 0) {
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

export function dirtTexture(rx, ry) {
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

export function pathTexture(rx, ry) {
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

export function sidingTexture(base, rx, ry) {
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

export function shingleTexture(base, rx, ry) {
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

export function textSignTexture(text, bg, fg, w = 512, h = 128) {
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

export function moonTexture() {
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

export function sunTexture() {
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

export function emojiTexture(emoji, bg) {
  return canvasTex(128, 128, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    g.font = '84px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(emoji, 64, 70);
  }, 1, 1, false);
}

export function tombTexture(text) {
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

export function mergeStatic(root) {
  root.updateMatrixWorld(true);
  const buckets = new Map();
  const keep = [];
  root.traverse((o) => {
    if (o === root) return;
    if (!o.isMesh || o.isInstancedMesh || !o.geometry) return;
    // plain coloured toon parts all share one vertex-coloured material (one draw call); textured / glowing / see-through ones stay apart
    const plain = isPlainToon(o.material);
    const key = (plain ? 'vc' : o.material.uuid) + '|' + (o.castShadow ? 1 : 0) + (o.receiveShadow ? 1 : 0) + '|' + o.renderOrder;
    let b = buckets.get(key);
    if (!b) { b = { mat: plain ? vcMat : o.material, plain, cast: o.castShadow, receive: o.receiveShadow, ro: o.renderOrder, pos: [], nor: [], uv: [], col: [] }; buckets.set(key, b); }
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    b.pos.push(g.attributes.position.array);
    b.nor.push(g.attributes.normal.array);
    b.uv.push(g.attributes.uv ? g.attributes.uv.array : new Float32Array((g.attributes.position.count) * 2));
    if (plain) {
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      const c = o.material.color;
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      b.col.push(arr);
    }
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
    if (b.plain) geo.setAttribute('color', new THREE.BufferAttribute(cat(b.col), 3));
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

/** Pale gravel path with darker pebbles. */
export function gravelTexture(rx = 1, ry = 1) {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#d9c7a1';
    g.fillRect(0, 0, w, h);
    const r = mulberry(17);
    for (let i = 0; i < 900; i++) {
      const light = 55 + r() * 30;
      g.fillStyle = `hsl(${32 + r() * 14}, ${14 + r() * 18}%, ${light}%)`;
      g.beginPath();
      g.ellipse(r() * w, r() * h, 2 + r() * 4, 1.5 + r() * 3, r() * 3, 0, PI * 2);
      g.fill();
    }
  }, rx, ry);
}

/** Warm wooden planks (deck, steps, bridge, fence). */
export function plankTexture(base = '#c8955a', rx = 1, ry = 1) {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    const r = mulberry(23);
    for (let x = 0; x < w; x += 32) {
      g.fillStyle = 'rgba(60,30,10,0.35)';
      g.fillRect(x, 0, 3, h);
      for (let i = 0; i < 5; i++) {
        g.fillStyle = `rgba(${r() < 0.5 ? '255,235,200' : '70,35,10'},0.12)`;
        g.fillRect(x + 4 + r() * 22, r() * h, 1.5, 10 + r() * 30);
      }
    }
  }, rx, ry);
}

/** Chunky grey stone blocks (terraces, cellar). */
export function stoneTexture(rx = 1, ry = 1) {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#aeb7be';
    g.fillRect(0, 0, w, h);
    const r = mulberry(31);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 3; x++) {
        const ox = (y % 2) * 21;
        g.fillStyle = `hsl(205, ${6 + r() * 8}%, ${62 + r() * 12}%)`;
        g.strokeStyle = 'rgba(60,70,80,0.5)';
        g.lineWidth = 3;
        g.beginPath();
        g.roundRect(x * 43 + ox + 2, y * 32 + 2, 39, 28, 6);
        g.fill();
        g.stroke();
      }
    }
  }, rx, ry);
}
