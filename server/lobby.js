// Lobbies: many independent games in one process.
//
// A Lobby owns a member list, a waiting room and its own Game (own tick accumulator, own snapshot fanout). The
// manager never touches sockets: a "member" is any object with { id, cid, name, team, send(obj), raw(str),
// lastInputAt, inputActive } and the manager sets member.lobby. server/index.js passes its connected clients in.
//
//   waiting room --host Start--> playing --round over + result screen--> waiting room (teams kept)
//
// The first member in lobby.members (insertion order = how long they have been present) is the host; when the host
// leaves the next one takes over, and the lobby closes the moment it is empty (unless the last member's socket
// dropped; see below). Game state lives in memory only.
//
// Hardening (the server is public): lobbyState is coalesced to ~10 broadcasts/s per lobby and encoded once per
// broadcast; waiting rooms nobody touches for 15 min are closed; one address can own at most 3 lobbies; a lobby
// emptied by a dropped socket (not a clean Leave) is held for the rejoin window so the host can come back to it.
import { DEFAULT_CONFIG, publicConfig } from './sim/config.js';
import { Game, TEAMS, MODES, DIFFICULTIES, neutralInput } from './sim/game.js';
import { sanitizeName, sanitizeLobbyName } from './sim/names.js';

export const MAX_PLAYERS_PER_LOBBY = 50; // hidden safety caps, not shown to kids
export const MAX_LOBBIES = 20;
export const MAX_LOBBIES_PER_IP = 3; // live lobbies one address may have created
export const REJOIN_WINDOW_MS = 90_000; // a dropped member can slip back into their lobby this long
export const IDLE_LOBBY_MS = 15 * 60_000; // a waiting room nobody touches for this long is closed
export const STATE_INTERVAL_MS = 100; // lobbyState goes out at most this often per lobby
export const STALE_INPUT_MS = 500; // no input for this long => release all keys
const MAX_CATCHUP_STEPS = 5;
const MAX_REMEMBERED = 500;

const MESSAGES = {
  gone: 'That lobby just closed. Pick another one!',
  lobby_full: 'That lobby is full. Try another one!',
  too_many_lobbies: 'There are too many lobbies right now. Join one instead!',
  too_many_yours: 'You already have a few lobbies open. Join one of them instead!',
  not_host: 'Only the host can do that.',
  busy: 'The game has already started.',
  idle: 'That lobby closed because nobody did anything for a while.',
};
const fail = (error) => ({ error, message: MESSAGES[error] ?? error });

class Lobby {
  constructor(id, name, game, mode, difficulty, publicCfg, ownerIp = null, now = 0) {
    this.id = id;
    this.ownerIp = ownerIp; // address that created it (null = unknown), for the per-address cap
    this.name = name;
    this.game = game;
    this.mode = mode;
    this.difficulty = difficulty;
    this.publicConfig = publicCfg;
    this.status = 'waiting'; // 'waiting' | 'playing'
    this.members = new Map(); // id -> member, in order of arrival
    this.hostId = null;
    this.acc = 0;
    this.snapAcc = 0;
    this.last = null; // wall time of the previous step; null = first step after Start
    this.errors = 0;
    this.activeAt = now; // last time a member did something in the waiting room
    this.stateAt = -Infinity; // when lobbyState last went out
    this.stateDirty = false; // a change is waiting for the next flush
    this.reservedUntil = 0; // an empty lobby is held (for a dropped host to return to) until this time
  }

  get host() {
    return this.members.get(this.hostId) ?? null;
  }
}

export class LobbyManager {
  /**
   * Options: config, rng, log, now (ms clock), maxLobbies, maxPlayers, maxLobbiesPerIp, idleLobbyMs, stateIntervalMs,
   * onEvict(member, { error, message }) - called for each member of a lobby the manager closes on its own (idle).
   */
  constructor({
    config = DEFAULT_CONFIG,
    rng = Math.random,
    log = () => {},
    now = () => performance.now(),
    maxLobbies = MAX_LOBBIES,
    maxPlayers = MAX_PLAYERS_PER_LOBBY,
    maxLobbiesPerIp = MAX_LOBBIES_PER_IP,
    idleLobbyMs = IDLE_LOBBY_MS,
    stateIntervalMs = STATE_INTERVAL_MS,
    onEvict = () => {},
  } = {}) {
    this.config = { ...config, autoRestart: false }; // a finished round goes back to the waiting room
    this.rng = rng;
    this.log = log;
    this.now = now;
    this.maxLobbies = maxLobbies;
    this.maxPlayers = maxPlayers;
    this.maxLobbiesPerIp = maxLobbiesPerIp;
    this.idleLobbyMs = idleLobbyMs;
    this.stateIntervalMs = stateIntervalMs;
    this.onEvict = onEvict;
    this.lobbies = new Map();
    this.recent = new Map(); // client token -> { lobbyId, name, team, until }
    this.nextId = 1;
    this.tickStep = 1 / this.config.tickRate;
    this.snapStep = 1 / this.config.snapRate;
  }

