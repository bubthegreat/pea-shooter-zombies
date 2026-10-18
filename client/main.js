// Backyard Battle client: wires the network, input, scene and HUD together.
import * as THREE from 'three';
import { Net } from './net.js';
import { Input } from './input.js';
import { World, EntityLayer, LAYOUT, gardenSlots } from './scene.js';
import { makeGun, makeItem, makeHands, weaponInfo, setWeaponTable, setEquipmentTable, itemInfo, toon, G, add, getGlowTex } from './models.js';
import { Fx } from './fx.js';
import { Sound } from './audio.js';
import { HUD } from './hud.js';
import { Lobby } from './lobby.js';
import { Options } from './options.js';
import { profile } from './profile.js';
import { feedLine } from './feed.js';
import { TouchControls, isTouch } from './touch.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const PI = Math.PI;

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

const canvas = document.getElementById('game');
const lobby = new Lobby();
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  lobby.setStatus("Your browser couldn't start 3D graphics. Try the latest Chrome!", true);
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch() ? 1 : 1.5)); // phones render at 1x to keep the frame rate up
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // scenery never moves: shadows are rendered once
renderer.autoClear = false;

const world = new World();
const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 1200);
camera.rotation.order = 'YXZ';
world.scene.add(camera);
const viewCamera = new THREE.PerspectiveCamera(58, 1, 0.02, 20);

const fx = new Fx(world.scene);
const layer = new EntityLayer(world.scene);
const sound = new Sound();
const hud = new HUD();
const net = new Net();
const input = new Input(canvas);
new TouchControls(input, hud); // phones/tablets: on-screen controls (no-op on desktop)

hud.setMuted(sound.muted);

/* ------------------------------------------------------------------ */
/* first-person view model                                             */
/* ------------------------------------------------------------------ */

// First-person pose of a held tool when it is not simply "a gun-shaped thing in the right hand" (wheelbarrow: both
// hands on its handles, the barrow ahead at the bottom of the screen). pos is in rig space, hands in holder space.
const ITEM_POSE = {
  wheelbarrow: {
    pos: [-0.2, -0.47, -0.05], s: 0.4,
    hands: [[-0.32, -0.07, -0.04, 0.15, -0.4, 0.9], [-0.08, -0.07, -0.04, -0.15, -0.4, 0.9]],
  },
};
const TOOL_POSE = { s: 0.6, pos: [0, 0.0, -0.1], rotX: -0.16 }; // hand tools: a little smaller and tipped down so the business end reads
const GUN_HANDS = [
  [0.0, -0.1, 0.03, 0.25, -0.5, 0.8], // right hand on the grip
  [-0.01, -0.07, -0.36, -0.6, -0.35, 0.7], // left hand under the barrel
];
const VM_GUN_SCALE = { house_gun: 0.62, melon_lobber: 0.6, brain_cannon: 0.58, sludge_sprayer: 0.66, repeater: 0.68 };

