// Touch controls for phones and tablets (landscape). Everything lives here + touch.css; the rest of the
// client only needs `new TouchControls(input, hud)` and the isTouch() pixel-ratio hint.
//
//   left thumb   floating joystick -> keys f/b/l/r (digital, 8-way, dead zone)
//   right side   drag anywhere to look (settings invert + speed apply; touches have their own base multiplier)
//   FIRE         hold to shoot; sliding the thumb while holding it still steers the view
//   JUMP / USE (E) / DROP (Q, only while carrying a tool) / UPGRADE (U, only next to a garden plant you can level up)
//   seed cards (one per unlocked plant, the bar scrolls sideways) plant that plant (plant team)
//
// Touch events with identifiers are used (not Pointer Events) so multi-touch behaves the same on iOS Safari and
// Android Chrome. Every game touch is preventDefault()ed: no scrolling, zoom, long-press menus or mouse emulation.
import { settings } from './settings.js';
import { applyLook } from './input.js';
import { plantList } from './plants.js';

export const TOUCH_LOOK_MULT = 2.2; // touch drags are this many times a mouse pixel (before the user's speed setting)
export const STICK_DEADZONE = 0.3; // fraction of the stick radius that is ignored
export const STICK_AXIS = 0.38; // |component| of the stick direction needed to press that key (8-way sectors)
export const SEED_TAP_SLOP = 10; // px a finger may wander on a seed card and still count as a tap
export const SEED_TAP_MS = 600; // ... and how long it may stay down
export const MIN_HOLD_MS = 110; // a tap is held at least this long so it spans a 30 Hz input message
const LOOK_JUMP_MAX = 500; // ignore absurd single-event jumps (glitchy touch screens)

/** Phone / tablet whose main pointer is a finger. Desktop (mouse) stays on the original controls. */
export function isTouch() {
  try {
    return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  } catch (_) {
    return false;
  }
}

/** Joystick offset (px from its centre) -> movement keys. Below the dead zone nothing is pressed. */
export function stickKeys(dx, dy, radius, dead = STICK_DEADZONE) {
  const out = { f: false, b: false, l: false, r: false };
  const len = Math.hypot(dx, dy);
  if (!(radius > 0) || !(len > 0) || len / radius < dead) return out;
  const nx = dx / len, ny = dy / len;
  out.f = ny < -STICK_AXIS;
  out.b = ny > STICK_AXIS;
  out.l = nx < -STICK_AXIS;
  out.r = nx > STICK_AXIS;
  return out;
}

/** A touch drag (CSS px) as look angles: the mouse maths with the touch multiplier on top. */
export function touchLook(yaw, pitch, dx, dy, look) {
  return applyLook(yaw, pitch, dx * TOUCH_LOOK_MULT, dy * TOUCH_LOOK_MULT, look);
}

/** Rewrite keyboard hints ("Press E", "press 1-3 to plant", "Press U") into touch wording. */
export function mobilize(text) {
  if (typeof text !== 'string' || !text) return text;
  const tap = (w) => (w[0] === 'P' ? 'Tap' : 'tap');
  return text
    .replace(/\b(press|tap) 1(?: or |-)[2-9] to plant\b/gi, (_, w) => `${tap(w)} a seed card to plant`)
    .replace(/\b(press) ([1-9]) to plant\b/gi, (_, w, n) => `${tap(w)} ${plantList(null)[n - 1].icon} to plant`)
    .replace(/\b([Pp]ress) U\b/g, (_, w) => `${tap(w)} UPGRADE`)
    .replace(/\b([Pp]ress) B\b/g, (_, w) => `${tap(w)} BUILD`)
    .replace(/\b([Pp]ress) E\b/g, (_, w) => `${tap(w)} USE`)
    .replace(/\b([Pp]ress) Q\b/g, (_, w) => `${tap(w)} DROP`)
    .replace(/\bE\b/g, 'USE')
    .replace(/\bQ\b/g, 'DROP');
}

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// Browsers refuse (and log a console error for) cancelling touches that are already non-cancelable.
const stop = (e) => { if (e.cancelable) e.preventDefault(); };

