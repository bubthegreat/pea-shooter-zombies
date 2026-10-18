// Backyard Battle client: wires the network, input, scene and HUD together.
import * as THREE from 'three';
import { Net } from './net.js';
import { Input } from './input.js';
import { World, EntityLayer } from './scene.js';
import { MapData } from './map.js';
import { plantList, unlockedPlants, pickUpgradeTarget, upgradePrompt, stars } from './plants.js';
import { makeGun, makeItem, makeHands, weaponInfo, setWeaponTable, setEquipmentTable, itemInfo, toon, G, add, getGlowTex, PART_INFO } from './models.js';
import { ruleText } from './lobbyview.js';
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
fx.groundAt = (x, z) => world.groundAt(x, z);
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
const VM_GUN_SCALE = { brain_cannon: 0.58, sludge_sprayer: 0.66 };

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
  map: null,
  mapKey: '',
  round: null,
  joinedAt: 0,
  lastHs: 0,
  buildFailAt: 0,
  alarmLevel: 0,
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
let SLOTS = [];
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

/** Back to the menus: stop playing locally (the server decides which lobby screen to show). */
function leaveGameView() {
  S.joined = false;
  input.enabled = false;
  input.stopSending();
  input.exitLock();
  hud.hide();
  hud.clearFeed();
  hud.hideLoading();
  S.loading = false;
  buildCancel();
  layer.clear();
  world.hideSlot();
  sound.engineLevel(0);
  lobby.show();
}

const R = { room: null, you: null }; // the lobby we are in, from the latest lobbyState

/** The welcome message carries the static map; build the level once and reset it at the start of every round. */
function loadMap(state) {
  const m = S.config.map;
  if (!m || !m.terrain) return;
  const key = `${m.terrain.data.length}:${m.terrain.data.slice(0, 48)}:${m.statics.length}:${(m.cover || []).length}`;
  if (!S.map || S.mapKey !== key) {
    S.mapKey = key;
    S.map = new MapData(m, S.config.builds, null);
    S.map.slots = S.config.gardenSlots || [];
    world.setMap(S.map);
    renderer.shadowMap.needsUpdate = true;
  }
  S.map.reset(state || null);
  S.round = state && typeof state.round === 'number' ? state.round : null;
  world.cover.reset();
  world.cover.sync();
  S.lastState = state || null;
}

function hello() {
  net.send({ t: 'listLobbies', cid: CID, name: profile.name }); // also lets the server put a reconnecting page back
}

net.on('open', () => {
  lobby.setConnected(true);
  hello();
});
net.on('close', () => {
  const wasIn = S.joined || !!R.room;
  R.room = null;
  options.setInLobby(false);
  lobby.setConnected(false);
  lobby.setList([]);
  leaveGameView();
  lobby.showBrowse();
  lobby.setStatus(wasIn ? 'Lost the connection — reconnecting…' : 'Connecting…', wasIn);
});
net.on('welcome', (msg) => {
  S.config = msg.config || {};
  setWeaponTable(S.config.weapons);
  setEquipmentTable(S.config.equipment);
  if (Array.isArray(S.config.gardenSlots) && S.config.gardenSlots.length) {
    SLOTS = S.config.gardenSlots.filter((s) => s && Number.isFinite(s.x) && Number.isFinite(s.z) && typeof s.kind === 'string');
  }
  loadMap(msg.state);
  enterGame();
});
net.on('msg', (msg) => {
  if (msg.t === 'lobbies') lobby.setList(msg.lobbies);
  else if (msg.t === 'lobbyState') onLobbyState(msg);
  else if (msg.t === 'error') {
    if (S.joined) hud.toast(msg.message || 'Something went wrong. Try again!', 2600);
    else lobby.setStatus(msg.message || msg.reason || "That didn't work. Try again!", true);
  }
});
net.on('snap', onSnap);

