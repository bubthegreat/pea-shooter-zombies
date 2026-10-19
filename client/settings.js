// Player settings (invert Y / X, mouse speed, graphics quality). Saved in localStorage; if storage is
// blocked or broken everything still works with the defaults. No DOM in here.

export const SENS_MIN = 0.25;
export const SENS_MAX = 3;
export const SENS_STEP = 0.05;
export const GFX = Object.freeze(['auto', 'high', 'low']);
// gfx: 'auto' picks Low on phones / tablets (a finger is the main pointer) and High elsewhere; High / Low are the player's choice.
export const DEFAULTS = Object.freeze({ invertX: false, invertY: false, sens: 1, gfx: 'auto' });

const KEY = 'bb-look';

/** Coerce anything (parsed JSON, a patch, undefined) into a valid settings object. */
export function sanitize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = typeof r.sens === 'number' && Number.isFinite(r.sens) ? r.sens : DEFAULTS.sens;
  return {
    invertX: r.invertX === true,
    invertY: r.invertY === true,
    sens: Math.round(Math.max(SENS_MIN, Math.min(SENS_MAX, s)) * 100) / 100,
    gfx: GFX.includes(r.gfx) ? r.gfx : DEFAULTS.gfx,
  };
}

/** 'high' or 'low' for these settings; `touch`: is a finger the main pointer (decides 'auto'). */
export function resolveGfx(values, touch) {
  const g = values && values.gfx;
  return g === 'high' || g === 'low' ? g : touch ? 'low' : 'high';
}

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

export class Settings {
  /** @param storage localStorage-like object, or null for none (default: the browser's). */
  constructor(storage = defaultStorage()) {
    this._storage = storage;
    this._subs = new Set();
    this.values = sanitize(null);
    try {
      const txt = this._storage && this._storage.getItem(KEY);
      if (txt) this.values = sanitize(JSON.parse(txt));
    } catch (_) { /* defaults */ }
  }

  /** Merge a patch ({invertX, invertY, sens, gfx}), apply immediately, save, and tell subscribers. */
  set(patch) {
    this.values = sanitize({ ...this.values, ...patch });
    try {
      if (this._storage) this._storage.setItem(KEY, JSON.stringify(this.values));
    } catch (_) { /* private mode / quota: keep the in-memory value */ }
    for (const fn of this._subs) fn(this.values);
  }

  reset() { this.set(DEFAULTS); }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
}

export const settings = new Settings();
