// Keyboard + mouse (pointer lock). Look angles are applied locally and immediately; the
// server just receives them 30 times a second.
//
//   W A S / arrows  move      Space  jump      mouse  look      left click  fire
//   E  use (hold: start the mower; tap: grab garage equipment / hop off the mower)
//   Q  put the equipment you are holding down (sent as `drop`; the server edge-detects it)
//   1-9  plant the nth unlocked plant (seed bar)     U  upgrade the garden plant you are next to (sent as `upgrade`)
//   B  build wheel (1-5 pick, click places, R turns, scroll cycles, B / Esc cancel)
//   M  mute     H  help     O  look settings (invert, mouse speed)

import { settings } from './settings.js';

const SENS = 0.0023;
const PITCH_LIMIT = 1.4;

/**
 * Apply one mouse movement (dx, dy in pixels) to the look angles. `look` is the settings
 * object: invertX flips left/right, invertY flips up/down, sens scales the speed.
 * Pitch stays clamped; yaw wraps to [-PI, PI].
 */
export function applyLook(yaw, pitch, dx, dy, look) {
  const k = SENS * look.sens;
  yaw -= (look.invertX ? -dx : dx) * k; // default: mouse right -> turn right (negative yaw)
  pitch -= (look.invertY ? -dy : dy) * k; // default: mouse up -> look up
  pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  if (yaw > Math.PI) yaw -= Math.PI * 2;
  else if (yaw < -Math.PI) yaw += Math.PI * 2;
  return { yaw, pitch };
}

/**
 * Planting presses, sent with a running counter. Every press gets the next plantSeq and its own
 * outgoing message (plant = kind, plantSeq = n), so rapid repeated presses of the same key are never
 * merged; between presses we send plant 0 with the last number. A press is only dequeued once a
 * message carrying it was actually handed to the socket.
 */
export class PlantSender {
  constructor(maxQueued = 6) {
    this.maxQueued = maxQueued;
    this.queue = []; // { seq, kind }
    this.seq = 0; // presses so far
    this.sent = 0; // highest seq handed to the socket
  }

  press(kind) {
    this.queue.push({ seq: ++this.seq, kind });
    if (this.queue.length > this.maxQueued) this.queue.shift();
  }

  /** Fields for the next input message. */
  fields() {
    const next = this.queue[0];
    return next ? { plant: next.kind, plantSeq: next.seq } : { plant: 0, plantSeq: this.sent };
  }

  /** Call after the message built from fields() was really sent. */
  commit(fields) {
    if (fields.plant && this.queue[0] && this.queue[0].seq === fields.plantSeq) {
      this.sent = fields.plantSeq;
      this.queue.shift();
    }
  }
}

/**
 * Build presses, sent like planting: every press gets the next buildSeq and its own message
 * (build = kind, bx / bz = grid cell, br = rotated); between presses build 0 with the last number.
 */
export class BuildSender {
  constructor(maxQueued = 4) {
    this.maxQueued = maxQueued;
    this.queue = []; // { seq, kind, bx, bz, br }
    this.seq = 0;
    this.sent = 0;
  }

  press(kind, bx, bz, br = 0) {
    this.queue.push({ seq: ++this.seq, kind, bx, bz, br: br ? 1 : 0 });
    if (this.queue.length > this.maxQueued) this.queue.shift();
  }

  fields() {
    const n = this.queue[0];
    return n ? { build: n.kind, bx: n.bx, bz: n.bz, br: n.br, buildSeq: n.seq } : { build: 0, buildSeq: this.sent };
  }

