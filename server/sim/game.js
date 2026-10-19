// Authoritative game simulation. Pure logic: no I/O, no timers. The server ticks it.
import { DEFAULT_CONFIG } from './config.js';
import { WORLD } from './world.js';
import { terrainHeight } from './terrain.js';
import { createField } from './collide.js';
import { walkerStep } from '../../shared/walker.js';
import { Cover } from './cover.js';
import { createFridge, stepFridge } from './fridge.js';
import { tryBuild, buildList } from './build.js';
import { spawnParts, stepParts, partsMask, dropCarried } from './parts.js';
import { clamp, round, wrapAngle } from './vec.js';
import { getWeapon, weaponFor } from './weapons.js';
import { fireWeapon, stepProjectiles } from './combat.js';
import { emptySlots, initGarden, stepGarden, stepSun, tryPlant, tryUpgrade, potGone } from './garden.js';
import { createMower, stepMower } from './mower.js';
import { createRack, stepEquipment } from './equipment.js';
import { planWaves, stepRules } from './rules.js';
import { stepRepair } from './repair.js';
import { stepBots } from './bots.js';
import { sanitizeName } from './names.js';

export const TEAMS = new Set(['plant', 'zombie']);
export const MODES = new Set(['coop', 'versus']);
export const DIFFICULTIES = new Set(Object.keys(DEFAULT_CONFIG.difficulties)); // easy .. insane (config.difficulties key order)

/** A difficulty id from whatever a client sent ('Very Hard', 'veryhard', 'INSANE'), or null when it is not one of the levels. */
export function normalizeDifficulty(v) {
  if (typeof v !== 'string' || v.length > 24) return null;
  const id = v.toLowerCase().replace(/[^a-z]/g, '');
  return DIFFICULTIES.has(id) ? id : null;
}
const KEY_NAMES = ['f', 'b', 'l', 'r', 'jump'];
// Optional entity fields copied verbatim into snapshots when defined.
const OPTIONAL_FIELDS = ['weapon', 'tier', 'state', 'name', 'plantKind', 'level', 'sunshine', 'progress', 'streak', 'projKind', 'seq', 'driver', 'item', 'itemHp', 'itemId', 'available', 'heldBy', 'brains', 'carry', 'partKind', 'powered', 'repairing', 'rebuild'];
const MAX_PENDING_EVENTS = 500;
const MAX_PLANT_QUEUE = 4; // plant presses buffered between ticks
const MAX_BUILD_QUEUE = 4; // build presses buffered between ticks

export function neutralInput() {
  return { keys: { f: false, b: false, l: false, r: false, jump: false }, fire: false, use: false, drop: false, upgrade: false, plant: 0 };
}

export class Game {
  constructor(config = DEFAULT_CONFIG, rng = Math.random) {
    this.config = config;
    this.rng = rng;
    this.plantOrder = Object.keys(config.plantTypes); // planting key n (1-based) plants plantOrder[n - 1]
    this.entities = new Map();
    this.events = [];
    this.time = 0; // monotonically increasing sim clock (seconds)
    this.tickN = 0; // ticks run so far (lets a snapshot say how many ticks ago a player's latest input arrived)
    this._ids = {};
    this.slots = emptySlots();
    this.sunTimer = config.sunDropInterval;
    this.field = createField(); // static walls + this round's doors, cover and builds
    this.cover = new Cover(this);
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
    this.scaling = null;
    this.roundTime = 0;
    this.wave = 0;
    this.slots = emptySlots();
    this.mower = null;
    this.racks = null;
    this.waveTimes = [];
    this.waveIndex = 0;
    this.finalWaveSpawned = false;
    this.endTimer = 0;
    this.gardenerTimers = [];
    this.gardenerBank = [];
    this.headStart = 0;
    this.fridge = createFridge();
    this.recomputeScaling();
  }

  difficultyConfig() {
    const d = this.config.difficulties;
    return d[this.difficulty] ?? d[this.config.defaultDifficulty];
  }

