// Authoritative game simulation. Pure logic: no I/O, no timers. The server ticks it.
import { DEFAULT_CONFIG } from './config.js';
import { WORLD, clampToWorld } from './world.js';
import { clamp, round, wrapAngle } from './vec.js';
import { getWeapon, weaponFor } from './weapons.js';
import { fireWeapon, stepProjectiles } from './combat.js';
import { emptySlots, initGarden, stepGarden, stepSun, tryPlant } from './garden.js';
import { createMower, stepMower } from './mower.js';
import { createRack, stepEquipment } from './equipment.js';
import { planWaves, stepRules } from './rules.js';
import { stepBots } from './bots.js';

const TEAMS = new Set(['plant', 'zombie']);
const MODES = new Set(['coop', 'versus']);
const DIFFICULTIES = new Set(['easy', 'normal']);
const KEY_NAMES = ['f', 'b', 'l', 'r', 'jump'];
// Optional entity fields copied verbatim into snapshots when defined.
const OPTIONAL_FIELDS = ['weapon', 'tier', 'state', 'name', 'plantKind', 'sunshine', 'progress', 'streak', 'projKind', 'seq', 'driver', 'item', 'itemHp', 'itemId', 'available', 'heldBy'];
const MAX_PENDING_EVENTS = 500;
const MAX_PLANT_QUEUE = 4; // plant presses buffered between ticks

export function neutralInput() {
  return { keys: { f: false, b: false, l: false, r: false, jump: false }, fire: false, use: false, drop: false, plant: 0 };
}

export class Game {
  constructor(config = DEFAULT_CONFIG, rng = Math.random) {
    this.config = config;
    this.rng = rng;
    this.entities = new Map();
    this.events = [];
    this.time = 0; // monotonically increasing sim clock (seconds)
    this._ids = {};
    this.slots = emptySlots();
    this.sunTimer = config.sunDropInterval;
    this._resetToLobby();
  }

  // ---- lifecycle -----------------------------------------------------------

  _resetToLobby() {
    this.entities.clear();
    this.events.length = 0;
    this.phase = 'lobby';
    this.mode = null;
    this.difficulty = null;
    this.winner = null;
    this.roundTime = 0;
    this.wave = 0;
    this.slots = emptySlots();
    this.mower = null;
    this.racks = null;
    this.waveTimes = [];
    this.waveIndex = 0;
    this.finalWaveSpawned = false;
    this.endTimer = 0;
    this.gardenerTimer = 0;
  }

  difficultyConfig() {
    const d = this.config.difficulties;
    return d[this.difficulty] ?? d[this.config.defaultDifficulty];
  }

  humans() {
    const list = [];
    for (const e of this.entities.values()) if (e.kind === 'player') list.push(e);
    return list;
  }

  newId(prefix) {
    this._ids[prefix] = (this._ids[prefix] ?? 0) + 1;
    return `${prefix}${this._ids[prefix]}`;
  }

  emit(type, data = {}) {
    this.events.push({ type, ...data });
    if (this.events.length > MAX_PENDING_EVENTS) this.events.splice(0, this.events.length - MAX_PENDING_EVENTS);
  }

  /** Returns and clears events emitted since the last drain. */
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** (Re)start a round: humans respawn, everything else is rebuilt. */
  startRound() {
    for (const [id, e] of this.entities) if (e.kind !== 'player') this.entities.delete(id);
    this.phase = 'playing';
    this.winner = null;
    this.roundTime = 0;
    this.wave = 0;
    this.slots = emptySlots();
    this.sunTimer = this.config.sunDropInterval;
    this.waveTimes = planWaves(this.config);
    this.waveIndex = 0;
    this.finalWaveSpawned = false;
    this.endTimer = 0;
    this.gardenerTimer = 0;
    createMower(this);
    createRack(this);
    if (this.config.features.initialGarden) initGarden(this);
    for (const p of this.humans()) this._resetPlayer(p);
  }