function onLobbyState(msg) {
  const room = msg.lobby && typeof msg.lobby === 'object' ? msg.lobby : null;
  const prevHost = R.room ? R.room.host : null;
  R.room = room;
  R.you = msg.you ?? null;
  options.setInLobby(!!room);
  if (!room) {
    // left (or the lobby closed under us): back to the browser
    if (S.joined) leaveGameView();
    lobby.setRoom(null, null);
    lobby.showBrowse();
    return;
  }
  lobby.setRoom(room, R.you);
  if (room.status === 'waiting') {
    // round over (or we just arrived): the waiting room
    if (S.joined) leaveGameView();
    if (lobby.screen !== 'room') lobby.showRoom();
    lobby.show();
  } else if (!S.joined) {
    lobby.showRoom(); // a running game: the welcome message that follows takes us in
  } else if (prevHost !== null && prevHost !== room.host && room.host === R.you) {
    hud.toast("You're the host now!", 2600);
  }
}

/** The server welcomed us into a running game: show it. */
function enterGame() {
  const me = R.room && R.room.players.find((p) => p.id === net.id);
  S.team = me && me.team === 'zombie' ? 'zombie' : 'plant';
  S.joined = true;
  S.joinAt = performance.now();
  S.needYawSync = true;
  S.lastPhase = null;
  S.lastWeapon = null;
  S.lastSun = null;
  S.lastOwnState = null;
  S.introShown = false;
  S.loading = true;
  hud.showLoading(ruleText(S.team));
  buildCancel();
  S.gotCam = false;
  S.eyeY = 1.6;
  S.wasDriving = 0;
  vm.gunId = null;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  hud.show();
  hud.resetForJoin(performance.now());
  lobby.hide();
  layer.clear();
  input.enabled = true;
  input.requestLock();
  // wait for the first snapshot (it carries our spawn facing) before sending look angles
  input.startSending((m) => (S.joined && !S.needYawSync ? net.send(m) : false));
}

// button presses in the lobby screens (a click is also the browser's permission to play sounds / go fullscreen)
function press() {
  sound.unlock();
  sfx('click');
}
lobby.onCreate = (o) => {
  if (!net.open) return;
  press();
  net.send({ t: 'createLobby', lobbyName: o.lobbyName, mode: o.mode, difficulty: o.difficulty, team: lobby.choice.team, name: profile.name, cid: CID });
};
lobby.onJoin = (lobbyId) => {
  if (!net.open) return;
  press();
  net.send({ t: 'joinLobby', lobbyId, team: lobby.choice.team, name: profile.name, cid: CID });
};
lobby.onTeam = (team) => { press(); net.send({ t: 'setTeam', team }); };
lobby.onOptions = (o) => { press(); net.send({ t: 'setOptions', ...o }); };
lobby.onStart = () => {
  if (!net.open) return;
  press();
  net.send({ t: 'startGame' });
};
lobby.onLeave = leaveLobby;

function leaveLobby() {
  press();
  options.close(false);
  net.send({ t: 'leaveLobby' });
  R.room = null;
  options.setInLobby(false);
  if (S.joined) leaveGameView();
  lobby.setRoom(null, null);
  lobby.showBrowse();
}
hud.el.endLeave.addEventListener('click', leaveLobby);
hud.el.mute.addEventListener('click', () => toggleMute());
input.onToggleMute = toggleMute;
input.onToggleHelp = () => hud.toggleHelp();
input.onPlantKey = (n) => onPlantKey(n);

