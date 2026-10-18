// The player's display name: saved in localStorage, shared by the lobby page and the settings panel.
import { cleanName } from './text.js';

const KEY = 'bb-name';
const NAMES = ['Sunny', 'Sprout', 'Zippy', 'Pickle', 'Bean', 'Daisy', 'Waffles', 'Turbo', 'Mango', 'Pip'];

function load() {
  try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; }
}

class Profile {
  constructor() {
    this._subs = new Set();
    const saved = load();
    this.name = saved ? cleanName(saved) : NAMES[(Math.random() * NAMES.length) | 0];
  }

  /** Clean, remember and announce a new name. Returns the name actually used. */
  set(raw) {
    const name = cleanName(raw);
    const changed = name !== this.name;
    this.name = name;
    try { localStorage.setItem(KEY, name); } catch (_) { /* private mode: keep it in memory */ }
    if (changed) for (const fn of this._subs) fn(name);
    return name;
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
}

export const profile = new Profile();