  // ---- queries ---------------------------------------------------------------

  /** The lobby browser rows. Plain JSON. */
  list() {
    const out = [];
    for (const l of this.lobbies.values()) {
      if (l.members.size === 0) continue; // held for a dropped host: not offered to anyone else
      const playing = l.status === 'playing';
      out.push({
        id: l.id,
        name: l.name,
        host: l.host?.name ?? '',
        players: l.members.size,
        mode: l.mode,
        difficulty: l.difficulty,
        status: l.status,
        roundTime: playing ? Math.floor(l.game.roundTime) : 0,
        roundLength: this.config.roundLength,
        over: playing && l.game.phase === 'ended',
        full: l.members.size >= this.maxPlayers,
      });
    }
    return out;
  }

  _view(l) {
    return {
      id: l.id,
      name: l.name,
      host: l.hostId,
      hostName: l.host?.name ?? '',
      mode: l.mode,
      difficulty: l.difficulty,
      status: l.status,
      players: [...l.members.values()].map((m) => ({ id: m.id, name: m.name, team: m.team, host: m.id === l.hostId })),
    };
  }

  /**
   * Tell the room its state changed. Bursts are coalesced: the first goes out now, the rest wait for step().
   * Returns true when it went out now.
   */
  _broadcastState(l) {
    const t = this.now();
    if (t - l.stateAt < this.stateIntervalMs) {
      l.stateDirty = true;
      return false;
    }
    this._flushState(l, t);
    return true;
  }

  /** Encode the room once and give every member their own `you` by splicing it in front of the shared JSON. */
  _flushState(l, t) {
    l.stateAt = t;
    l.stateDirty = false;
    if (l.members.size === 0) return;
    const lobby = this._view(l);
    const json = JSON.stringify(lobby);
    for (const m of l.members.values()) this._sendState(m, lobby, json);
  }

  _sendState(m, lobby, json) {
    m.send({ t: 'lobbyState', you: m.id, lobby }, `{"t":"lobbyState","you":${JSON.stringify(m.id)},"lobby":${json}}`);
  }

  /** Only `m` gets the room state (a new arrival, or someone asking again). */
  _sendStateTo(l, m) {
    const lobby = this._view(l);
    this._sendState(m, lobby, JSON.stringify(lobby));
  }

  _touch(l) {
    l.activeAt = this.now();
  }

  _ownedBy(ip) {
    let n = 0;
    for (const l of this.lobbies.values()) if (l.ownerIp === ip) n++;
    return n;
  }

  // ---- membership ------------------------------------------------------------

  _profile(member, { name, team } = {}) {
    member.name = sanitizeName(name, sanitizeName(member.name));
    if (TEAMS.has(team)) member.team = team;
    else if (!TEAMS.has(member.team)) member.team = 'plant';
  }

  _seat(l, member) {
    const t = this.now();
    l.members.set(member.id, member);
    member.lobby = l;
    if (member.cid) this.recent.delete(member.cid); // seated again: any "slip back in" record is used up
    member.inputActive = false;
    member.lastInputAt = t;
    if (l.hostId === null) l.hostId = member.id;
    l.reservedUntil = 0;
    this._touch(l);
    if (l.status === 'playing') {
      // dropping into a game already under way
      l.game.addPlayer(member.id, { name: member.name, team: member.team });
      member.send({ t: 'welcome', id: member.id, config: l.publicConfig, state: l.game.mapState() });
    }
    if (!this._broadcastState(l)) this._sendStateTo(l, member); // the newcomer does not wait for the coalesced flush
  }

  /**
   * Make a new lobby with `member` as host. opts: { lobbyName, mode, difficulty, team, name }.
   * The caps are checked before the member leaves their current lobby (a refusal must not kick them out); a lobby
   * they are the last member of is about to close, so it does not count against them.
   */
  create(member, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const freed = member.lobby && member.lobby.members.size === 1 ? member.lobby : null;
    if (this.lobbies.size - (freed ? 1 : 0) >= this.maxLobbies) return fail('too_many_lobbies');
    if (member.ip && this._ownedBy(member.ip) - (freed?.ownerIp === member.ip ? 1 : 0) >= this.maxLobbiesPerIp) {
      return fail('too_many_yours');
    }
    if (member.lobby) this.leave(member);
    this._profile(member, o);
    const c = this.config;
    const id = `L${this.nextId++}`;
    const game = new Game(c, this.rng);
    const l = new Lobby(
      id,
      sanitizeLobbyName(o.lobbyName, `${member.name}'s Backyard`),
      game,
      MODES.has(o.mode) ? o.mode : c.defaultMode,
      DIFFICULTIES.has(o.difficulty) ? o.difficulty : c.defaultDifficulty,
      publicConfig(c),
      member.ip ?? null,
      this.now(),
    );
    this.lobbies.set(id, l);
    this.log(`lobby ${id} "${l.name}" created by ${member.name}`);
    this._seat(l, member);
    return { lobby: l };
  }