class ViewModel {
  constructor(scene) {
    this.root = new THREE.Group();
    scene.add(this.root);
    this.rig = new THREE.Group();
    this.root.add(this.rig);
    this.holder = new THREE.Group();
    this.rig.add(this.holder);
    this.gun = null;
    this.gunId = null;
    this.team = null;
    this.hands = null;
    this.heldId = null; // garage tool in hand (replaces the gun)
    this.tool = null;
    this.tools = {};
    this.kick = 0;
    this.swap = 0;
    this.flashT = 0;
    this.phase = 0;
    this.swayX = 0;
    this.swayY = 0;
    this.useK = 0;
    const tex = getGlowTex();
    this.flash = new THREE.Group();
    if (tex) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xfff1a0, transparent: true, depthWrite: false, opacity: 0.95 }));
      sp.scale.setScalar(0.55);
      this.flash.add(sp);
    }
    add(this.flash, G.sphere, new THREE.MeshBasicMaterial({ color: 0xffffff }), 0, 0, 0, { s: 0.05 });
    this.flash.visible = false;
  }

  setTeam(team) {
    if (this.team === team) return;
    this.team = team;
    if (this.hands) this.holder.remove(this.hands);
    // tool hands are tinted per team: forget the cached tools
    for (const t of Object.values(this.tools)) {
      this.holder.remove(t.group);
      if (t.hands) this.holder.remove(t.hands);
    }
    this.tools = {};
    this.tool = null;
    this.heldId = null;
    this.hands = makeHands(team, GUN_HANDS);
    this.holder.add(this.hands);
    if (this.gun) this.gun.visible = true;
  }

  setWeapon(id, team) {
    this.setTeam(team);
    if (id === this.gunId && this.gun) return;
    const first = this.gunId === null;
    this.gunId = id;
    if (this.gun) this.holder.remove(this.gun);
    this.gun = makeGun(id, team);
    this.gun.scale.setScalar(VM_GUN_SCALE[id] || 0.72);
    this.gun.visible = !this.heldId;
    this.holder.add(this.gun);
    const muzzle = this.gun.userData.muzzle;
    if (muzzle) muzzle.add(this.flash);
    if (!first) this.swap = 1;
  }

  /** Hold a garage tool (id) instead of the gun, or put it down (null). */
  setHeld(id) {
    id = id || null;
    if (id === this.heldId) return;
    if (this.tool) {
      this.tool.group.visible = false;
      if (this.tool.hands) this.tool.hands.visible = false;
    }
    this.heldId = id;
    this.tool = null;
    this.swap = 1;
    if (!id) {
      if (this.gun) this.gun.visible = true;
      if (this.hands) this.hands.visible = true;
      return;
    }
    let t = this.tools[id];
    if (!t) {
      const model = makeItem(id);
      const group = new THREE.Group();
      group.add(model.root);
      const pose = ITEM_POSE[id];
      let hands = null;
      if (pose) {
        group.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
        group.scale.setScalar(pose.s);
        hands = makeHands(this.team, pose.hands);
        this.holder.add(hands);
      } else {
        group.scale.setScalar(TOOL_POSE.s);
        group.position.set(TOOL_POSE.pos[0], TOOL_POSE.pos[1], TOOL_POSE.pos[2]);
        group.rotation.x = TOOL_POSE.rotX;
      }
      this.holder.add(group);
      t = this.tools[id] = { model, group, hands };
    }
    t.group.visible = true;
    if (t.hands) t.hands.visible = true;
    this.tool = t;
    if (this.gun) this.gun.visible = false;
    if (this.hands) this.hands.visible = !t.hands;
  }

  fire() {
    this.kick = 1;
    this.flashT = 0.06;
  }

  update(dt, t, speed, dYaw, dPitch, show, using = false) {
    this.root.visible = show;
    if (!show) return;
    const w = clamp(speed / 6, 0, 1);
    this.phase += dt * (3 + speed * 1.4);
    const bx = Math.sin(this.phase) * 0.014 * w;
    const by = (Math.abs(Math.cos(this.phase)) - 0.5) * 0.02 * w + Math.sin(t * 1.7) * 0.0035;
    const ry = dt > 0 ? dYaw / dt : 0;
    const rp = dt > 0 ? dPitch / dt : 0;
    const tx = clamp(ry * 0.012, -0.07, 0.07);
    const ty = clamp(-rp * 0.012, -0.05, 0.05);
    const k = Math.min(1, dt * 9);
    this.swayX += (tx - this.swayX) * k;
    this.swayY += (ty - this.swayY) * k;
    this.kick = Math.max(0, this.kick - dt * 8);
    this.swap = Math.max(0, this.swap - dt * 3.5);
    const sw = this.swap * this.swap;
    this.flashT = Math.max(0, this.flashT - dt);
    this.flash.visible = this.flashT > 0 && !this.heldId;
    this.useK += ((using ? 1 : 0) - this.useK) * Math.min(1, dt * 14);
    let jx = 0, jy = 0, jz = 0;
    if (this.tool) {
      this.tool.model.update({ t, dt, using, speed });
      // tools shake harder in use; the barrow bobs as it is pushed
      const u = this.useK;
      jx = Math.sin(t * 85) * 0.004 * u;
      jy = Math.cos(t * 71) * 0.005 * u;
      jz = this.heldId === 'wheelbarrow' ? Math.sin(this.phase * 2) * 0.006 * w : Math.sin(t * 50) * 0.01 * u;
    }
    this.rig.position.set(0.2 + bx + this.swayX + jx, -0.2 + by + this.swayY - sw * 0.45 + jy, -0.5 + this.kick * 0.07 + jz);
    this.rig.rotation.set(this.kick * 0.16 - sw * 0.5, -this.swayX * 1.2 + 0.03, 0);
  }
}

const vm = new ViewModel(world.viewScene);
const vmDir = new THREE.Vector3();
const qInv = new THREE.Quaternion();

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const S = {
  joined: false,
  joinAt: 0,
  team: 'plant',
  config: {},
  eyeY: 1.6,
  needYawSync: false,
  lastPhase: null,
  lastWeapon: null,
  lastSun: null,
  lastOwnState: null,
  fireCd: 0,
  smokeAcc: 0,
  lastYaw: 0,
  lastPitch: 0,
  speed: 0,
  lastCam: new THREE.Vector3(),
  gotCam: false,
  pending: [], // delayed events
  introShown: false,
  nearSlot: null,
  sfxLast: new Map(),
  hitAt: new Map(), // per-target throttle for hit sounds / sparks (melee tools hit ~10x per second)
  wasDriving: 0, // performance.now() of the last frame we were driving the mower
  fxAcc: 0,
};
let SLOTS = gardenSlots();
const CID = Math.random().toString(36).slice(2, 12) + performance.now().toString(36).replace('.', ''); // names this page to the server
const myId = () => (net.id === null || net.id === undefined ? null : String(net.id));

function sfx(name, pos, vol = 1, gap = 0) {
  const now = performance.now();
  const last = S.sfxLast.get(name) || 0;
  if (now - last < Math.max(30, gap)) return;
  S.sfxLast.set(name, now);
  sound.play(name, pos, vol);
}

// which procedural sound goes with each projectile kind (enemy shots reuse the ones for their own kind)
const FIRE_SOUND = { spike: 'spike', housepea: 'housepea', bullet: 'goo', snow: 'snow', melon: 'melon', slime: 'slime', bone: 'bone', sludge: 'sludge', brain: 'brain' };
const fireSound = (proj) => FIRE_SOUND[proj] || 'pea';

/* ------------------------------------------------------------------ */
/* lobby / networking                                                  */
/* ------------------------------------------------------------------ */

function leaveToLobby(msg, bad = false) {
  S.joined = false;
  input.enabled = false;
  input.stopSending();
  input.exitLock();
  hud.hide();
  layer.clear();
  world.hideSlot();
  sound.engineLevel(0);
  lobby.show();
  if (msg) lobby.setStatus(msg, bad);
}