  /**
   * Which side the level toughens, from who the humans are (recomputed at the start of a round and whenever a human joins or
   * leaves; things that already exist keep what they were made with, so a change mid-round shows in what is created from then on):
   *  - kids only on the plants  -> mode 'zombie': the zombie bots get the level's numbers, the plant side stays as it is;
   *  - kids only on the zombies -> mode 'plant': doors, plants, pots and the Gardeners get the level's toughness, the zombie bots
   *    (the kid's allies) stay at Normal;
   *  - kids on both sides (versus) -> mode 'both': the zombie bots get the level's numbers and the plant side's toughness counts half;
   *  - nobody yet -> as 'zombie'.
   * this.scaling = { mode, zombie (the difficulty row for zombie-bot numbers), share (of the plant side's toughness), plant (multipliers) }.
   */
  recomputeScaling() {
    let plant = 0;
    let zombie = 0;
    for (const e of this.entities.values()) {
      if (e.kind !== 'player') continue;
      if (e.team === 'zombie') zombie++;
      else plant++;
    }
    const mode = zombie > 0 && plant === 0 ? 'plant' : zombie > 0 && plant > 0 ? 'both' : 'zombie';
    const row = this.difficultyConfig();
    const normal = this.config.difficulties.normal ?? row;
    const share = mode === 'plant' ? 1 : mode === 'both' ? this.config.versusToughShare ?? 0.5 : 0;
    const t = row.tough ?? {};
    const m = (k) => 1 + ((t[k] ?? 1) - 1) * share;
    this.scaling = { mode, zombie: mode === 'plant' ? normal : row, share, plant: { door: m('door'), repair: m('repair'), plantHp: m('plantHp'), plantDmg: m('plantDmg'), plantRate: m('plantRate'), potHp: m('potHp') } };
    return this.scaling;
  }

  /** The difficulty row whose zombie-bot numbers apply (the lobby's level, or Normal when the kids are all zombies). */
  zombieLevel() {
    return this.scaling.zombie;
  }

  /** The Gardener tunables for this round's level: config.gardener with the level's overrides on top. */
  gardenerConfig() {
    return { ...this.config.gardener, ...(this.difficultyConfig().gardener ?? {}) };
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
    this.gardenerTimers = [];
    this.gardenerBank = [];
    this.headStart = this.config.features.headStart ? this.config.headStart : 0;
    this.fridge = createFridge();
    this.recomputeScaling(); // who the humans are decides which side the level toughens
    this.cover.reset();
    createMower(this);
    createRack(this);
    spawnParts(this);
    if (this.config.features.initialGarden) initGarden(this);
    for (const p of this.humans()) this._resetPlayer(p);
  }

  /** Waiting room -> round: set mode and difficulty, seat everyone, begin. players: [{ id, name, team }]. */
  startMatch({ mode, difficulty, players = [] } = {}) {
    this._resetToLobby();
    this.mode = MODES.has(mode) ? mode : this.config.defaultMode;
    this.difficulty = normalizeDifficulty(difficulty) ?? this.config.defaultDifficulty;
    for (const p of players) {
      if (!p || typeof p.id !== 'string' || p.id === '' || this.entities.has(p.id)) continue;
      const name = sanitizeName(p.name, this.config.defaultName, this.config.nameMaxLength);
      this.entities.set(p.id, this._makePlayer(p.id, name, TEAMS.has(p.team) ? p.team : 'plant'));
    }
    this.startRound();
  }

  /** The result screen is over and nobody restarts the round: back to the empty waiting-room state. */
  endMatch() {
    this._resetToLobby();
  }

  addPlayer(id, opts = {}) {
    if (typeof id !== 'string' || id === '') return null;
    const existing = this.entities.get(id);
    if (existing) return existing;
    const o = opts && typeof opts === 'object' ? opts : {};
    const team = TEAMS.has(o.team) ? o.team : 'plant';
    const first = this.phase === 'lobby' || this.humans().length === 0;
    if (first) {
      this.mode = MODES.has(o.mode) ? o.mode : this.config.defaultMode;
      this.difficulty = normalizeDifficulty(o.difficulty) ?? this.config.defaultDifficulty;
    }
    const name = sanitizeName(o.name, this.config.defaultName, this.config.nameMaxLength);
    const p = this._makePlayer(id, name, team);
    this.entities.set(id, p);
    this.recomputeScaling();
    if (first) this.startRound();
    else this._resetPlayer(p);
    return p;
  }

  /** Change a human's display name (sanitized). Returns the new name, or null for an unknown player. */
  renamePlayer(id, raw) {
    const e = this.entities.get(id);
    if (!e || e.kind !== 'player') return null;
    e.name = sanitizeName(raw, this.config.defaultName, this.config.nameMaxLength);
    return e.name;
  }