const UI_HTML = `
  <div id="tc-move" class="tc-zone"></div>
  <div id="tc-look" class="tc-zone"></div>
  <div id="tc-rest"><span>MOVE</span></div>
  <div id="tc-lookhint"><span>LOOK</span></div>
  <div id="tc-stick"><i id="tc-knob"></i></div>
  <div id="tc-fire" class="tc-btn" data-act="fire"><b>&#128165;</b><span>FIRE</span></div>
  <div id="tc-jump" class="tc-btn" data-act="jump"><b>&#11014;&#65039;</b><span>JUMP</span></div>
  <div id="tc-use" class="tc-btn small hidden" data-act="use"><b>&#9995;</b><span>USE</span></div>
  <div id="tc-drop" class="tc-btn small hidden" data-act="drop"><b>&#11015;&#65039;</b><span>DROP</span></div>
  <div id="tc-up" class="tc-btn small hidden" data-act="upgrade"><b>&#11088;</b><span>UPGRADE</span></div>
  <div id="tc-build" class="tc-btn small" data-tap="build"><b>&#129521;</b><span>BUILD</span></div>
  <div id="tc-place" class="tc-btn small hidden" data-tap="place"><b>&#9989;</b><span>PLACE</span></div>
  <div id="tc-rotate" class="tc-btn small hidden" data-tap="rotate"><b>&#128260;</b><span>TURN</span></div>
  <div id="tc-cancel" class="tc-btn small hidden" data-tap="cancel"><b>&#10006;&#65039;</b><span>BACK</span></div>
`;

export class TouchControls {
  /** @param input the game's Input  @param hud the game's HUD (its prompt/toast text and update() are wrapped) */
  constructor(input, hud) {
    this.input = input;
    this.hud = hud;
    this.active = false;
    this.ui = null;
    this.touches = new Map(); // touch id -> { kind: 'move' | 'look' | 'btn', act?, x, y }
    this.stick = null; // { id, ox, oy, r, ex, ey }
    this.holds = {}; // act -> { ids: Set, t0, timer, el }
    this.prompt = '';
    this._shown = { use: null, drop: null, up: null, attn: null, upattn: null, build: null, place: null, rotate: null, cancel: null };
    this.wake = null;

    if (isTouch()) this.enable();
    else if (typeof window !== 'undefined') {
      // Fallback for browsers that don't report a coarse pointer: the first real touch switches the controls on.
      window.addEventListener('touchstart', () => {
        let fine = false;
        try { fine = window.matchMedia('(pointer: fine)').matches; } catch (_) { /* unsupported: assume touch-only */ }
        if (!fine) this.enable();
      }, { once: true, passive: true });
    }
  }