lobby.setReady(false);
net.on('open', () => {
  lobby.setReady(true);
  lobby.setStatus('Ready! Pick a team and press Play.');
});
net.on('close', () => {
  const wasJoined = S.joined;
  lobby.setReady(false);
  leaveToLobby(wasJoined ? 'Lost the connection — reconnecting…' : 'Connecting…', wasJoined);
});
net.on('welcome', (msg) => {
  S.config = msg.config || {};
  setWeaponTable(S.config.weapons);
  setEquipmentTable(S.config.equipment);
  if (Array.isArray(S.config.gardenSlots) && S.config.gardenSlots.length) {
    SLOTS = S.config.gardenSlots.filter((s) => s && Number.isFinite(s.x) && Number.isFinite(s.z) && typeof s.kind === 'string');
  }
  if (S.config.world && !worldMatches(S.config.world)) {
    console.warn('Server world layout differs from the built-in scenery; collisions may not match visuals.');
  }
});
net.on('msg', (msg) => {
  if (msg.t === 'error' || msg.t === 'full' || msg.t === 'rejected') {
    leaveToLobby(msg.message || msg.reason || "Couldn't join. Try again!", true);
  }
});
net.on('snap', onSnap);

lobby.onPlay = (choice) => {
  if (!net.open) return;
  sound.unlock();
  sfx('click');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  S.team = choice.team;
  S.joined = true;
  S.joinAt = performance.now();
  S.needYawSync = true;
  S.lastPhase = null;
  S.lastWeapon = null;
  S.lastSun = null;
  S.lastOwnState = null;
  S.introShown = false;
  S.gotCam = false;
  S.eyeY = 1.6;
  S.wasDriving = 0;
  vm.gunId = null;
  net.send({ t: 'join', name: choice.name, team: choice.team, mode: choice.mode, difficulty: choice.difficulty, cid: CID });
  hud.show();
  hud.resetForJoin(performance.now());
  lobby.hide();
  layer.clear();
  input.enabled = true;
  input.requestLock();
  // wait for the first snapshot (it carries our spawn facing) before sending look angles
  input.startSending((m) => (S.joined && !S.needYawSync ? net.send(m) : false));
};

function changeTeam() {
  leaveToLobby('Pick a team and press Play.');
  net.restart();
}
hud.el.endChange.addEventListener('click', changeTeam);
input.onChangeTeam = () => { if (hud.endShown) changeTeam(); };
hud.el.mute.addEventListener('click', () => toggleMute());
input.onToggleMute = toggleMute;
input.onToggleHelp = () => hud.toggleHelp();
input.onPlantKey = (n) => onPlantKey(n);

profile.subscribe((name) => { if (S.joined) net.send({ t: 'setName', name }); }); // renamed from the settings panel mid-game
const options = new Options();
options.onOpen = () => input.setMenuOpen(true);
options.onClose = (relock) => {
  input.setMenuOpen(false);
  if (relock && input.enabled && S.joined) input.requestLock();
};

function toggleMute() {
  sound.unlock();
  sound.setMuted(!sound.muted);
  hud.setMuted(sound.muted);
}

net.connect();

/* ------------------------------------------------------------------ */
/* events from the server                                              */
/* ------------------------------------------------------------------ */

const EVENT_DELAY = 100; // match the interpolation delay so effects line up with visuals

function onSnap(snap) {
  const evs = Array.isArray(snap.events) ? snap.events : [];
  const me = myId();
  const now = performance.now();
  for (const ev of evs) {
    if (!ev || typeof ev.type !== 'string') continue;
    // things about me react instantly
    if (ev.type === 'hit' && me !== null) {
      if (ev.by !== null && ev.by !== undefined && String(ev.by) === me && String(ev.id) !== me) {
        // melee tools hit ~10x a second per target: one tick (and one hit-marker flash) per target per 150 ms
        const key = 's' + ev.id;
        if (ev.head || now - (S.hitAt.get(key) || 0) >= 150) {
          S.hitAt.set(key, now);
          hud.hit(!!ev.head);
          if (ev.head) {
            hud.headshot();
            sfx('headshot', null, 1, 150);
          } else {
            sfx('tick', null, 1, 40);
          }
        }
      }
      if (String(ev.id) === me) sfx('hurt', null, 0.8, 120);
    } else if (ev.type === 'upgrade' && me !== null && String(ev.id) === me) {
      hud.banner(ev.bonus ? 'STREAK BONUS!' : 'UPGRADE!', typeof ev.name === 'string' ? ev.name : '', 'upgrade');
      sfx('chime');
      vm.swap = 1;
      fx.sparkle(camera.position.x, camera.position.y - 0.4, camera.position.z, 0xfff59d, 14, 1.4);
      continue;
    }
    S.pending.push({ ev, due: now + EVENT_DELAY });
  }
  if (S.pending.length > 300) S.pending.splice(0, S.pending.length - 300);
}

function recPos(id) {
  if (id === undefined || id === null) return null;
  if (String(id) === myId()) return { x: camera.position.x, y: Math.max(0, camera.position.y - S.eyeY), z: camera.position.z };
  const r = layer.recs.get(String(id));
  return r ? { x: r.x, y: r.y, z: r.z } : null;
}