  /** Put `member` in lobby `lobbyId` (waiting room, or straight into a running game). opts: { team, name }. */
  join(member, lobbyId, opts = {}) {
    const l = typeof lobbyId === 'string' ? this.lobbies.get(lobbyId) : undefined;
    if (!l || l.members.size === 0) return fail('gone'); // an empty lobby is only reachable through rejoin()
    return this._join(member, l, opts);
  }

  _join(member, l, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (member.lobby === l) {
      this._sendStateTo(l, member); // already in: just answer the asker, not the whole room
      return { lobby: l };
    }
    if (l.members.size >= this.maxPlayers) return fail('lobby_full');
    if (member.lobby) this.leave(member);
    this._profile(member, o);
    this._seat(l, member);
    this.log(`${member.name} joined lobby ${l.id}`);
    return { lobby: l };
  }

  /**
   * Take `member` out of their lobby. remember: the socket dropped rather than the kid pressing Leave, so keep a
   * short-lived record that lets the same client token slip back in (see rejoin).
   */
  leave(member, { remember = false } = {}) {
    const l = member.lobby;
    if (!l) return;
    l.members.delete(member.id);
    member.lobby = null;
    member.inputActive = false;
    if (l.status === 'playing') l.game.removePlayer(member.id);
    if (member.cid) {
      if (remember) this._remember(member, l);
      else this.recent.delete(member.cid);
    }
    if (l.members.size === 0) {
      if (remember && member.cid) {
        // the socket dropped: hold the empty lobby (paused, hidden) so the same page can slip back in as host
        l.status = 'waiting';
        l.hostId = null;
        l.last = null;
        l.acc = 0;
        l.stateDirty = false;
        l.reservedUntil = this.now() + REJOIN_WINDOW_MS;
        this.log(`lobby ${l.id} empty, held for ${REJOIN_WINDOW_MS / 1000}s`);
      } else {
        this.lobbies.delete(l.id);
        this.log(`lobby ${l.id} closed`);
      }
    } else {
      if (l.hostId === member.id) {
        l.hostId = l.members.keys().next().value;
        this.log(`lobby ${l.id}: ${l.host.name} is the host now`);
      }
      this._touch(l);
      this._broadcastState(l);
    }
    member.send({ t: 'lobbyState', you: member.id, lobby: null });
  }

  _remember(member, l) {
    const t = this.now();
    if (this.recent.size >= MAX_REMEMBERED) {
      for (const [k, v] of this.recent) if (v.until < t) this.recent.delete(k);
      if (this.recent.size >= MAX_REMEMBERED) this.recent.delete(this.recent.keys().next().value);
    }
    this.recent.set(member.cid, { lobbyId: l.id, name: member.name, team: member.team, until: t + REJOIN_WINDOW_MS });
  }

  /** A reconnecting client token goes back to the lobby it dropped out of, if that still exists. Returns it or null. */
  rejoin(member) {
    if (!member.cid || member.lobby) return null;
    const r = this.recent.get(member.cid);
    if (!r) return null;
    this.recent.delete(member.cid);
    if (r.until < this.now()) return null;
    const l = this.lobbies.get(r.lobbyId);
    if (!l) return null;
    const res = this._join(member, l, { team: r.team, name: member.name || r.name });
    return res.error ? null : res.lobby;
  }

  // ---- waiting-room actions ----------------------------------------------------

  setTeam(member, team) {
    const l = member.lobby;
    if (!l || l.status !== 'waiting' || !TEAMS.has(team)) return;
    member.team = team;
    this._touch(l);
    this._broadcastState(l);
  }

  setName(member, raw) {
    member.name = sanitizeName(raw);
    const l = member.lobby;
    if (!l) return;
    if (l.status === 'playing') l.game.renamePlayer(member.id, member.name);
    this._touch(l);
    this._broadcastState(l);
  }

  /** Host only, waiting room only. */
  setOptions(member, { mode, difficulty } = {}) {
    const l = member.lobby;
    if (!l) return fail('gone');
    if (l.hostId !== member.id) return fail('not_host');
    if (l.status !== 'waiting') return fail('busy');
    if (MODES.has(mode)) l.mode = mode;
    if (DIFFICULTIES.has(difficulty)) l.difficulty = difficulty;
    this._touch(l);
    this._broadcastState(l);
    return { lobby: l };
  }

