// Lobby screens: the browser (front page), the create form and the waiting room.
// Everything players type (names, lobby names) goes onto the page with textContent only, never as HTML.
import { profile } from './profile.js';
import { cleanLobbyName } from './text.js';
import { modeLabel, diffLabel, teamLabel, playersText, statusText, detailText, waitText, ruleText } from './lobbyview.js';

const $ = (id) => document.getElementById(id);
const ICON = { plant: String.fromCodePoint(0x1f33b), zombie: String.fromCodePoint(0x1f9df), crown: String.fromCodePoint(0x1f451) };

function store(get, key, val) {
  try {
    if (get) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch (_) { /* ignore */ }
  return null;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

export class Lobby {
  constructor() {
    this.root = $('lobby');
    this.screens = { browse: $('screen-browse'), create: $('screen-create'), room: $('screen-room') };
    this.statusEls = { browse: $('status'), create: $('create-status'), room: $('room-status') };
    this.screen = 'browse';
    this.connected = false;
    this.rows = new Map(); // lobby id -> { row, name, sub, stat, btn }
    this.list = [];
    this.room = null;
    this.you = null;
    this.choice = {
      team: store(true, 'bb-team') === 'zombie' ? 'zombie' : 'plant',
      mode: store(true, 'bb-mode') === 'versus' ? 'versus' : 'coop',
      diff: store(true, 'bb-diff') === 'normal' ? 'normal' : 'easy',
    };
    // callbacks wired by main.js
    this.onCreate = null; // ({ lobbyName, mode, difficulty })
    this.onJoin = null; // (lobbyId)
    this.onLeave = null; // ()
    this.onTeam = null; // (team)
    this.onStart = null; // ()
    this.onOptions = null; // ({ mode?, difficulty? })

    this.nameEl = $('name');
    this.nameEl.value = profile.name;
    this.nameEl.addEventListener('change', () => { this.nameEl.value = profile.set(this.nameEl.value); });
    profile.subscribe((n) => { if (document.activeElement !== this.nameEl) this.nameEl.value = n; });
    this.lobbyNameEl = $('lobbyname');
    for (const input of [this.nameEl, this.lobbyNameEl]) {
      // typing a name must not trigger game or settings hotkeys
      input.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
      input.addEventListener('keyup', (e) => e.stopPropagation());
    }
    this.nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.nameEl.blur(); });
    this.lobbyNameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._create(); });

    this.listEl = $('lobbylist');
    this.emptyEl = $('lobbyempty');
    this.countEl = $('lobbycount');
    this.createBtn = $('createbtn');
    this.createBtn.addEventListener('click', () => this.showCreate());
    $('create-back').addEventListener('click', () => this.showBrowse());
    $('create-go').addEventListener('click', () => this._create());
    $('leavebtn').addEventListener('click', () => { if (this.onLeave) this.onLeave(); });
    $('startgame').addEventListener('click', () => { if (this.onStart) this.onStart(); });
    this.listEl.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.joinbtn');
      if (b && !b.disabled && b.dataset.id && this.onJoin) this.onJoin(b.dataset.id);
    });

    this._group('teamrow', 'team', () => this.choice.team, (v) => { this.choice.team = v; store(false, 'bb-team', v); });
    this._group('createmoderow', 'mode', () => this.choice.mode, (v) => { this.choice.mode = v; store(false, 'bb-mode', v); });
    this._group('creatediffrow', 'diff', () => this.choice.diff, (v) => { this.choice.diff = v; store(false, 'bb-diff', v); });
    this._group('roomteamrow', 'team', () => this._me()?.team, (v) => {
      this.choice.team = v;
      store(false, 'bb-team', v);
      this._sync('teamrow');
      if (this.onTeam) this.onTeam(v);
    });
    this._group('roommoderow', 'mode', () => this.room?.mode, (v) => { if (this.onOptions) this.onOptions({ mode: v }); });
    this._group('roomdiffrow', 'diff', () => this.room?.difficulty, (v) => { if (this.onOptions) this.onOptions({ difficulty: v }); });
    this._refresh();
  }

  /** Button group: the selected one follows get(); a click calls pick(value). */
  _group(rowId, attr, get, pick) {
    const row = $(rowId);
    const g = { row, attr, get };
    (this.groups ||= {})[rowId] = g;
    row.addEventListener('click', (e) => {
      const b = e.target.closest('.choice');
      if (!b) return;
      pick(b.dataset[attr]);
      this._sync(rowId);
    });
    this._sync(rowId);
  }

  _sync(rowId) {
    const g = this.groups[rowId];
    const cur = g.get();
    for (const b of g.row.querySelectorAll('.choice')) b.classList.toggle('selected', b.dataset[g.attr] === cur);
  }

  _me() {
    return this.room ? this.room.players.find((p) => p.id === this.you) : null;
  }

  _create() {
    if (!this.connected || !this.onCreate) return;
    this.onCreate({
      lobbyName: cleanLobbyName(this.lobbyNameEl.value, ''),
      mode: this.choice.mode,
      difficulty: this.choice.diff,
    });
  }

  // ---- screens -----------------------------------------------------------------

  _show(name) {
    this.screen = name;
    for (const [k, node] of Object.entries(this.screens)) node.classList.toggle('hidden', k !== name);
    this.setStatus('');
    this._refresh();
  }

  showBrowse() { this._show('browse'); }

  showCreate() {
    this._show('create');
    this.lobbyNameEl.value = `${profile.name}'s Backyard`;
    for (const id of ['createmoderow', 'creatediffrow']) this._sync(id);
  }

  showRoom() {
    this._show('room');
    this._renderRoom();
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }
  get visible() { return !this.root.classList.contains('hidden'); }

  /** Status line under the buttons of the screen that is showing. */
  setStatus(text, bad = false) {
    const node = this.statusEls[this.screen];
    if (!node) return;
    let t = text;
    if (!t && this.screen === 'browse') t = this.connected ? 'Pick a lobby and press Join!' : 'Connecting…';
    node.textContent = t;
    node.classList.toggle('bad', bad);
  }

  setConnected(ok) {
    this.connected = ok;
    if (this.screen === 'browse') this.setStatus('');
    this._refresh();
  }

  _refresh() {
    this.createBtn.disabled = !this.connected;
    $('create-go').disabled = !this.connected;
    $('startgame').disabled = !this.connected;
    for (const r of this.rows.values()) r.btn.disabled = !this.connected || !!r.full;
  }

  // ---- lobby list ----------------------------------------------------------------

  /** Live list from the server. Rows are updated in place so a click is never lost to a redraw. */
  setList(list) {
    this.list = Array.isArray(list) ? list : [];
    const seen = new Set();
    for (const l of this.list) {
      if (!l || typeof l.id !== 'string') continue;
      seen.add(l.id);
      let r = this.rows.get(l.id);
      if (!r) {
        r = { row: el('div', 'lrow'), name: el('div', 'lname'), sub: el('div', 'lsub'), stat: el('div', 'lstat'), btn: el('button', 'joinbtn', 'Join') };
        r.row.setAttribute('role', 'listitem');
        r.btn.type = 'button';
        r.btn.dataset.play = '';
        r.btn.dataset.id = l.id;
        const main = el('div', 'lmain');
        main.append(r.name, r.sub, r.stat);
        r.row.append(main, r.btn);
        this.rows.set(l.id, r);
        this.listEl.appendChild(r.row);
      }
      const st = statusText(l);
      setText(r.name, typeof l.name === 'string' ? l.name : 'Lobby');
      setText(r.sub, detailText(l));
      setText(r.stat, st.text);
      const cls = `lstat ${st.kind}`;
      if (r.stat.className !== cls) r.stat.className = cls;
      r.full = !!l.full;
      setText(r.btn, r.full ? 'Full' : 'Join');
      r.btn.disabled = !this.connected || r.full;
    }
    for (const [id, r] of this.rows) {
      if (!seen.has(id)) {
        r.row.remove();
        this.rows.delete(id);
      }
    }
    this.emptyEl.classList.toggle('hidden', this.rows.size > 0);
    setText(this.countEl, this.rows.size ? `(${this.rows.size})` : '');
  }

  // ---- waiting room ----------------------------------------------------------------

  /** Latest lobbyState from the server (room = msg.lobby, you = msg.you). */
  setRoom(room, you) {
    this.room = room || null;
    this.you = you ?? null;
    if (this.screen === 'room') this._renderRoom();
  }

  _renderRoom() {
    const room = this.room;
    if (!room) return;
    const isHost = room.host === this.you;
    setText($('roomname'), room.name);
    setText($('roommode'), modeLabel(room.mode));
    setText($('roomdiff'), `${diffLabel(room.difficulty)} bots`);
    setText($('roomcount'), `(${room.players.length})`);
    const box = $('roomplayers');
    box.textContent = '';
    for (const p of room.players) {
      const row = el('div', p.id === this.you ? 'prow me' : 'prow');
      row.setAttribute('role', 'listitem');
      row.append(el('span', 'picon', ICON[p.team] || ICON.plant), el('span', 'pname', p.name));
      if (p.host) row.append(el('span', 'pcrown', ICON.crown));
      row.append(el('span', `pteam ${p.team === 'zombie' ? 'zombie' : 'plant'}`, teamLabel(p.team)));
      box.appendChild(row);
    }
    const mine = room.players.find((p) => p.id === this.you);
    setText($('roomrule'), ruleText(mine ? mine.team : this.choice.team));
    $('hostctl').classList.toggle('hidden', !isHost || room.status !== 'waiting');
    setText($('waitmsg'), waitText(room, this.you));
    $('waitmsg').classList.toggle('hidden', isHost && room.status === 'waiting');
    for (const id of ['roomteamrow', 'roommoderow', 'roomdiffrow']) this._sync(id);
  }
}