  enable() {
    if (this.active) return;
    this.active = true;
    document.documentElement.classList.add('touch');
    this.input.touch = true;
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.input.enabled && !this.input.menuOpen) this.input.requestLock(); // switched on mid-round
    this._build();
    this._wrapHud();
    this._retext();
    this._bindPage();
    window.__bbTouch = this; // test / console handle
  }

  /* ---------------------------------------------------------------- DOM */

  _build() {
    const ui = document.createElement('div');
    ui.id = 'touchui';
    ui.innerHTML = UI_HTML;
    const hudRoot = $('hud') || document.body;
    hudRoot.appendChild(ui);
    this.ui = ui;
    this.el = {
      stick: $('tc-stick'), knob: $('tc-knob'), rest: $('tc-rest'),
      fire: $('tc-fire'), jump: $('tc-jump'), use: $('tc-use'), drop: $('tc-drop'), upgrade: $('tc-up'),
      build: $('tc-build'), place: $('tc-place'), rotate: $('tc-rotate'), cancel: $('tc-cancel'),
    };
    for (const act of ['fire', 'jump', 'use', 'drop', 'upgrade']) this.holds[act] = { ids: new Set(), t0: 0, timer: 0, el: this.el[act] };

    const opts = { passive: false };
    ui.addEventListener('touchstart', (e) => this._onStart(e), opts);
    ui.addEventListener('touchmove', (e) => this._onMove(e), opts);
    ui.addEventListener('touchend', (e) => this._onEnd(e), opts);
    ui.addEventListener('touchcancel', (e) => this._onEnd(e), opts);
    ui.addEventListener('contextmenu', (e) => e.preventDefault());

    // seed cards double as the plant buttons (they already show cost + whether you can afford it). The bar scrolls
    // sideways, so a card plants on touchend when the finger barely moved; a drag just scrolls.
    const bar = $('seedcards');
    if (bar) {
      let tap = null;
      bar.addEventListener('touchstart', (e) => {
        const t = e.changedTouches[0];
        const card = t && t.target && t.target.closest ? t.target.closest('.seed') : null;
        tap = card ? { id: t.identifier, n: Number(card.dataset.n), x: t.clientX, y: t.clientY, t0: performance.now(), moved: false } : null;
      }, { passive: true });
      bar.addEventListener('touchmove', (e) => {
        if (!tap) return;
        for (const t of e.changedTouches) if (t.identifier === tap.id && Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > SEED_TAP_SLOP) tap.moved = true;
      }, { passive: true });
      bar.addEventListener('touchend', (e) => {
        for (const t of e.changedTouches) {
          if (!tap || t.identifier !== tap.id) continue;
          const ok = !tap.moved && performance.now() - tap.t0 < SEED_TAP_MS;
          const n = tap.n;
          tap = null;
          stop(e); // no synthetic mouse events / zoom after a tap
          if (ok && n >= 1 && this._live()) this.input._plant(n);
        }
      }, { passive: false });
      bar.addEventListener('touchcancel', () => { tap = null; }, { passive: true });
    }

    // rotate hint (portrait)
    const rh = document.createElement('div');
    rh.id = 'rotate-hint';
    rh.innerHTML = '<div class="rh-phone">&#128241;</div><div class="rh-title">Turn your device sideways!</div>'
      + '<div class="rh-sub">Backyard Battle plays best in landscape.</div><button type="button" class="rh-skip">Play anyway</button>';
    rh.querySelector('.rh-skip').addEventListener('click', () => rh.classList.add('dismissed'));
    document.body.appendChild(rh);

    this._resize();
    window.addEventListener('resize', () => this._resize());
    window.addEventListener('orientationchange', () => this._resetAll());
  }

  _resize() {
    const r = clamp(Math.min(window.innerWidth, window.innerHeight) * 0.14, 36, 64);
    this.radius = r;
    if (this.ui) this.ui.style.setProperty('--tc-r', r + 'px');
    if (window.innerHeight > window.innerWidth) this._resetAll(); // portrait: the rotate hint covers the controls
  }

  /** Page-level guards: no scrolling, zoom or gesture side effects while playing. */
  _bindPage() {
    document.addEventListener('touchmove', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('#lobby, #settings, #rotate-hint, #seedcards')) return; // those scroll normally
      stop(e);
    }, { passive: false });
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, stop);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._resetAll();
      else if (this.input.enabled) this._keepAwake();
    });
    window.addEventListener('blur', () => this._resetAll());

    // fullscreen + landscape lock + screen wake lock, all from a Join / Create / Start tap (a user gesture)
    document.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-play]')) this._onPlay();
    });
  }

  _onPlay() {
    this._fullscreen();
    this._keepAwake();
  }

  _fullscreen() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req || document.fullscreenElement || document.webkitFullscreenElement) return;
    try {
      const p = req.call(el, { navigationUI: 'hide' });
      const lock = () => {
        try {
          const o = screen.orientation;
          const q = o && o.lock && o.lock('landscape');
          if (q && q.catch) q.catch(() => {});
        } catch (_) { /* not supported / not allowed */ }
      };
      if (p && p.then) p.then(lock, () => {});
      else lock();
    } catch (_) { /* iPhone Safari has no fullscreen API: nothing to do */ }
  }

  async _keepAwake() {
    try {
      if (!navigator.wakeLock || this.wake) return;
      const s = await navigator.wakeLock.request('screen');
      this.wake = s;
      s.addEventListener('release', () => { if (this.wake === s) this.wake = null; });
    } catch (_) { /* denied or unsupported */ }
  }

  /** Mouse/keyboard wording in the lobby + settings panel -> touch wording. */
  _retext() {
    const setFirstText = (el, text) => {
      if (!el) return;
      const n = [...el.childNodes].find((c) => c.nodeType === 3 && c.nodeValue.trim());
      if (n) n.nodeValue = text;
      else el.prepend(text);
    };
    const row = (id) => { const e = $(id); return e && e.closest('.setrow'); };
    const name = (id) => { const r = row(id); return r && r.querySelector('.setname'); };
    const desc = (id) => { const n = name(id); return n && n.querySelector('.setds'); };
    setFirstText(name('set-sens'), 'Look speed');
    const sens = $('set-sens');
    if (sens) sens.setAttribute('aria-label', 'Look speed');
    const d1 = desc('set-invy'); if (d1) d1.textContent = 'Drag up to look down';
    const d2 = desc('set-invx'); if (d2) d2.textContent = 'Drag right to turn left';
    for (const f of document.querySelectorAll('#settings .fine')) f.textContent = 'Changes happen right away and are saved on this device.';
  }

  /** Keyboard hints in HUD text become touch hints, and the HUD tells us what the player is holding. */
  _wrapHud() {
    const hud = this.hud;
    if (!hud) return;
    const setPrompt = hud.setPrompt.bind(hud);
    hud.setPrompt = (t) => { this.prompt = typeof t === 'string' ? t : ''; setPrompt(mobilize(t)); };
    const toast = hud.toast.bind(hud);
    hud.toast = (t, ...rest) => toast(mobilize(t), ...rest);
    const update = hud.update.bind(hud);
    hud.update = (ctx) => { update(ctx); this._sync(ctx); };
  }

  _toggle(key, el, show) {
    if (this._shown[key] === show) return;
    this._shown[key] = show;
    el.classList.toggle('hidden', !show);
  }

  _sync(ctx) {
    const own = ctx && ctx.own;
    if (!own) {
      if (this.touches.size) this._resetAll();
      return;
    }
    const carrying = typeof own.item === 'string' && own.item !== '';
    const wantsUse = own.team === 'zombie' || /\bE\b/.test(this.prompt);
    this._toggle('use', this.el.use, wantsUse);
    this._toggle('drop', this.el.drop, carrying);
    const attn = /\bE\b/.test(this.prompt);
    if (this._shown.attn !== attn) {
      this._shown.attn = attn;
      this.el.use.classList.toggle('attn', attn);
    }
    // plant kids: the UPGRADE button shows while the prompt offers an affordable level-up ("Press U to upgrade ...")
    // build: the BUILD button is always there; once a build is picked PLACE / TURN appear, BACK while the wheel or a build is up
    const building = !!this.input.buildActive;
    this._toggle('build', this.el.build, !building);
    this._toggle('place', this.el.place, building && !!this.input.buildKind);
    this._toggle('rotate', this.el.rotate, building && !!this.input.buildKind);
    this._toggle('cancel', this.el.cancel, building);
    const wantsUp = own.team === 'plant' && /\bPress U\b/.test(this.prompt);
    this._toggle('up', this.el.upgrade, wantsUp);
    if (this._shown.upattn !== wantsUp) {
      this._shown.upattn = wantsUp;
      this.el.upgrade.classList.toggle('attn', wantsUp);
    }
  }

  /* -------------------------------------------------------------- touches */

  _live() {
    return this.active && this.input.enabled && !this.input.menuOpen && window.innerWidth >= window.innerHeight * 0.9;
  }

  /** Forget touches that ended without us hearing about it (e.g. the HUD was hidden under the finger). */
  _prune(e) {
    const alive = new Set();
    for (const t of e.touches) alive.add(t.identifier);
    for (const id of [...this.touches.keys()]) {
      if (alive.has(id)) continue;
      this._release(id);
    }
  }

  _onStart(e) {
    stop(e);
    this._prune(e);
    if (!this._live()) return;
    for (const t of e.changedTouches) {
      const tgt = t.target && t.target.closest ? t.target.closest('[data-act], [data-tap], .tc-zone') : null;
      if (!tgt) continue;
      if (this.input.buildActive && !this.input.buildKind && !tgt.dataset.tap) {
        // the build wheel is up: a finger on one of its buttons picks it (the look zone is on top of the wheel)
        const hit = document.elementsFromPoint(t.clientX, t.clientY).find((n) => n.classList && n.classList.contains('bw-item'));
        if (hit && this.input.onBuildPick) {
          this.input.onBuildPick(Number(hit.dataset.n));
          continue;
        }
      }
      if (tgt.dataset.tap) this._tap(tgt.dataset.tap, tgt);
      else if (tgt.dataset.act) this._press(tgt.dataset.act, t);
      else if (tgt.id === 'tc-move') this._stickStart(t);
      else this.touches.set(t.identifier, { kind: 'look', x: t.clientX, y: t.clientY });
    }
  }

  _onMove(e) {
    stop(e);
    for (const t of e.changedTouches) {
      const info = this.touches.get(t.identifier);
      if (!info) continue;
      if (info.kind === 'move') this._stickMove(t);
      else if (info.kind === 'look' || info.act === 'fire') this._lookMove(info, t);
    }
  }

  _onEnd(e) {
    stop(e);
    for (const t of e.changedTouches) this._release(t.identifier);
  }

  _release(id) {
    const info = this.touches.get(id);
    if (!info) return;
    this.touches.delete(id);
    if (info.kind === 'move') this._stickEnd();
    else if (info.kind === 'btn') this._unpress(info.act, id);
  }

  /* ---- joystick */

  _stickStart(t) {
    if (this.stick) return;
    const rect = this.ui.getBoundingClientRect();
    this.stick = { id: t.identifier, ox: t.clientX, oy: t.clientY, r: this.radius, ex: rect.left, ey: rect.top };
    this.touches.set(t.identifier, { kind: 'move' });
    this.el.stick.classList.add('on');
    this.el.rest.classList.add('off');
    this._drawStick(0, 0);
  }

  _stickMove(t) {
    const s = this.stick;
    if (!s || s.id !== t.identifier) return;
    let dx = t.clientX - s.ox, dy = t.clientY - s.oy;
    const len = Math.hypot(dx, dy);
    if (len > s.r) {
      // the base follows the thumb so reversing direction never needs more than one radius of travel
      const k = (len - s.r) / len;
      s.ox += dx * k;
      s.oy += dy * k;
      dx = t.clientX - s.ox;
      dy = t.clientY - s.oy;
    }
    this._drawStick(dx, dy);
    if (!this._live()) return;
    const keys = stickKeys(dx, dy, s.r);
    const k = this.input.keys;
    k.f = keys.f; k.b = keys.b; k.l = keys.l; k.r = keys.r;
  }

  _stickEnd() {
    this.stick = null;
    this.el.stick.classList.remove('on');
    this.el.rest.classList.remove('off');
    const k = this.input.keys;
    k.f = k.b = k.l = k.r = false;
  }

  _drawStick(dx, dy) {
    const s = this.stick;
    if (!s) return;
    this.el.stick.style.transform = `translate3d(${s.ox - s.ex}px, ${s.oy - s.ey}px, 0)`;
    this.el.knob.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  }

  /* ---- look */

  _lookMove(info, t) {
    const dx = t.clientX - info.x, dy = t.clientY - info.y;
    info.x = t.clientX;
    info.y = t.clientY;
    if (!this._live() || Math.abs(dx) > LOOK_JUMP_MAX || Math.abs(dy) > LOOK_JUMP_MAX) return;
    const inp = this.input;
    const a = touchLook(inp.yaw, inp.pitch, dx, dy, settings.values);
    inp.yaw = a.yaw;
    inp.pitch = a.pitch;
    inp.lookMoved = true;
  }

  /* ---- buttons */

  /** One-shot buttons (build, place, turn, back): they act on touch start. */
  _tap(name, el) {
    const inp = this.input;
    if (name === 'build' || name === 'cancel') { if (inp.onBuildToggle) inp.onBuildToggle(); }
    else if (name === 'place') { if (inp.onBuildPlace) inp.onBuildPlace(); }
    else if (name === 'rotate') { if (inp.onBuildRotate) inp.onBuildRotate(); }
    el.classList.add('down');
    setTimeout(() => el.classList.remove('down'), 140);
  }

  _setAct(act, v) {
    const inp = this.input;
    if (act === 'fire') inp.fire = v;
    else if (act === 'jump') inp.keys.jump = v;
    else if (act === 'use') inp.use = v;
    else if (act === 'drop') inp.drop = v;
    else if (act === 'upgrade') inp.upgrade = v;
  }

  _press(act, t) {
    const h = this.holds[act];
    if (!h) return;
    this.touches.set(t.identifier, { kind: 'btn', act, x: t.clientX, y: t.clientY });
    clearTimeout(h.timer);
    h.timer = 0;
    if (h.ids.size === 0) {
      h.t0 = performance.now();
      this._setAct(act, true);
      h.el.classList.add('down');
    }
    h.ids.add(t.identifier);
  }

  _unpress(act, id) {
    const h = this.holds[act];
    if (!h) return;
    h.ids.delete(id);
    if (h.ids.size) return;
    const wait = Math.max(0, MIN_HOLD_MS - (performance.now() - h.t0));
    const done = () => {
      h.timer = 0;
      if (h.ids.size) return;
      this._setAct(act, false);
      h.el.classList.remove('down');
    };
    if (wait > 0) h.timer = setTimeout(done, wait);
    else done();
  }

  /** Let go of everything (menu opened, app backgrounded, rotated, round over...). */
  _resetAll() {
    if (!this.active) return;
    this.touches.clear();
    if (this.stick) this._stickEnd();
    for (const act of Object.keys(this.holds)) {
      const h = this.holds[act];
      clearTimeout(h.timer);
      h.timer = 0;
      h.ids.clear();
      h.el.classList.remove('down');
      this._setAct(act, false);
    }
    const k = this.input.keys;
    k.f = k.b = k.l = k.r = false;
  }
}