  /** Host only: waiting room -> everyone into a fresh round. */
  start(member) {
    const l = member.lobby;
    if (!l) return fail('gone');
    if (l.hostId !== member.id) return fail('not_host');
    if (l.status !== 'waiting') return fail('busy');
    const t = this.now();
    l.status = 'playing';
    l.last = null;
    l.acc = 0;
    l.snapAcc = 0;
    l.game.startMatch({
      mode: l.mode,
      difficulty: l.difficulty,
      players: [...l.members.values()].map((m) => ({ id: m.id, name: m.name, team: m.team })),
    });
    for (const m of l.members.values()) {
      m.inputActive = false;
      m.lastInputAt = t;
      m.send({ t: 'welcome', id: m.id, config: l.publicConfig, state: l.game.mapState() });
    }
    this._broadcastState(l);
    this.log(`lobby ${l.id} started (${l.mode}, ${l.difficulty}, ${l.members.size} players)`);
    return { lobby: l };
  }

  /** A client `input` message: only matters while the member's lobby is playing. */
  input(member, msg) {
    const l = member.lobby;
    if (!l || l.status !== 'playing') return;
    member.lastInputAt = this.now();
    member.inputActive = true;
    l.game.handleInput(member.id, msg);
  }

  // ---- ticking -------------------------------------------------------------------

  /**
   * Advance every playing lobby to wall-clock time `now` (ms) and do the housekeeping: flush coalesced lobbyState,
   * close held lobbies nobody came back to, close idle waiting rooms. A failing lobby never stops the others.
   */
  step(now) {
    for (const l of this.lobbies.values()) {
      try {
        this._stepOne(l, now);
      } catch (err) {
        if (l.errors++ % 100 === 0) this.log(`lobby ${l.id} tick error (#${l.errors}): ${err?.stack ?? err}`);
      }
    }
  }

  _stepOne(l, now) {
    if (l.members.size === 0) {
      if (now >= l.reservedUntil) {
        this.lobbies.delete(l.id);
        this.log(`lobby ${l.id} closed (nobody came back)`);
      }
      return;
    }
    if (l.stateDirty && now - l.stateAt >= this.stateIntervalMs) this._flushState(l, now);
    if (l.status === 'waiting' && now - l.activeAt > this.idleLobbyMs) this._expire(l);
    else if (l.status === 'playing') this._stepLobby(l, now);
  }

  _stepLobby(l, now) {
    if (l.last === null) {
      l.last = now;
      return;
    }
    l.acc += Math.min((now - l.last) / 1000, 0.25);
    l.last = now;
    let steps = 0;
    while (l.acc >= this.tickStep && steps < MAX_CATCHUP_STEPS) {
      this._releaseStaleInputs(l, now);
      l.acc -= this.tickStep; // consume first so a throwing tick can't wedge the loop
      l.game.tick(this.tickStep);
      steps++;
      if (l.game.phase === 'lobby') {
        // the result screen just ended: the game is empty now, so no snapshot of it (see _roundOver)
        l.acc = 0;
        break;
      }
      l.snapAcc += this.tickStep;
      if (l.snapAcc >= this.snapStep - 1e-9) {
        l.snapAcc -= this.snapStep;
        this._fanout(l);
      }
    }
    if (steps === MAX_CATCHUP_STEPS) l.acc = 0; // fell behind: drop the backlog
    if (l.game.phase === 'lobby') this._roundOver(l);
  }

  _fanout(l) {
    const snap = l.game.snapshot();
    l.game.drainEvents();
    const payload = JSON.stringify(snap);
    for (const m of l.members.values()) m.raw(payload);
  }

  _releaseStaleInputs(l, now) {
    for (const m of l.members.values()) {
      if (m.inputActive && now - m.lastInputAt > STALE_INPUT_MS) {
        m.inputActive = false;
        l.game.handleInput(m.id, neutralInput());
      }
    }
  }

  /** The result screen finished and the game is empty again: everyone is back in the waiting room, teams kept. */
  _roundOver(l) {
    l.status = 'waiting';
    for (const m of l.members.values()) m.inputActive = false;
    this._touch(l);
    this._broadcastState(l);
    this.log(`lobby ${l.id} back in the waiting room`);
  }

  /** Nobody has touched this waiting room for a long time: close it and send everyone back to the browser. */
  _expire(l) {
    this.lobbies.delete(l.id);
    this.log(`lobby ${l.id} closed (idle)`);
    const res = fail('idle');
    for (const m of l.members.values()) {
      m.lobby = null;
      m.inputActive = false;
      if (m.cid) this.recent.delete(m.cid);
      m.send({ t: 'lobbyState', you: m.id, lobby: null });
      try {
        this.onEvict(m, res);
      } catch (err) {
        this.log(`evict error: ${err?.message ?? err}`);
      }
    }
    l.members.clear();
  }

  close() {
    this.lobbies.clear();
    this.recent.clear();
  }
}