  addPlayer(id, opts = {}) {
    if (typeof id !== 'string' || id === '') return null;
    const existing = this.entities.get(id);
    if (existing) return existing;
    if (this.humans().length >= this.config.maxPlayers) return null;
    const o = opts && typeof opts === 'object' ? opts : {};
    const team = TEAMS.has(o.team) ? o.team : 'plant';
    const first = this.phase === 'lobby' || this.humans().length === 0;
    if (first) {
      this.mode = MODES.has(o.mode) ? o.mode : this.config.defaultMode;
      this.difficulty = DIFFICULTIES.has(o.difficulty) ? o.difficulty : this.config.defaultDifficulty;
    }
    let name = typeof o.name === 'string' ? o.name.trim().slice(0, this.config.nameMaxLength) : '';
    if (name === '') name = this.config.defaultName;
    const p = this._makePlayer(id, name, team);
    this.entities.set(id, p);
    if (first) this.startRound();
    else this._resetPlayer(p);
    return p;
  }

  removePlayer(id) {
    const e = this.entities.get(id);
    if (!e || e.kind !== 'player') return;
    this.entities.delete(id);
    if (this.humans().length === 0) this._resetToLobby();
  }

  // ---- players ---------------------------------------------------------------

  _makePlayer(id, name, team) {
    const c = this.config;
    return {
      id,
      kind: 'player',
      team,
      name,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      vy: 0,
      hp: 0,
      maxHp: team === 'plant' ? c.plantHp : c.zombieHp,
      state: 'alive',
      tier: 0,
      progress: 0,
      streak: 0,
      seq: 0,
      radius: c.playerRadius,
      height: c.playerHeight,
      timer: 0,
      cooldown: 0,
      weapon: weaponFor(team, 0).id,
      input: neutralInput(),
      item: null, // garage equipment currently held (see equipment.js)
      plantQueue: [], // pending planting attempts (1 = peashooter, 2 = cactus)
      plantSeqSeen: 0, // highest client plantSeq applied
    };
  }

  /** A walking bot. Bots are driven by writing e.input (see bots.js). */
  spawnBot(team, x, z) {
    const c = this.config;
    const hp = team === 'plant' ? c.plantHp : c.zombieHp;
    const e = {
      id: this.newId('b'),
      kind: 'bot',
      team,
      x,
      y: 0,
      z,
      yaw: team === 'plant' ? 0 : Math.PI,
      pitch: 0,
      vy: 0,
      hp,
      maxHp: hp,
      state: 'alive',
      weapon: weaponFor(team, 0).id,
      radius: c.playerRadius,
      height: c.playerHeight,
      timer: 0,
      cooldown: 0,
      input: neutralInput(),
      item: null,
      ai: null,
    };
    this.entities.set(e.id, e);
    return e;
  }

  removeEntity(e) {
    e.state = 'dead';
    this.entities.delete(e.id);
    if (e.kind === 'garden' && this.slots[e.slot]?.plantId === e.id) this.slots[e.slot].plantId = null;
  }

  clearInput(e) {
    e.input = neutralInput();
    if (e.kind === 'player') e.plantQueue.length = 0;
    e.usePressed = false;
    e.dropPressed = false;
  }

  /** Spawn point for a team; zombies appear along the gate. */
  spawnPoint(team) {
    if (team === 'plant') return { ...WORLD.plantSpawn };
    const g = WORLD.gate;
    return { x: g.minX + this.rng() * (g.maxX - g.minX), y: 0, z: g.z };
  }

  /** Put a human (back) into the game at full health. Tier/progress are reset by _resetPlayer only. */
  respawn(p) {
    const s = this.spawnPoint(p.team);
    p.x = s.x;
    p.y = 0;
    p.z = s.z;
    p.vy = 0;
    p.hp = p.maxHp;
    p.state = 'alive';
    p.timer = 0;
    p.slowTimer = 0;
    p.slowFactor = 1;
    p.item = null;
    p.using = false;
    delete p.itemHp;
    p.plantQueue.length = 0;
    p.yaw = p.team === 'plant' ? 0 : Math.PI; // plants face the gate (-z), zombies face the house (+z)
    p.pitch = 0;
  }

  /** Full per-round reset for a human. */
  _resetPlayer(p) {
    p.tier = 0;
    p.progress = 0;
    p.streak = 0;
    p.weapon = weaponFor(p.team, 0).id;
    p.cooldown = 0;
    p.sunshine = p.team === 'plant' ? this.config.startSunshine : undefined;
    this.clearInput(p);
    this.respawn(p);
  }