  removePlayer(id) {
    const e = this.entities.get(id);
    if (!e || e.kind !== 'player') return;
    dropCarried(this, e, 'left');
    this.entities.delete(id);
    if (this.humans().length === 0) this._resetToLobby();
    else this.recomputeScaling();
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
      plantQueue: [], // pending planting attempts (plantOrder index + 1)
      plantSeqSeen: 0, // highest client plantSeq applied
      buildQueue: [], // pending build attempts { kind, gx, gz, rot }
      buildSeqSeen: 0, // highest client buildSeq applied
      brains: team === 'zombie' ? c.brains.start : undefined, // zombie kids' currency for forts
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
      y: terrainHeight(x, z),
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
    if (e.kind === 'player') {
      e.plantQueue.length = 0;
      e.buildQueue.length = 0;
    }
    e.usePressed = false;
    e.dropPressed = false;
    e.upgradePressed = false;
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
    p.y = terrainHeight(s.x, s.z);
    p.z = s.z;
    p.vy = 0;
    p.grounded = false;
    p.hp = p.maxHp;
    p.state = 'alive';
    p.timer = 0;
    p.slowTimer = 0;
    p.slowFactor = 1;
    p.carry = undefined;
    p.carryLock = 0;
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
    p.brains = p.team === 'zombie' ? this.config.brains.start : undefined;
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
    if (raw.upgrade !== undefined) {
      const up = Boolean(raw.upgrade);
      if (up && !inp.upgrade) e.upgradePressed = true;
      inp.upgrade = up;
    }
    if (Number.isInteger(raw.plant) && raw.plant >= 0 && raw.plant <= this.plantOrder.length) {
      if (Number.isSafeInteger(raw.plantSeq) && raw.plantSeq >= 0) {
        // Sequenced planting: every press carries a higher plantSeq, so repeated presses of the same
        // key are never merged. Resent or out-of-order numbers are ignored.
        if (raw.plantSeq > e.plantSeqSeen) {
          e.plantSeqSeen = raw.plantSeq;
          if (raw.plant !== 0) this._queuePlant(e, raw.plant);
        }
      } else if (raw.plantSeq === undefined && raw.plant !== 0 && inp.plant === 0) {
        // Legacy clients: planting is edge-triggered, 0 -> n queues one attempt.
        this._queuePlant(e, raw.plant);
      }
      inp.plant = raw.plant;
    }
    // Building: build = 1-based index into the team's list (0 = none), bx / bz = grid cell of the footprint's min corner, br = rotated.
    // Every press carries a higher buildSeq, like planting.
    if (Number.isInteger(raw.build) && raw.build >= 0 && raw.build <= 8 && Number.isSafeInteger(raw.buildSeq) && raw.buildSeq >= 0) {
      if (raw.buildSeq > e.buildSeqSeen) {
        e.buildSeqSeen = raw.buildSeq;
        if (raw.build !== 0 && Number.isInteger(raw.bx) && Number.isInteger(raw.bz) && e.buildQueue.length < MAX_BUILD_QUEUE) {
          e.buildQueue.push({ kind: raw.build, gx: raw.bx, gz: raw.bz, rot: raw.br ? 1 : 0 });
        }
      }
    }
    if (typeof raw.yaw === 'number' && Number.isFinite(raw.yaw)) e.yaw = wrapAngle(raw.yaw);
    if (typeof raw.pitch === 'number' && Number.isFinite(raw.pitch)) {
      const lim = this.config.pitchLimit;
      e.pitch = clamp(raw.pitch, -lim, lim);
    }
    if (Number.isInteger(raw.seq)) {
      e.seq = raw.seq;
      e.seqTick = this.tickN;
    }
  }

  // ---- simulation ------------------------------------------------------------

