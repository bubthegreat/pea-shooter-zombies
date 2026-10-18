// Landing screen: name, team, mode, difficulty and a big Play! button.
const $ = (id) => document.getElementById(id);

import { profile } from './profile.js';

function store(get, key, val) {
  try {
    if (get) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch (_) { /* ignore */ }
  return null;
}

export class Lobby {
  constructor() {
    this.root = $('lobby');
    this.nameEl = $('name');
    this.playEl = $('play');
    this.statusEl = $('status');
    this.onPlay = null;
    this.choice = {
      team: store(true, 'bb-team') === 'zombie' ? 'zombie' : 'plant',
      mode: store(true, 'bb-mode') === 'versus' ? 'versus' : 'coop',
      diff: store(true, 'bb-diff') === 'normal' ? 'normal' : 'easy',
    };
    this.nameEl.value = profile.name;
    this.nameEl.addEventListener('change', () => { this.nameEl.value = profile.set(this.nameEl.value); });
    profile.subscribe((n) => { if (document.activeElement !== this.nameEl) this.nameEl.value = n; });

    const bind = (rowId, attr, key) => {
      const row = $(rowId);
      const sync = () => {
        for (const b of row.querySelectorAll('.choice')) b.classList.toggle('selected', b.dataset[attr] === this.choice[key]);
      };
      sync();
      row.addEventListener('click', (e) => {
        const b = e.target.closest('.choice');
        if (!b) return;
        this.choice[key] = b.dataset[attr];
        sync();
        if (this.onClick) this.onClick();
      });
    };
    bind('teamrow', 'team', 'team');
    bind('moderow', 'mode', 'mode');
    bind('diffrow', 'diff', 'diff');

    this.playEl.addEventListener('click', () => this._play());
    this.nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.playEl.disabled) this._play();
      e.stopPropagation();
    });
    this.nameEl.addEventListener('keyup', (e) => e.stopPropagation());
  }

  _play() {
    const name = profile.set(this.nameEl.value);
    this.nameEl.value = name;
    store(false, 'bb-team', this.choice.team);
    store(false, 'bb-mode', this.choice.mode);
    store(false, 'bb-diff', this.choice.diff);
    if (this.onPlay) this.onPlay({ name, team: this.choice.team, mode: this.choice.mode, difficulty: this.choice.diff });
  }

  setStatus(text, bad = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('bad', bad);
  }

  setReady(ready) {
    this.playEl.disabled = !ready;
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }
  get visible() { return !this.root.classList.contains('hidden'); }
}