function runEvent(ev) {
  const line = feedLine(ev);
  if (line) hud.feed(line);
  const x = num(ev.x, NaN), z = num(ev.z, NaN);
  const have = Number.isFinite(x) && Number.isFinite(z);
  const y = num(ev.y, 0);
  const pos = have ? { x, y, z } : recPos(ev.id);
  switch (ev.type) {
    case 'hit':
      if (have) {
        // melee tools hit ~10x a second per target: one spark per target per 100 ms
        const key = 'f' + ev.id;
        const now = performance.now();
        if (ev.head || now - (S.hitAt.get(key) || 0) >= 100) {
          S.hitAt.set(key, now);
          if (ev.head) fx.headHit(x, y, z);
          else fx.hit(x, y, z);
        }
      }
      break;
    case 'convert':
      if (ev.human === false) {
        // a computer plant turned into sunshine: flower poof (the sun pickup itself comes from the server)
        if (pos) fx.flowerPoof(pos.x, pos.y + 0.7, pos.z);
        sfx('bloom', pos, 1, 80);
      } else {
        if (pos) fx.convert(pos.x, pos.y + 0.9, pos.z);
        sfx('boing', pos, 1, 80);
      }
      break;
    case 'explode':
      if (have) fx.explode(x, y, z, num(ev.radius, 3), typeof ev.projKind === 'string' ? ev.projKind : '');
      sfx(ev.projKind === 'brain' ? 'squish' : 'splat', pos, 1, 60);
      break;
    case 'deflect':
      if (have) fx.deflect(x, y, z);
      sfx('deflect', pos, 0.8, 70);
      break;
    case 'block':
      if (have) fx.splinters(x, y, z);
      sfx('thunk', pos, 1, 60);
      break;
    case 'item_take': {
      const p = recPos(ev.id);
      if (p) fx.sparkle(p.x, p.y + 1.1, p.z, 0xffe082, 8, 1.0);
      sfx('pickup', p, 1, 80);
      break;
    }
    case 'item_drop': {
      const reason = ev.reason;
      if (reason === 'destroyed') {
        if (pos) fx.splinters(pos.x, 0.7, pos.z, true);
        sfx('crunch', pos, 0.8, 100);
      } else if (reason === 'converted') {
        if (pos) fx.sparkle(pos.x, 0.8, pos.z, 0xffe082, 6, 1.0);
        sfx('drop', pos, 0.7, 100);
      } else if (reason === 'returned') {
        if (pos) fx.sparkle(pos.x, 1.2, pos.z, 0xffe082, 6, 0.8);
        sfx('pickup', pos, 0.6, 100);
      } else {
        sfx('drop', pos, reason === 'left' ? 0.4 : 0.8, 100);
      }
      break;
    }
    case 'item_respawn': {
      const p = recPos('rack_' + ev.itemId);
      if (p) fx.sparkle(p.x, 1.4, p.z, 0xfff59d, 10, 1.0);
      sfx('respawn', p, 0.7, 150);
      break;
    }
    case 'mower_respawn':
      if (have) fx.sparkle(x, y + 1, z, 0xfff59d, 12, 1.4);
      sfx('respawn', pos, 0.8, 200);
      break;
    case 'mower_destroyed':
      if (have) fx.mowerBoom(x, y, z);
      sfx('mower_break', pos, 1, 200);
      if (performance.now() - S.wasDriving < 1500) hud.toast('Your mower broke down! \u{1F527}', 2600);
      break;
    case 'wilt':
      if (!pos) break;
      if (ev.plantKind) {
        fx.leafBurst(pos.x, 0.6, pos.z, 10, [0x66bb6a, 0x8bd450, 0xa5a05a], 5, 4);
        fx.dust(pos.x, 0, pos.z, 0x9b6b43, 5);
        sfx('crunch', pos, 0.5, 80);
      } else {
        fx.wilt(pos.x, pos.y, pos.z);
        sfx('wilt', pos, 1, 150);
      }
      break;
    case 'plant':
      if (pos) fx.plantPop(pos.x, 0, pos.z);
      sfx('plant', pos, 1, 60);
      break;
    case 'mow':
      if (pos) fx.mow(pos.x, 0.4, pos.z);
      sfx('crunch', pos, 0.8, 70);
      break;
    case 'upgrade': {
      const p = recPos(ev.id);
      if (p) fx.sparkle(p.x, p.y + 1.2, p.z, 0xfff59d, 12, 1.2);
      sfx('chime', p, 0.8, 200);
      break;
    }
    case 'wave': {
      const n = num(ev.wave, 0);
      if (ev.final) hud.banner('LAST WAVE!', 'Hold on until sunrise!', 'wave');
      else hud.banner(`WAVE ${n}`, 'Zombies are coming!', 'wave');
      sfx('wave');
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* planting helpers                                                    */
/* ------------------------------------------------------------------ */

const PLANT_NAME = { peashooter: 'Peashooter', cactus: 'Cactus' };
const PLANT_COST_DEFAULT = { peashooter: 50, cactus: 100 };
const PLANT_RANGE = 4;
function plantCost(kind) {
  const t = S.config.plantTypes && S.config.plantTypes[kind];
  return t && typeof t.cost === 'number' ? t.cost : PLANT_COST_DEFAULT[kind];
}
function worldMatches(w) {
  const same = (a, b, keys) => !a || !b || keys.every((k) => a[k] === b[k]);
  return same(w.house, LAYOUT.house, ['minX', 'maxX', 'minZ', 'maxZ']) && same(w.garage, LAYOUT.garage, ['minX', 'maxX', 'minZ', 'maxZ', 'doorMinX', 'doorMaxX'])
    && same(w.bounds, LAYOUT.bounds, ['minX', 'maxX', 'minZ', 'maxZ']);
}

function nearestEmptySlot(entities, px, pz, kind) {
  let best = null, bd = PLANT_RANGE;
  for (const s of SLOTS) {
    if (kind && s.kind !== kind) continue;
    const d = Math.hypot(s.x - px, s.z - pz);
    if (d > bd) continue;
    let taken = false;
    for (const e of entities.values()) {
      if (e.kind === 'garden' && Math.abs(e.x - s.x) < 1.2 && Math.abs(e.z - s.z) < 1.2) { taken = true; break; }
    }
    if (!taken) { best = s; bd = d; }
  }
  return best;
}

let lastView = null;
function onPlantKey(n) {
  if (!S.joined || S.team !== 'plant' || !lastView || !lastView.self) return;
  const own = lastView.self;
  if (own.state === 'wilted' || own.state === 'sprout') return;
  hud.pressSeed(n);
  const kind = n === 1 ? 'peashooter' : 'cactus';
  const cost = plantCost(kind);
  if (num(own.sunshine, 0) < cost) {
    hud.toast(`Not enough sunshine yet! ${PLANT_NAME[kind]} costs ${cost}`, 1800);
    sfx('hurt', null, 0.5);
    return;
  }
  if (!nearestEmptySlot(lastView.entities, own.x, own.z, kind)) {
    const rows = kind === 'peashooter' ? 'the front and back rows' : 'the two middle rows';
    hud.toast(`Walk next to an empty spot in ${rows} to plant a ${PLANT_NAME[kind]}!`, 2600);
    sfx('hurt', null, 0.5);
  }
}

/* ------------------------------------------------------------------ */
/* lobby backdrop: a cozy stage with a few friends                      */
/* ------------------------------------------------------------------ */

const dbg = (window.__bbDbg = {}); // test hooks: { cam: {pos, look}, demo: (t) => entity[], vm: {weapon, team} }

function demoEntities(t, cam) {
  const m = new Map();
  const face = (x, z) => Math.atan2(-(cam.x - x), -(cam.z - z));
  const put = (e) => { e.yaw = face(e.x, e.z); m.set(e.id, e); };
  if (!dbg.noDemo) {
    put({ id: 'demo-z1', kind: 'bot', team: 'zombie', x: -4.2, y: 0, z: 3.4, hp: 5, maxHp: 5, weapon: 'zombie_shotgun', state: 'alive' });
    put({ id: 'demo-z2', kind: 'bot', team: 'zombie', x: -6.6, y: 0, z: 1.6, hp: 5, maxHp: 5, weapon: 'goo_blaster', state: 'alive' });
    put({ id: 'demo-p1', kind: 'bot', team: 'plant', name: 'Gardener', x: -1.4, y: 0, z: 3.8, hp: 100, maxHp: 100, weapon: 'pea_blaster', state: 'alive' });
    put({ id: 'demo-g1', kind: 'garden', team: 'plant', plantKind: 'peashooter', x: 1.6, y: 0, z: 3.6, hp: 60, maxHp: 60, pitch: 0.15 });
    put({ id: 'demo-g2', kind: 'garden', team: 'plant', plantKind: 'cactus', x: 4.2, y: 0, z: 3.0, hp: 60, maxHp: 60 });
    put({ id: 'demo-p2', kind: 'player', team: 'plant', name: 'Sunny', x: 6.6, y: 0, z: 1.6, hp: 100, maxHp: 100, weapon: 'spike_shotgun', state: 'alive' });
  }
  if (dbg.demo) for (const e of dbg.demo(t)) m.set(e.id, e);
  if (!dbg.noDemo) m.set('demo-s', { id: 'demo-s', kind: 'sun', team: 'plant', x: 0, y: 2.2 + Math.sin(t) * 0.2, z: 6.5, yaw: 0, hp: 1, maxHp: 1, state: 'alive' });
  return m;
}

/* ------------------------------------------------------------------ */
/* main loop                                                           */
/* ------------------------------------------------------------------ */

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = viewCamera.aspect = w / h;
  camera.updateProjectionMatrix();
  viewCamera.updateProjectionMatrix();
  fx.setViewport(h * renderer.getPixelRatio(), camera.fov);
}
window.addEventListener('resize', resize);
resize();

canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
canvas.addEventListener('webglcontextrestored', () => { renderer.shadowMap.needsUpdate = true; });
renderer.shadowMap.needsUpdate = true;

// In the lobby the scene is shifted right so the menu card doesn't cover the stage.
let lobbyFraming = false;
function setLobbyFraming(on) {
  if (on === lobbyFraming) return;
  lobbyFraming = on;
  const w = window.innerWidth, h = window.innerHeight;
  if (on && w > 900) camera.setViewOffset(w, h, -w * 0.2, 0, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', () => { const on = lobbyFraming; lobbyFraming = !on; setLobbyFraming(on); });

let lastMs = performance.now();
const camTarget = new THREE.Vector3();

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  const dt = Math.min(0.05, Math.max(0.0001, (nowMs - lastMs) / 1000));
  lastMs = nowMs;
  const t = nowMs / 1000;

  // ---- delayed events
  if (S.pending.length) {
    let i = 0;
    while (i < S.pending.length && S.pending[i].due <= nowMs) {
      try { runEvent(S.pending[i].ev); } catch (err) { console.error('event failed', err); }
      i++;
    }
    if (i) S.pending.splice(0, i);
  }

  const id = S.joined ? myId() : null;
  const view = S.joined ? net.view(nowMs, id, 100, 45) : null;
  lastView = view;
  const snap = view ? view.snap : null;
  const own = view ? view.self : null;
  const inRound = !!(S.joined && own);

  // ---- camera
  if (inRound) {
    if (S.needYawSync) {
      input.yaw = num(own.yaw, 0);
      input.pitch = 0;
      S.lastYaw = input.yaw;
      S.lastPitch = 0;
      S.needYawSync = false;
    }
    const baseEye = num(S.config.eyeHeight, 1.6);
    const down = own.state === 'wilted' || own.state === 'sprout';
    S.eyeY += ((down ? 0.4 : baseEye) - S.eyeY) * Math.min(1, dt * (down ? 5 : 12));
    camera.position.set(own.x, num(own.y, 0) + S.eyeY, own.z);
    camera.rotation.set(input.pitch, input.yaw, 0, 'YXZ');
  } else {
    const a = t * 0.07;
    const R = 12;
    camera.position.set(Math.sin(a) * R, 3.4 + Math.sin(t * 0.13) * 0.6, 3 + Math.cos(a) * R);
    camTarget.set(0, 1.4, 3);
    camera.lookAt(camTarget);
  }
  setLobbyFraming(!inRound);
  if (dbg.cam && !inRound) {
    camera.position.set(...dbg.cam.pos);
    camera.lookAt(...dbg.cam.look);
  }
  camera.updateMatrixWorld();

  // ---- movement speed estimate (view bob)
  if (inRound) {
    if (S.gotCam) {
      const sp = Math.hypot(camera.position.x - S.lastCam.x, camera.position.z - S.lastCam.z) / dt;
      S.speed += (Math.min(sp, 12) - S.speed) * Math.min(1, dt * 10);
    }
    S.lastCam.copy(camera.position);
    S.gotCam = true;
  } else {
    S.speed = 0;
    S.gotCam = false;
  }

  // ---- world state
  const entities = inRound ? view.entities : demoEntities(t, camera.position);
  let skyT = 0.9;
  if (S.joined && snap) {
    const rl = Math.max(1, num(snap.roundLength, 480));
    skyT = clamp(num(snap.roundTime, 0) / rl, 0, 1);
    if (snap.phase === 'ended' && snap.winner === 'plant') skyT = 1;
  }
  if (dbg.skyT !== undefined) skyT = dbg.skyT;
  world.setTime(skyT, dt);
  world.update(dt, camera, nowMs);

  layer.sync(entities, id, { t, dt, camera });
  handleLayerChanges();

  if (inRound) gameplayFrame(dt, t, nowMs, own, snap, entities);
  else {
    hud.update({ own: null, snap: null, config: S.config, now: nowMs, locked: false, nearSlot: null });
    sound.engineLevel(0);
    for (const k of ['weed', 'blower', 'trimmer', 'squeak']) sound.loopLevel(k, 0);
  }

  // join timeout
  if (S.joined && !own && nowMs - S.joinAt > 6000) {
    // The socket may be half-dead: retry on a fresh one (the server swaps out any ghost of ours via cid).
    net.restart();
    leaveToLobby("Couldn't join the game. Reconnecting — try again in a moment!", true);
  }

  // ---- view model (own gun)
  let alive = inRound && own.state !== 'wilted' && own.state !== 'sprout';
  let vmUsing = inRound && !!S.usingSelf;
  if (dbg.vm && !inRound) {
    vm.setWeapon(dbg.vm.weapon || 'pea_blaster', dbg.vm.team || 'plant');
    vm.setHeld(dbg.vm.item || null);
    vmUsing = !!dbg.vm.using;
    alive = true;
  }
  if (inRound) {
    vm.setWeapon(own.weapon || (own.team === 'zombie' ? 'goo_blaster' : 'pea_blaster'), own.team === 'zombie' ? 'zombie' : 'plant');
    vm.setHeld(typeof own.item === 'string' && own.item ? own.item : null);
  }
  const dYaw = input.yaw - S.lastYaw, dPitch = input.pitch - S.lastPitch;
  S.lastYaw = input.yaw; S.lastPitch = input.pitch;
  vm.update(dt, t, S.speed, Math.abs(dYaw) > PI ? 0 : dYaw, dPitch, alive, vmUsing);
  // light the gun consistently with the world
  qInv.copy(camera.quaternion).invert();
  vmDir.set(0.5, 1, 0.8).applyQuaternion(qInv);
  world.vDir.position.copy(vmDir);

  fx.update(dt);
  sound.setListener(camera.position.x, camera.position.y, camera.position.z, input.yaw);

  renderer.clear();
  renderer.render(world.scene, camera);
  if (vm.root.visible) {
    renderer.clearDepth();
    renderer.render(world.viewScene, viewCamera);
  }
}

function handleLayerChanges() {
  if (S.joined) {
    for (const rec of layer.added) {
      if (rec.id.startsWith('demo-')) continue;
      if (rec.model.projectile) {
        const d = Math.hypot(rec.x - camera.position.x, rec.y - camera.position.y, rec.z - camera.position.z);
        const name = fireSound(rec.e.projKind);
        if (d > 4) sfx(name, { x: rec.x, y: rec.y, z: rec.z }, 0.7, 45);
        layer.kickNear(rec.x, rec.z, 1.4);
      }
    }
  }
  for (const rec of layer.removed) {
    if (rec.id.startsWith('demo-')) continue;
    if (rec.key === 'sun') {
      fx.sparkle(rec.x, rec.y, rec.z, 0xffe14a, 8, 1.0);
    }
  }
}

function gameplayFrame(dt, t, nowMs, own, snap, entities) {
  const team = own.team === 'zombie' ? 'zombie' : 'plant';
  const alive = own.state !== 'wilted' && own.state !== 'sprout';

  // phase transitions
  if (snap && snap.phase !== S.lastPhase) {
    if (snap.phase === 'ended') {
      const won = snap.winner && snap.winner === team;
      sfx(won ? 'win' : 'lose');
      if (snap.winner === 'plant') {
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        fx.confetti(camera.position.x + f.x * 4, camera.position.y + 1, camera.position.z + f.z * 4);
      }
      input.fire = false;
    } else if (snap.phase === 'playing' && S.lastPhase === 'ended') {
      hud.resetForJoin(nowMs);
      S.needYawSync = true;
      S.introShown = false;
    }
    S.lastPhase = snap.phase;
  }

  // sunshine ding
  if (team === 'plant') {
    const sun = num(own.sunshine, 0);
    if (S.lastSun !== null && sun > S.lastSun && sun - S.lastSun <= 60) sfx('sun');
    S.lastSun = sun;
  }

  // intro tip
  if (!S.introShown && alive && snap && snap.phase === 'playing') {
    S.introShown = true;
    hud.toast(team === 'plant'
      ? 'Shoot the zombies! Stand by an empty garden spot and press 1 or 2 to plant.'
      : 'Head for the garage on the right: hold E by the mower, or press E at the rack to grab a tool!', 6000);
  }

  const held = alive && typeof own.item === 'string' && own.item ? own.item : null;
  const playing = !!(snap && snap.phase === 'playing');

  // local gun feedback (the server does the real shooting)
  S.fireCd -= dt;
  const canShoot = alive && playing && input.fire && input.locked;
  if (canShoot && !held && S.fireCd <= 0) {
    const wi = weaponInfo(own.weapon, team);
    S.fireCd = 1 / Math.max(0.5, wi.rate);
    vm.fire();
    sound.play(fireSound(wi.proj), null, wi.rate > 8 ? 0.55 : 0.9);
  } else if (!(canShoot && !held) && S.fireCd < 0) {
    S.fireCd = 0;
  }
  // holding a tool: the trigger runs it (the server confirms with `using`; react to the click right away)
  const usingSelf = !!(held && held !== 'wheelbarrow' && (own.using || (canShoot && input.fire)));
  S.usingSelf = usingSelf;

  // ---- prompts, slot ring
  let prompt = '';
  let nearSlotInfo = null;
  let mower = null;
  let rackNear = null, rackNearD = Infinity, rackWait = null, rackWaitD = Infinity;
  const rackRange = num(S.config.rackUseRange, 2);
  for (const e of entities.values()) {
    if (e.kind === 'mower') mower = e;
    else if (e.kind === 'rack_item' && team === 'zombie') {
      const d = Math.hypot(e.x - own.x, e.z - own.z);
      if (e.available !== false) { if (d < rackNearD) { rackNearD = d; rackNear = e; } }
      else if (d < rackWaitD) { rackWaitD = d; rackWait = e; }
    }
  }
  let mowerHud = null;
  world.hideSlot();
  if (alive && playing) {
    if (team === 'zombie') {
      const heldName = held ? itemInfo(held).name : '';
      let mowerPrompt = '';
      let drivingMine = false;
      let dm = Infinity;
      if (mower) {
        dm = Math.hypot(mower.x - own.x, mower.z - own.z);
        // `driver` is the entity id at the controls (null when idle); older servers omit it.
        const mine = mower.driver === undefined ? dm < 3.4 : mower.driver !== null && String(mower.driver) === String(myId());
        if (mower.state === 'idle' && dm < 3.4) mowerPrompt = held ? `Put the ${heldName} down (Q) before starting the mower` : 'Hold E to start the mower! \u{1F69C}';
        else if (mower.state === 'starting' && mine) { mowerPrompt = `Engine starting… keep holding E! ${Math.round(num(mower.progress, 0) * 100)}%`; drivingMine = true; }
        else if (mower.state === 'driving' && mine) { mowerPrompt = "You're driving the mower — squash the plants! Press E to hop off"; drivingMine = true; }
        else if (mower.state === 'destroyed' && dm < 9) mowerPrompt = `The mower is broken! Fixed in ${Math.max(1, Math.ceil(num(mower.respawnIn, 0)))} s`;
        if (mine && mower.state === 'driving') {
          S.wasDriving = nowMs;
          mowerHud = { hp: num(mower.hp, 0), maxHp: num(mower.maxHp, 40) };
        }
      }
      if (drivingMine) prompt = mowerPrompt;
      else if (held) {
        if (mowerPrompt && mower.state === 'idle') prompt = mowerPrompt;
        else {
          // E at its own rack hangs the tool back up
          const home = entities.get('rack_' + held);
          const atRack = home && Math.hypot(home.x - own.x, home.z - own.z) <= rackRange;
          if (held === 'wheelbarrow') prompt = `${heldName} — a rolling shield! HP ${Math.ceil(num(own.itemHp, 0))}. Press Q to drop`;
          else prompt = `${heldName} — hold fire to use. Press Q to drop`;
          if (atRack) prompt += ', E to hang it back up';
        }
      } else if (rackNear && rackNearD <= rackRange + 1 && !(mowerPrompt && mower.state === 'idle' && dm < rackNearD)) {
        const info = itemInfo(rackNear.itemId);
        prompt = `Press E for the ${info.name}${info.blurb ? ' — ' + info.blurb : ''}`;
      } else if (mowerPrompt) {
        prompt = mowerPrompt;
      } else if (rackWait && rackWaitD <= rackRange + 1) {
        const info = itemInfo(rackWait.itemId);
        prompt = rackWait.respawnIn !== undefined && rackWait.respawnIn !== null
          ? `The ${info.name} is coming back in ${Math.max(1, Math.ceil(num(rackWait.respawnIn, 0)))} s`
          : `Someone else has the ${info.name}!`;
      }
    }
    if (team === 'plant' && !prompt) {
      const s = nearestEmptySlot(entities, own.x, own.z, null);
      if (s) {
        nearSlotInfo = s;
        const cost = plantCost(s.kind);
        const ok = num(own.sunshine, 0) >= cost;
        world.showSlot(s.x, s.z, ok);
        prompt = ok
          ? `Press ${s.kind === 'peashooter' ? 1 : 2} to plant a ${PLANT_NAME[s.kind]}!`
          : `A ${PLANT_NAME[s.kind]} needs ☀️ ${cost} — grab some sunshine!`;
      }
    }
  }
  hud.setPrompt(prompt);
  S.nearSlot = nearSlotInfo;

  hud.update({ own, snap, config: S.config, now: nowMs, locked: input.locked || input.menuOpen, nearSlot: nearSlotInfo, mower: mowerHud });

  entityEffects(dt, nowMs, entities, own, usingSelf);
}

// Per-frame effects and sound loops that come from what fighters are holding / doing and from the mower.
const loopLv = { weed: 0, blower: 0, trimmer: 0, squeak: 0 };

function entityEffects(dt, nowMs, entities, own, usingSelf) {
  const me = myId();
  let engine = 0;
  loopLv.weed = loopLv.blower = loopLv.trimmer = loopLv.squeak = 0;
  if (S.hitAt.size > 400) S.hitAt.clear();
  const cx = camera.position.x, cz = camera.position.z;
  for (const e of entities.values()) {
    if (e.kind === 'mower') {
      const active = e.state === 'driving' || e.state === 'starting';
      if (active) {
        const d = Math.hypot(e.x - cx, e.z - cz);
        engine = Math.max(engine, clamp(1 - d / 70, 0, 1) * (e.state === 'starting' ? 0.7 : 1));
        S.smokeAcc += dt * (e.state === 'driving' ? 22 : 12);
        while (S.smokeAcc >= 1) {
          S.smokeAcc -= 1;
          const c = Math.cos(num(e.yaw, 0)), s = Math.sin(num(e.yaw, 0));
          // exhaust pipe sits at (0.32, 1.1, 0.2) in mower space
          fx.smoke(e.x + 0.32 * c + 0.2 * s, num(e.y, 0) + 1.15, e.z - 0.32 * s + 0.2 * c);
        }
      }
      // a battered mower coughs dark smoke
      if (e.state !== 'destroyed' && num(e.maxHp, 0) > 0 && num(e.hp, 0) / e.maxHp < 0.5 && Math.random() < dt * (0.5 - num(e.hp, 0) / e.maxHp) * 24) {
        fx.mowerSputter(e.x + rnd(-0.3, 0.3), num(e.y, 0) + 0.9, e.z + rnd(-0.3, 0.3));
      }
      continue;
    }
    if ((e.kind !== 'player' && e.kind !== 'bot') || e.state === 'wilted' || e.state === 'sprout') continue;
    const isMe = me !== null && String(e.id) === me;
    const d = isMe ? 0 : Math.hypot(e.x - cx, e.z - cz);
    // icy glitter on slowed fighters
    if (e.slowed && Math.random() < dt * 9) fx.ice(e.x, num(e.y, 0), e.z);
    const item = typeof e.item === 'string' ? e.item : null;
    if (!item || d > 60) continue;
    const using = isMe ? usingSelf : !!e.using;
    const att = isMe ? 1 : 1 / (1 + d / 9);
    if (item === 'wheelbarrow') {
      const rec = isMe ? null : layer.recs.get(String(e.id));
      const sp = isMe ? S.speed : rec ? rec.speed : 0;
      loopLv.squeak = Math.max(loopLv.squeak, clamp(sp / 4, 0, 1) * att);
      continue;
    }
    if (!using) continue;
    // where the business end is, and which way it points
    const yaw = isMe ? input.yaw : num(e.yaw, 0);
    const pitch = isMe ? input.pitch : 0;
    const fx0 = -Math.sin(yaw), fz0 = -Math.cos(yaw);
    const ox = isMe ? cx : e.x, oz = isMe ? cz : e.z;
    const oy = isMe ? camera.position.y - 0.4 : num(e.y, 0) + 1.0;
    if (item === 'leaf_blower') {
      loopLv.blower = Math.max(loopLv.blower, att);
      S.fxAcc += dt * 45;
      while (S.fxAcc >= 1) {
        S.fxAcc -= 1;
        const a = yaw + (Math.random() - 0.5) * 0.7;
        const dx = -Math.sin(a), dz = -Math.cos(a);
        const dy = Math.sin(pitch) * 0.6 - 0.04 + (Math.random() - 0.5) * 0.12;
        const r = 0.8 + Math.random() * 0.4;
        fx.wind(ox + dx * r, oy + dy * r, oz + dz * r, dx, dy, dz);
      }
    } else if (item === 'weed_eater') {
      loopLv.weed = Math.max(loopLv.weed, att);
      if (Math.random() < dt * 14) fx.leafBurst(ox + fx0 * 1.3, num(e.y, 0) + 0.3, oz + fz0 * 1.3, 1, [0x66bb6a, 0x8bd450, 0xa5e84f], 3, 2);
    } else if (item === 'hedge_trimmer') {
      loopLv.trimmer = Math.max(loopLv.trimmer, att);
      if (Math.random() < dt * 9) fx.leafBurst(ox + fx0 * 1.4, num(e.y, 0) + 0.8, oz + fz0 * 1.4, 1, [0x43a047, 0x66bb6a], 2.5, 2);
    }
  }
  sound.engineLevel(engine);
  sound.loopLevel('weed', loopLv.weed);
  sound.loopLevel('blower', loopLv.blower);
  sound.loopLevel('trimmer', loopLv.trimmer);
  sound.loopLevel('squeak', loopLv.squeak);
}

requestAnimationFrame(frame);

// small debug handle (handy in the browser console)
window.__bb = { net, input, world, layer, fx, sound, hud, state: S, camera, renderer };

window.addEventListener('error', (e) => {
  if (!S.joined) lobby.setStatus('Oops: ' + (e.message || 'something went wrong'), true);
});