  tick(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, this.config.maxDt);
    this.time += dt;
    this.tickN++;
    if (this.phase === 'lobby') return;
    if (this.phase === 'playing') {
      this.roundTime += dt;
      if (this.headStart > 0) {
        this.headStart = Math.max(0, this.headStart - dt);
        if (this.headStart === 0) this.emit('release');
      }
      stepBots(this, dt);
      this._stepActors(dt);
      stepRepair(this, dt);
      stepParts(this);
      stepMower(this, dt);
      stepEquipment(this, dt);
      stepGarden(this, dt);
      stepProjectiles(this, dt);
      stepSun(this, dt);
      stepFridge(this, dt);
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
        e.upgradePressed = false;
      }
    }
  }

  _stepActors(dt) {
    this._blockers = [];
    for (const e of this.entities.values()) if (e.blocks && e.state === 'alive') this._blockers.push(e);
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
        for (const n of e.plantQueue) if (this.phase === 'playing') tryPlant(this, e, this.plantOrder[n - 1]);
        e.plantQueue.length = 0;
      }
      if (e.upgradePressed && this.phase === 'playing') tryUpgrade(this, e);
      if (e.buildQueue?.length) {
        for (const q of e.buildQueue) if (this.phase === 'playing') tryBuild(this, e, q.kind, q.gx, q.gz, q.rot);
        e.buildQueue.length = 0;
      }
    }
  }

  /** Zombie kids earn brains for hitting plant-side things (at most once per `gap` s per target). */
  awardBrains(attacker, targetId, amount = this.config.brains.perHit, throttle = true) {
    if (!attacker || attacker.kind !== 'player' || attacker.team !== 'zombie' || attacker.brains === undefined) return;
    const b = this.config.brains;
    if (throttle) {
      const seen = (attacker.brainAt ??= new Map());
      if ((seen.get(targetId) ?? -Infinity) > this.time - b.gap) return;
      seen.set(targetId, this.time);
      if (seen.size > 200) seen.clear();
    }
    attacker.brains = Math.min(b.max, attacker.brains + amount);
  }

  /** A door or build took a hit (cover.js): zombie kids earn brains from plant-owned pieces. */
  onPieceHit(piece, amount, attacker) {
    if (piece.team === 'plant') this.awardBrains(attacker, piece.id);
  }

  /** A build piece was destroyed (cover.js): a pot takes its plant with it. */
  onBuildGone(piece, attacker) {
    if (piece.build?.kind === 'pot') potGone(this, piece, attacker);
  }

  /** The build list a player picks from. */
  buildListFor(p) {
    return buildList(this.config, p.team);
  }

  _stepWeapon(e, dt) {
    const w = getWeapon(e.weapon);
    e.cooldown -= dt;
    if (!w || !e.input.fire || this.phase !== 'playing' || this.isHeld(e) || this.isDriving(e) || e.item) {
      if (e.cooldown < 0) e.cooldown = 0;
      return;
    }
    if (e.cooldown <= 0) {
      fireWeapon(this, e);
      e.cooldown += 1 / (w.rate * (e.fireScale ?? 1));
    }
  }

  /** Zombies wait in the gate pen while the plants have their head start: no shooting, no walking out. */
  isHeld(e) {
    return this.headStart > 0 && e.team === 'zombie';
  }

  isDriving(e) {
    const m = this.mower;
    return Boolean(m && m.state === 'driving' && m.driver === e.id);
  }

  moveSpeedFor(e) {
    const c = this.config;
    let speed;
    if (this.isDriving(e)) speed = c.mowerSpeed * (e.kind === 'bot' ? c.botMowerSpeedScale : 1);
    else if (e.kind === 'bot') speed = e.team === 'zombie' ? c.zombieBotSpeed * (this.zombieLevel().speedScale ?? 1) : this.gardenerConfig().speed;
    else speed = c.moveSpeed;
    if (e.slowTimer > 0) speed *= e.slowFactor ?? 0.5;
    if (e.item) speed *= c.equipment[e.item]?.speedScale ?? 1;
    return speed;
  }

  _moveActor(e, dt) {
    walkerStep(e, e.input.keys, dt, {
      field: this.field,
      speed: this.moveSpeedFor(e),
      jumpSpeed: this.config.jumpSpeed,
      gravity: this.config.gravity,
      pen: this.isHeld(e) ? WORLD.pen : null,
      blockers: this._blockers,
    });
  }

  // ---- queries ---------------------------------------------------------------

  gardenCount() {
    let n = 0;
    for (const e of this.entities.values()) if (e.kind === 'garden') n++;
    return n;
  }

  /** Static-map changes since the round began (for late joiners and reconnects): broken pieces, damage, builds. */
  mapState() {
    return this.cover.mapState();
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
    if (e.kind === 'player') {
      // what the owner's client needs to predict its own walking (client/predict.js): how many ticks ago the echoed input
      // arrived, the fall speed while airborne, the slow factor while slowed
      if (e.seqTick !== undefined) o.seqTicks = this.tickN - e.seqTick;
      if (e.grounded === false) o.vy = round(e.vy, 2);
      if (e.slowTimer > 0) o.slow = round(e.slowFactor ?? 0.5, 2);
    }
    if (e.using) o.using = true;
    if (e.kind === 'mower') o.parts = partsMask(e.parts);
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
      round: this.cover.round,
      headStart: round(this.headStart, 1),
      fridge: { m: round(this.fridge.meter, 3), n: this.fridge.n },
      doors: this.cover.doorHps(), // HP of front, side, back, garage (0 = broken)
      doorMax: this.cover.doorMaxes(), // their full HP (the level can toughen them)
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