  handleInput(id, raw) {
    const e = this.entities.get(id);
    if (!e || e.kind !== 'player' || !raw || typeof raw !== 'object') return;
    try {
      this._applyInput(e, raw);
    } catch {
      // Hostile input objects (throwing getters/toString) are ignored wholesale.
    }
  }

  _applyInput(e, raw) {
    const inp = e.input;
    const k = raw.keys;
    if (k && typeof k === 'object') {
      for (const name of KEY_NAMES) if (k[name] !== undefined) inp.keys[name] = Boolean(k[name]);
    }
    if (raw.fire !== undefined) inp.fire = Boolean(raw.fire);
    if (raw.use !== undefined) {
      const use = Boolean(raw.use);
      if (use && !inp.use) e.usePressed = true; // rising edge: consumed by the sim at the end of the tick
      inp.use = use;
    }
    if (raw.drop !== undefined) {
      const drop = Boolean(raw.drop);
      if (drop && !inp.drop) e.dropPressed = true;
      inp.drop = drop;
    }
    if (Number.isInteger(raw.plant) && raw.plant >= 0 && raw.plant <= 2) {
      if (Number.isSafeInteger(raw.plantSeq) && raw.plantSeq >= 0) {
        // Sequenced planting: every press carries a higher plantSeq, so repeated presses of the same
        // key are never merged. Resent or out-of-order numbers are ignored.
        if (raw.plantSeq > e.plantSeqSeen) {
          e.plantSeqSeen = raw.plantSeq;
          if (raw.plant !== 0) this._queuePlant(e, raw.plant);
        }
      } else if (raw.plantSeq === undefined && raw.plant !== 0 && inp.plant === 0) {
        // Legacy clients: planting is edge-triggered, 0 -> 1/2 queues one attempt.
        this._queuePlant(e, raw.plant);
      }
      inp.plant = raw.plant;
    }
    if (typeof raw.yaw === 'number' && Number.isFinite(raw.yaw)) e.yaw = wrapAngle(raw.yaw);
    if (typeof raw.pitch === 'number' && Number.isFinite(raw.pitch)) {
      const lim = this.config.pitchLimit;
      e.pitch = clamp(raw.pitch, -lim, lim);
    }
    if (Number.isInteger(raw.seq)) e.seq = raw.seq;
  }

  // ---- simulation ------------------------------------------------------------