profile.subscribe((name) => { if (net.open) net.send({ t: 'setName', name }); }); // renamed (settings panel, lobby page)
const options = new Options();
options.onLeave = leaveLobby;
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
  // a new round without a new welcome (single-lobby dev servers): everything is back to full health
  if (S.map && typeof snap.round === 'number' && S.round !== null && snap.round !== S.round) {
    S.round = snap.round;
    S.map.reset(null);
    world.cover.reset();
    world.cover.sync();
    buildCancel();
  } else if (typeof snap.round === 'number' && S.round === null) S.round = snap.round;
  for (const ev of evs) {
    if (!ev || typeof ev.type !== 'string') continue;
    // static-map changes are applied to the data right away (the ghost needs them); their visuals follow with the delay below
    if (S.map && (ev.type === 'coverHit' || ev.type === 'coverBreak' || ev.type === 'build')) S.map.onEvent(ev);
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
      const name = typeof ev.name === 'string' ? ev.name : '';
      if (typeof ev.plantKind === 'string' && ev.plantKind) {
        // a plant kid keeps the Pea Blaster: the reward is a new plant for the seed bar
        hud.banner(ev.bonus ? 'STREAK BONUS!' : 'NEW PLANT!', ev.bonus ? `NEW PLANT! ${name}` : name, 'upgrade');
        sfx('unlock');
        const fresh = plantList(S.config).find((p) => p.id === ev.plantKind);
        if (fresh) hud.toast(`Press ${fresh.key} to plant a ${fresh.name}!`, 4500);
      } else {
        hud.banner(ev.bonus ? 'STREAK BONUS!' : 'UPGRADE!', name, 'upgrade');
        sfx('chime');
        vm.swap = 1;
      }
      fx.sparkle(camera.position.x, camera.position.y - 0.4, camera.position.z, 0xfff59d, 14, 1.4);
      continue;
    } else if (ev.type === 'plantUp' && me !== null && ev.by !== undefined && ev.by !== null && String(ev.by) === me) {
      hud.toast(`${plantName(ev.plantKind)} grew to level ${num(ev.level, 2)}! ${stars(num(ev.level, 2))}`, 2200);
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
  const me = myId();
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
    case 'plantUp': {
      const lv = num(ev.level, 2);
      if (have) fx.levelUp(x, 0.6, z, lv);
      sfx('levelup', pos, 1, 80);
      break;
    }
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
    case 'coverHit': {
      world.cover.onEvent(ev);
      if (pos) fx.hit(pos.x, 1, pos.z, 0xe0e0e0);
      sfx('thunk', pos, 0.8, 90);
      break;
    }
    case 'coverBreak': {
      const d = world.cover.onEvent(ev);
      if (d) {
        fx.debris(d.kind, d.x, d.y, d.z);
        sfx(d.kind === 'door' ? 'doorbreak' : 'crunch', d, d.kind === 'door' ? 1 : 0.9, 80);
      }
      if (ev.kind === 'door') hud.toast('A door broke! Zombies can get in!', 2400);
      break;
    }
    case 'build': {
      world.cover.onEvent(ev);
      const b = S.map && S.map.placed.get(ev.id);
      if (b) {
        const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
        fx.buildPuff(cx, world.groundAt(cx, cz), cz);
        sfx('build', { x: cx, y: 1, z: cz }, 0.9, 60);
      }
      break;
    }
    case 'buildFail':
      if (me !== null && String(ev.by) === me && performance.now() - S.buildFailAt > 400) {
        S.buildFailAt = performance.now();
        hud.toast(BUILD_FAIL[ev.reason] || "Can't build there!", 1800);
        sfx('hurt', null, 0.5);
      }
      break;
    case 'install': {
      if (have) fx.install(x, 1.1, z);
      sfx('install', pos, 1, 80);
      if (me !== null && String(ev.id) === me) hud.toast(ev.target === 'mower' ? `${PART_INFO[ev.part]?.name || 'Part'} is in the mower!` : `${itemInfo(ev.target).name} is powered! Press E to grab it`, 3000);
      break;
    }
    case 'partTake': {
      const p = recPos(ev.id);
      sfx('pickup', p, 0.9, 80);
      if (me !== null && String(ev.id) === me) hud.toast(`You got the ${PART_INFO[ev.part]?.name || 'part'}! Take it to the mower or a tool hook in the garage`, 3600);
      break;
    }
    case 'partDrop': {
      if (have) fx.sparkle(x, y + 0.8, z, 0xfff59d, 6, 0.8);
      sfx('drop', pos, 0.7, 100);
      if (me !== null && String(ev.id) === me && ev.reason === 'shot') hud.toast('Ouch! You dropped the part!', 2000);
      break;
    }
    case 'release':
      hud.banner('ZOMBIES COME OUT!', 'Guard the doors and the fridge!', 'wave');
      sfx('release');
      break;
    case 'fridgeAlarm':
      sfx('wave', pos, 0.6);
      break;
    default:
      break;
  }
}