  commit(fields) {
    if (fields.build && this.queue[0] && this.queue[0].seq === fields.buildSeq) {
      this.sent = fields.buildSeq;
      this.queue.shift();
    }
  }
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.enabled = false; // true while in a round (so typing in the lobby isn't captured)
    this.locked = false;
    this.touch = false; // phone/tablet: touch.js drives the input, there is no pointer lock
    this.menuOpen = false; // settings panel is up: ignore game keys
    this.yaw = 0;
    this.pitch = 0;
    this.keys = { f: false, b: false, l: false, r: false, jump: false };
    this.fire = false;
    this.use = false;
    this.drop = false;
    this.upgrade = false;
    this._usePending = false; // a tap shorter than one send interval still reaches the server as one message
    this._dropPending = false;
    this._upgradePending = false;
    this.planter = new PlantSender();
    this.builder = new BuildSender();
    this.buildActive = false; // the build wheel is open or a build is selected: digits pick builds, click places
    this.buildKind = 0;
    this.onBuildToggle = null;
    this.onBuildPick = null;
    this.onBuildPlace = null;
    this.onBuildRotate = null;
    this.onBuildScroll = null;
    this.seq = 0;
    this.onToggleMute = null;
    this.onToggleHelp = null;
    this.onLockChange = null;
    this.onPlantKey = null;
    this.lookMoved = false;
    this._sendTimer = null;

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this._releaseAll();
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const dx = e.movementX || 0, dy = e.movementY || 0;
      if (Math.abs(dx) > 600 || Math.abs(dy) > 600) return; // browsers occasionally glitch
      const a = applyLook(this.yaw, this.pitch, dx, dy, settings.values);
      this.yaw = a.yaw;
      this.pitch = a.pitch;
      this.lookMoved = true;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked) {
        this.requestLock();
        return;
      }
      if (e.button === 0 && this.buildActive) {
        if (this.buildKind && this.onBuildPlace) this.onBuildPlace(); // building: the click places instead of shooting
      } else if (e.button === 0) this.fire = true;
      e.preventDefault();
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled || !this.buildActive || !this.onBuildScroll) return;
      this.onBuildScroll(e.deltaY > 0 ? 1 : -1);
      e.preventDefault();
    }, { passive: false });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => this._releaseAll());
    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
  }

  requestLock() {
    if (this.touch) return this._touchLock(true);
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (_) { /* ignore */ }
  }

  exitLock() {
    if (this.touch) return this._touchLock(false);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Touch has no pointer lock: "locked" just means the touch controls are live (in a round, no menu). */
  _touchLock(on) {
    if (this.locked === on) return;
    this.locked = on;
    if (!on) this._releaseAll();
    if (this.onLockChange) this.onLockChange(on);
  }

  /** The settings panel needs the real mouse and shouldn't leak keys into the game. */
  setMenuOpen(open) {
    this.menuOpen = open;
    if (open) {
      this._releaseAll();
      this.exitLock();
    }
  }

  _releaseAll() {
    const k = this.keys;
    k.f = k.b = k.l = k.r = k.jump = false;
    this.fire = false;
    this.use = false;
    this.drop = false;
    this.upgrade = false;
    this._usePending = this._dropPending = this._upgradePending = false;
  }

  _key(e, down) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' && e.code === 'Space') return;
    if (down && !e.repeat) {
      if (e.code === 'KeyM' && this.onToggleMute) this.onToggleMute();
      if (e.code === 'KeyH' && this.onToggleHelp && this.enabled && !this.menuOpen) this.onToggleHelp();
    }
    if (!this.enabled || this.menuOpen) return;
    const k = this.keys;
    let handled = true;
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': k.f = down; break;
      case 'KeyS': case 'ArrowDown': k.b = down; break;
      case 'KeyA': case 'ArrowLeft': k.l = down; break;
      case 'KeyD': case 'ArrowRight': k.r = down; break;
      case 'Space': k.jump = down; break;
      case 'KeyE': this.use = down; if (down) this._usePending = true; break;
      case 'KeyQ': this.drop = down; if (down) this._dropPending = true; break;
      case 'KeyU': this.upgrade = down; if (down) this._upgradePending = true; break;
      case 'KeyB': if (down && !e.repeat && this.onBuildToggle) this.onBuildToggle(); break;
      case 'KeyR':
        if (this.buildActive && this.buildKind) {
          if (down && !e.repeat && this.onBuildRotate) this.onBuildRotate();
        } else handled = false;
        break;
      default: {
        const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
        if (m) {
          if (down && !e.repeat) {
            if (this.buildActive && this.onBuildPick) this.onBuildPick(Number(m[1]));
            else this._plant(Number(m[1]));
          }
        } else handled = false;
      }
    }
    if (handled) e.preventDefault();
  }

  _plant(n) {
    this.planter.press(n);
    if (this.onPlantKey) this.onPlantKey(n);
  }

  /** Build the protocol input message. */
  message() {
    const k = this.keys;
    return {
      t: 'input',
      seq: ++this.seq,
      keys: { f: k.f, b: k.b, l: k.l, r: k.r, jump: k.jump },
      yaw: this.yaw,
      pitch: this.pitch,
      fire: this.fire,
      use: this.use || this._usePending,
      drop: this.drop || this._dropPending,
      upgrade: this.upgrade || this._upgradePending,
      ...this.planter.fields(),
      ...this.builder.fields(),
    };
  }

  /** Start sending at 30 Hz via send(msg). send returns false when the message could not go out. */
  startSending(send) {
    this.stopSending();
    this._sendTimer = setInterval(() => {
      const m = this.message();
      if (send(m) !== false) {
        this.planter.commit(m);
        this.builder.commit(m);
        if (!this.use) this._usePending = false;
        if (!this.drop) this._dropPending = false;
        if (!this.upgrade) this._upgradePending = false;
      }
    }, 1000 / 30);
  }

  stopSending() {
    if (this._sendTimer) clearInterval(this._sendTimer);
    this._sendTimer = null;
  }

  get moving() {
    const k = this.keys;
    return k.f || k.b || k.l || k.r;
  }
}