  tick(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, this.config.maxDt);
    this.time += dt;
    if (this.phase === 'lobby') return;
    if (this.phase === 'playing') {
      this.roundTime += dt;
      stepBots(this, dt);
      this._stepActors(dt);
      stepMower(this, dt);
      stepEquipment(this, dt);
      stepGarden(this, dt);
      stepProjectiles(this, dt);
      stepSun(this, dt);
      this._clearEdges();
    } else {
      this._stepActors(dt); // result screen: everyone can still walk around, nobody can shoot
      this._clearEdges();
    }
    stepRules(this, dt);
  }

  _queuePlant(e, kind) {
    if (e.plantQueue.length < MAX_PLANT_QUEUE) e.plantQueue.push(kind);
  }

  /** Edge-triggered presses live for exactly one tick. */
  _clearEdges() {
    for (const e of this.entities.values()) {
      if (e.kind === 'player' || e.kind === 'bot') {
        e.usePressed = false;
        e.dropPressed = false;
      }
    }
  }

  _stepActors(dt) {
    for (const e of [...this.entities.values()]) {
      if (e.kind !== 'player' && e.kind !== 'bot') continue;
      if (e.slowTimer > 0) {
        e.slowTimer -= dt;
        if (e.slowTimer <= 0) {
          e.slowTimer = 0;
          e.slowFactor = 1;
        }
      }
      if (e.state === 'wilted' || e.state === 'sprout') {
        e.timer -= dt;
        if (e.timer <= 0 && e.kind === 'player') this.respawn(e);
        continue;
      }
      if (e.state !== 'alive') continue;
      this._moveActor(e, dt);
      this._stepWeapon(e, dt);
      if (e.plantQueue?.length) {
        for (const kind of e.plantQueue) if (this.phase === 'playing') tryPlant(this, e, kind === 1 ? 'peashooter' : 'cactus');
        e.plantQueue.length = 0;
      }
    }
  }

  _stepWeapon(e, dt) {
    const w = getWeapon(e.weapon);
    e.cooldown -= dt;
    if (!w || !e.input.fire || this.phase !== 'playing' || this.isDriving(e) || e.item) {
      if (e.cooldown < 0) e.cooldown = 0;
      return;
    }
    if (e.cooldown <= 0) {
      fireWeapon(this, e);
      e.cooldown += 1 / (w.rate * (e.fireScale ?? 1));
    }
  }

  isDriving(e) {
    const m = this.mower;
    return Boolean(m && m.state === 'driving' && m.driver === e.id);
  }

  moveSpeedFor(e) {
    const c = this.config;
    let speed;
    if (this.isDriving(e)) speed = c.mowerSpeed * (e.kind === 'bot' ? c.botMowerSpeedScale : 1);
    else if (e.kind === 'bot') speed = e.team === 'zombie' ? c.zombieBotSpeed : c.gardener.speed;
    else speed = c.moveSpeed;
    if (e.slowTimer > 0) speed *= e.slowFactor ?? 0.5;
    if (e.item) speed *= c.equipment[e.item]?.speedScale ?? 1;
    return speed;
  }

  _moveActor(e, dt) {
    const c = this.config;
    const ox = e.x;
    const oz = e.z;
    const { keys } = e.input;
    const ix = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
    const iz = (keys.f ? 1 : 0) - (keys.b ? 1 : 0);
    const len = Math.hypot(ix, iz);
    if (len > 0) {
      const speed = this.moveSpeedFor(e);
      const s = Math.sin(e.yaw);
      const co = Math.cos(e.yaw);
      // forward = (-sin, -cos), right = (cos, -sin)
      const dx = (co * ix - s * iz) / len;
      const dz = (-s * ix - co * iz) / len;
      e.x += dx * speed * dt;
      e.z += dz * speed * dt;
    }
    if (e.y <= 0 && e.vy <= 0) {
      e.y = 0;
      e.vy = 0;
      if (keys.jump) e.vy = c.jumpSpeed;
    }
    if (e.vy !== 0 || e.y > 0) {
      e.vy -= c.gravity * dt;
      e.y += e.vy * dt;
      if (e.y <= 0) {
        e.y = 0;
        e.vy = 0;
      }
    }
    clampToWorld(e, e.radius);
    e.vx = (e.x - ox) / dt; // actual ground velocity (turrets use it to aim)
    e.vz = (e.z - oz) / dt;
  }

  // ---- queries ---------------------------------------------------------------

  gardenCount() {
    let n = 0;
    for (const e of this.entities.values()) if (e.kind === 'garden') n++;
    return n;
  }

  // ---- snapshots -------------------------------------------------------------

  serialize(e) {
    const o = {
      id: e.id,
      kind: e.kind,
      team: e.team,
      x: round(e.x, 2),
      y: round(e.y, 2),
      z: round(e.z, 2),
      yaw: round(e.yaw ?? 0, 3),
      hp: e.hp,
      maxHp: e.maxHp,
    };
    if (e.pitch !== undefined) o.pitch = round(e.pitch, 3);
    for (const f of OPTIONAL_FIELDS) if (e[f] !== undefined) o[f] = f === 'progress' ? round(e[f], 3) : e[f];
    if (e.state === 'wilted' || e.state === 'sprout' || e.state === 'destroyed') o.respawnIn = round(Math.max(0, e.timer), 1);
    if (e.slowTimer > 0) o.slowed = true;
    if (e.using) o.using = true;
    if (e.kind === 'rack_item' && !e.available && e.heldBy === null) o.respawnIn = round(Math.max(0, e.timer), 1);
    return o;
  }

  snapshot() {
    const entities = [];
    for (const e of this.entities.values()) entities.push(this.serialize(e));
    return {
      t: 'snap',
      time: Math.round(this.time * 1000), // sim clock in milliseconds
      phase: this.phase,
      winner: this.winner,
      roundTime: round(this.roundTime, 2),
      roundLength: this.config.roundLength,
      wave: this.wave,
      gardenCount: this.gardenCount(),
      entities,
      events: this.events.slice(),
    };
  }
}