const BUILD_FAIL = {
  cost: 'Not enough to build that yet!',
  cap: 'You have too many forts standing already!',
  spot: "That's not a good spot to build!",
  far: 'Too far away to build there!',
  blocked: 'Something is in the way (doors, gardens and the house need room)!',
  busy: 'Somebody is standing there!',
};

/* ------------------------------------------------------------------ */
/* planting helpers                                                    */
/* ------------------------------------------------------------------ */

const PLANT_RANGE = 4;
const plantInfo = (kind) => plantList(S.config).find((p) => p.id === kind) || null;
const plantName = (kind) => (plantInfo(kind) ? plantInfo(kind).name : 'Plant');

/** Nearest empty garden slot within planting range (any plant fits any slot). */
function nearestEmptySlot(entities, px, pz) {
  let best = null, bd = PLANT_RANGE;
  for (const s of SLOTS) {
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
  const info = plantList(S.config)[n - 1];
  if (!info) return;
  if (info.tier > num(own.tier, 0)) {
    hud.toast(`${info.name} is locked! Convert more zombies to unlock it.`, 2200);
    sfx('hurt', null, 0.5);
    return;
  }
  hud.pressSeed(n);
  if (num(own.sunshine, 0) < info.cost) {
    hud.toast(`Not enough sunshine yet! ${info.name} costs ${info.cost}`, 1800);
    sfx('hurt', null, 0.5);
    return;
  }
  if (!nearestEmptySlot(lastView.entities, own.x, own.z)) {
    hud.toast(`Walk next to an empty garden spot to plant a ${info.name}!`, 2600);
    sfx('hurt', null, 0.5);
  }
}

/* ------------------------------------------------------------------ */
/* building: B opens the wheel, a digit (or a tap) picks, the ghost follows the crosshair on the 1 m grid */
/* ------------------------------------------------------------------ */

const B = { active: false, kind: 0, rot: 0, wallnut: 0, last: null };
const BUILD_ICONS = { hedgewall: '\u{1F33F}', fence: '\u{1F6A7}', tombwall: '\u{1F9F1}', junk: '\u{1F6E2}\uFE0F', cantower: '\u{1F5D1}\uFE0F', wallnut: '\u{1F330}' };

/** The wheel: the team's build kinds (plants get the Wall-nut as a last slot: it is still a plant). */
function buildWheelItems(team, own) {
  if (!S.map) return [];
  const list = S.map.listFor(team);
  const unit = team === 'zombie' ? '\u{1F9E0}' : '\u2600\uFE0F';
  const have = team === 'zombie' ? num(own.brains, 0) : num(own.sunshine, 0);
  const items = list.map((d, i) => ({ n: i + 1, icon: BUILD_ICONS[d.id] || '\u{1F9F1}', name: d.name, cost: d.cost, unit, ok: have >= d.cost }));
  if (team !== 'zombie') {
    const wn = plantList(S.config).find((p) => p.id === 'wallnut');
    if (wn) items.push({ n: list.length + 1, icon: BUILD_ICONS.wallnut, name: wn.name, cost: wn.cost, unit, ok: num(own.tier, 0) >= wn.tier && have >= wn.cost });
  }
  return items;
}

function buildSync() {
  input.buildActive = B.active;
  input.buildKind = B.kind;
}

function buildCancel() {
  B.active = false;
  B.kind = 0;
  B.rot = 0;
  buildSync();
  hud.setBuildWheel(null);
  hud.setBuildBar('', '');
  if (world.cover) world.cover.setGhost(null);
}

function buildToggle() {
  if (!S.joined || !lastView || !lastView.self) return;
  const own = lastView.self;
  if (own.state === 'wilted' || own.state === 'sprout' || !S.map) return;
  if (B.active) {
    buildCancel();
    return;
  }
  if (S.team === 'zombie' && lastView.snap && num(lastView.snap.headStart, 0) > 0) {
    hud.toast('You can build once the gate opens!', 1800);
    return;
  }
  B.active = true;
  B.kind = 0;
  buildSync();
  sfx('click');
}

function buildPick(n) {
  if (!B.active || !lastView || !lastView.self) return;
  const own = lastView.self;
  const items = buildWheelItems(S.team, own);
  const it = items.find((x) => x.n === n);
  if (!it) return;
  const list = S.map.listFor(S.team);
  if (n <= list.length) {
    B.kind = n;
    B.rot = 0;
    buildSync();
    sfx('click');
    return;
  }
  // the Wall-nut is a plant: plant it in the nearest empty garden spot (key = its seed number)
  const key = plantList(S.config).findIndex((p) => p.id === 'wallnut') + 1;
  buildCancel();
  if (key > 0) {
    input._plant(key);
  }
}

function buildScroll(dir) {
  if (!B.active || !lastView || !lastView.self) return;
  const count = buildWheelItems(S.team, lastView.self).length;
  if (!count) return;
  if (B.kind === 0) buildPick(dir > 0 ? 1 : count);
  else if (B.kind <= S.map.listFor(S.team).length) {
    const lim = S.map.listFor(S.team).length;
    B.kind = ((B.kind - 1 + dir + lim) % lim) + 1;
    B.rot = 0;
    buildSync();
  }
}

function buildRotate() {
  if (!B.active || !B.kind) return;
  B.rot ^= 1;
  sfx('tick');
}

function buildPlace() {
  if (!B.active || !B.kind || !B.last) return;
  if (!B.last.ok) {
    hud.toast(BUILD_FAIL[B.last.reason] || "Can't build there!", 1500);
    sfx('hurt', null, 0.5);
    return;
  }
  input.builder.press(B.kind, B.last.gx, B.last.gz, B.rot);
}

/** Per frame while a build is selected: where the ghost goes and whether it may. */
function buildFrame(own, entities) {
  const team = S.team;
  const list = S.map.listFor(team);
  const def = list[B.kind - 1];
  if (!def) {
    B.last = null;
    return;
  }
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const eye = camera.position;
  const reach = S.map.builds.reach;
  const hit = S.map.rayGround(eye.x, eye.y, eye.z, f.x, f.y, f.z, reach + 8);
  const tx = hit ? hit.x : eye.x + f.x * 7;
  const tz = hit ? hit.z : eye.z + f.z * 7;
  const { gx, gz } = S.map.cellFor(def, B.rot, tx, tz);
  const others = [];
  for (const e of entities.values()) if ((e.kind === 'player' || e.kind === 'bot' || e.kind === 'garden') && e.state !== 'dead') others.push({ x: e.x, z: e.z, radius: e.radius ?? (e.kind === 'garden' ? 0.6 : 0.5) });
  const me = { x: own.x, z: own.z };
  const pl = S.map.placement(def, gx, gz, B.rot, me, others.filter((o) => Math.hypot(o.x - own.x, o.z - own.z) > 0.01));
  const have = team === 'zombie' ? num(own.brains, 0) : num(own.sunshine, 0);
  let mine = 0;
  for (const b of S.map.placed.values()) if (b.alive && String(b.by) === myId()) mine++;
  let reason = pl.ok ? null : pl.reason;
  if (pl.ok && have < def.cost) reason = 'cost';
  else if (pl.ok && mine >= S.map.builds.maxPerPlayer) reason = 'cap';
  const ok = !reason;
  B.last = { gx, gz, ok, reason };
  const cx = (pl.rect.minX + pl.rect.maxX) / 2, cz = (pl.rect.minZ + pl.rect.maxZ) / 2;
  world.cover.setGhost(def, pl.rect, ok, S.map.supportY(cx, cz, 5) - 0.02);
  const unit = team === 'zombie' ? 'brains' : 'sunshine';
  const hint = isTouch() ? 'Tap PLACE \u2022 TURN spins it \u2022 BACK cancels' : 'Click to build \u2022 R turns it \u2022 B cancels';
  hud.setBuildBar(`${def.name}  (${def.cost} ${unit})`, ok ? hint : (BUILD_FAIL[reason] || "Can't build there!"), !ok);
}

input.onBuildToggle = buildToggle;
input.onBuildPick = buildPick;
input.onBuildPlace = buildPlace;
input.onBuildRotate = buildRotate;
input.onBuildScroll = buildScroll;

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
    put({ id: 'demo-p2', kind: 'player', team: 'plant', name: 'Sunny', x: 6.6, y: 0, z: 1.6, hp: 100, maxHp: 100, weapon: 'pea_blaster', state: 'alive' });
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

const groundFn = (x, z, y) => (world.map ? world.map.supportY(x, z, y) : 0);
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
  if (dbg.freecam) {
    // test hook: park the camera anywhere (screenshots of the whole map)
    camera.position.set(...dbg.freecam.pos);
    camera.lookAt(...dbg.freecam.look);
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

  layer.sync(entities, id, { t, dt, camera, ground: groundFn });
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
    net.restart(); // the close handler puts us in the menu; the server puts a rejoining page back in its lobby
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
  renderer.info.reset();
  renderer.render(world.scene, camera);
  S.stats = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
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
  S.team = team;
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
      ? 'Quick! Stand by an empty garden spot and press 1 or 2 to plant. Press B to build a fort!'
      : 'Wait for the gate to open, then break a door and raid the fridge! Press B to build a fort.', 6000);
  }
  // fade the loading screen out once we are really playing
  if (S.loading && performance.now() - S.joinAt > 1800) {
    S.loading = false;
    hud.hideLoading();
  }

  // the world reacts to the round: the gate swings open when the head start ends, the fridge door when zombies come
  const fr = snap && snap.fridge ? snap.fridge : null;
  const hs = snap ? num(snap.headStart, 0) : 0;
  world.state.fridgeN = fr ? num(fr.n, 0) : 0;
  world.state.gateOpen = !(hs > 0);
  if (hs > 0) {
    const sec = Math.ceil(hs);
    if (sec !== S.lastHs && sec <= 3) sfx('countdown', null, 0.8);
    S.lastHs = sec;
  }
  {
    const f = S.config.map && S.config.map.fridge;
    const n = fr ? num(fr.n, 0) : 0;
    const d = f ? Math.hypot(f.x - camera.position.x, f.z - camera.position.z) : 99;
    const want = n > 0 ? clamp(1.1 - d / 50, 0.2, 1) : 0;
    S.alarmLevel += (want - S.alarmLevel) * Math.min(1, dt * 6);
    sound.loopLevel('alarm', S.alarmLevel);
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
  let unpowered = null, unpoweredD = Infinity, partNear = null, partNearD = Infinity, carryRack = null, carryRackD = Infinity;
  const rackRange = num(S.config.rackUseRange, 2);
  const carrying = typeof own.carry === 'string' && PART_INFO[own.carry] ? own.carry : null;
  for (const e of entities.values()) {
    if (e.kind === 'mower') mower = e;
    else if (e.kind === 'part' && team === 'zombie') {
      const d = Math.hypot(e.x - own.x, e.z - own.z);
      if (d < partNearD && Math.abs(num(e.y, 0) - num(own.y, 0)) < 1.8) { partNearD = d; partNear = e; }
    } else if (e.kind === 'rack_item' && team === 'zombie') {
      const d = Math.hypot(e.x - own.x, e.z - own.z);
      if (e.powered === false) {
        if (d < unpoweredD) { unpoweredD = d; unpowered = e; }
        const need = S.config.equipment && S.config.equipment[e.itemId] && S.config.equipment[e.itemId].needs;
        if (carrying && need === carrying && d < carryRackD) { carryRackD = d; carryRack = e; }
      } else if (e.available !== false) { if (d < rackNearD) { rackNearD = d; rackNear = e; } }
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
      // parts and doors
      let extra = '';
      const PI2 = PART_INFO;
      const missing = mower && mower.parts !== undefined ? ['battery', 'gas', 'plug'].filter((k, i) => !(num(mower.parts, 0) & (1 << i))) : [];
      if (carrying) {
        if (mower && mower.state !== 'destroyed' && missing.includes(carrying) && dm <= num(S.config.mowerUseRange, 2.5) + 0.3) extra = `Press E to put the ${PI2[carrying].name} in the mower!`;
        else if (carryRack && carryRackD <= rackRange) extra = `Press E to put the ${PI2[carrying].name} in the ${itemInfo(carryRack.itemId).name}!`;
      } else if (!held) {
        if (partNear && partNearD <= num(S.config.parts && S.config.parts.pickRange, 1.8) + 0.4) extra = `Press E to pick up the ${PI2[partNear.partKind]?.name || 'part'}!`;
        else if (unpowered && unpoweredD <= rackRange + 0.8) {
          const need = S.config.equipment && S.config.equipment[unpowered.itemId] && S.config.equipment[unpowered.itemId].needs;
          extra = `The ${itemInfo(unpowered.itemId).name} needs a ${PI2[need]?.name || 'part'} first! Search the garage, basement, shed and yard`;
        } else if (mower && mower.state === 'idle' && dm < 3.6 && missing.length) extra = `The mower needs: ${missing.map((k) => PI2[k].icon + ' ' + PI2[k].name).join(', ')}`;
      }
      if (!extra && !held && S.map) {
        for (const d of S.map.doors.values()) {
          if (!d.alive) continue;
          const dd = Math.hypot((d.def.minX + d.def.maxX) / 2 - own.x, (d.def.minZ + d.def.maxZ) / 2 - own.z);
          if (dd < 7) { extra = 'Shoot the door down to get in!'; break; }
        }
      }
      if (!extra && fr && num(fr.n, 0) > 0 && S.config.map) {
        const f = S.config.map.fridge;
        if (Math.hypot(f.x - own.x, f.z - own.z) < f.radius + 0.6) extra = 'The fridge! Stay close and the snack bar keeps filling!';
      }
      if (drivingMine) prompt = mowerPrompt;
      else if (extra) prompt = extra;
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
      const slot = nearestEmptySlot(entities, own.x, own.z);
      const sun = num(own.sunshine, 0);
      const mine = unlockedPlants(S.config, num(own.tier, 0));
      const cheapest = mine.reduce((m, p) => Math.min(m, p.cost), Infinity);
      // a plant you are looking at (or standing by, with no empty spot around) can be levelled up with U
      const up = pickUpgradeTarget(entities, { x: own.x, z: own.z, yaw: input.yaw }, S.config);
      const wantUp = up && (up.looked || !slot);
      if (wantUp) {
        const g = up.plant;
        world.showSlot(g.x, g.z, true);
        prompt = upgradePrompt(S.config, g, sun);
      } else if (slot) {
        nearSlotInfo = slot;
        const ok = sun >= cheapest;
        world.showSlot(slot.x, slot.z, ok);
        prompt = ok
          ? (mine.length > 2 ? `Press 1-${mine.length} to plant here!` : 'Press 1 or 2 to plant here!')
          : `Planting needs ☀️ ${cheapest} — grab some sunshine!`;
      }
    }
  }
  hud.setPrompt(prompt);
  S.nearSlot = nearSlotInfo;

  // doors left standing and the mower's parts (HUD)
  let doorsAlive = 0;
  if (S.map) for (const d of S.map.doors.values()) if (d.alive) doorsAlive++;
  const partsHud = { mask: mower ? num(mower.parts, 0) : 0, carry: typeof own.carry === 'string' && PART_INFO[own.carry] ? { kind: own.carry, text: `Carrying: ${PART_INFO[own.carry].icon} ${PART_INFO[own.carry].name} \u2014 press E at a hook or the mower` } : null };
  hud.update({ own, snap, config: S.config, now: nowMs, locked: input.locked || input.menuOpen, nearSlot: nearSlotInfo, mower: mowerHud, doors: { alive: doorsAlive, total: S.map ? S.map.doors.size : 4 }, parts: partsHud });

  // building: the wheel, or the ghost
  if (B.active && (!alive || !playing)) buildCancel();
  else if (B.active && S.map) {
    if (!B.kind) {
      hud.setBuildWheel(buildWheelItems(team, own), 0, isTouch() ? 'Tap one' : 'Pick 1-' + buildWheelItems(team, own).length + ' \u2022 B closes');
      hud.setBuildBar('', '');
      world.cover.setGhost(null);
    } else {
      hud.setBuildWheel(null);
      buildFrame(own, entities);
    }
  }

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
