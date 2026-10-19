// Client-side prediction of our own walking.
//
// The server moves us 30 times a second from the latest input it has received, so by the time a snapshot tells us where we
// are, the picture is a round trip old. Instead of showing that, every frame we walk our own body with the SAME code the server
// uses (shared/walker.js + shared/field.js, over the map from the welcome message): the camera answers the keys at once.
//
// Reconciliation, on every new snapshot:
//   A snapshot holds the server position S at sim time `snap.time`. Which of our own (client) moments is that? The player entity
//   carries `seq` (the newest input applied) and `seqTicks` (for how many ticks), so the input took effect at sim time
//   `snap.time - seqTicks * tick` and we know when we sent it: that pairs a sim time with a client time. Averaged over many inputs
//   (clockOffset) the pairing is steady to a few ms; it needs no arrival times at all, so network jitter cannot move it, and tick
//   quantisation (an input applied for 2 ticks, the next skipped) averages out instead of showing as steps. S belongs to client time
//   t0 = snap.time - clockOffset. We replay the frames walked since t0 on top of S -> R, where the server thinks we are "now".
//   The difference R - P is the correction; most of it (CORRECT) is applied to P and hidden by a render offset that fades out in
//   OFFSET_TAU seconds, so a correction is never a visible pop. Past SNAP_DIST (a respawn, a push by something we do not model)
//   we just jump.
//
// Pure (no DOM, no three.js): test/predict.test.js drives it against a real Game over a simulated laggy network.
import { Field } from '../shared/field.js';
import { walkerStep } from '../shared/walker.js';

const CORRECT = 0.3; // share of the error taken per snapshot
const OFFSET_TAU = 0.12; // s: how fast the render offset fades
const SNAP_DIST = 2.0; // m: further than this is not a correction but a teleport
const LOG_MS = 2500; // how much walked history is kept for replay
const MAX_STEP = 1 / 30; // a long frame is walked in steps no longer than a server tick
const STATS_KEEP = 2000;

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The collision field for the map as it stands now: static walls plus the doors, cover and builds still up. */
export function buildField(map) {
  const f = new Field(map.bounds, (x, z) => map.groundHeight(x, z));
  for (const c of map.statics) f.add({ ...c });
  for (const p of map.cover.values()) if (p.alive) f.add({ ...p.def });
  for (const p of map.doors.values()) if (p.alive) f.add({ ...p.def });
  for (const b of map.placed.values()) {
    if (b.alive) f.add({ s: 'box', minX: b.x, maxX: b.x + b.w, minZ: b.z, maxZ: b.z + b.d, y0: b.y0, y1: b.y1 });
  }
  return f;
}

export class Predictor {
  constructor() {
    this.map = null;
    this.cfg = null;
    this.reset();
  }

  /** Forget the body and the history (new round / new connection). The map stays. */
  reset() {
    this.gain = CORRECT;
    this.tau = OFFSET_TAU;
    this.P = null; // { x, y, z, vy, grounded, yaw, radius, height, team }
    this.alive = false; // are we walking by prediction right now?
    this.off = { x: 0, y: 0, z: 0 }; // render offset (fading correction)
    this.log = []; // walked frames: { t (end, ms), dt (s), f, b, l, r, jump, yaw }
    this.sent = []; // sent inputs: { seq, t (ms) }
    this.field = null;
    this.fieldVer = -1;
    this.blockers = [];
    this.mods = { speed: 6, pen: null };
    this.tickMs = 1000 / 30;
    this.clockOffset = null; // sim ms minus client ms, as the inputs we send pair them up
    this.clockN = 0;
    this.lastSeq = -1;
    this.stats = { errs: [], hard: 0, n: 0 };
    this._keys = { f: false, b: false, l: false, r: false, jump: false };
    this._R = { x: 0, y: 0, z: 0, vy: 0, grounded: true, yaw: 0, radius: 0.5, height: 1.8, team: 'plant' };
  }

  /** The map (MapData) and the public config (welcome.config) the prediction walks in. */
  setWorld(map, cfg) {
    this.map = map;
    this.cfg = cfg || {};
    this.tickMs = 1000 / num(this.cfg.tickRate, 30);
    this.field = null;
    this.fieldVer = -1;
    this.clockOffset = null;
    this.clockN = 0;
  }

  /** An input message with this seq just left at client time t (ms). */
  noteSent(seq, t) {
    const s = this.sent;
    s.push({ seq, t });
    while (s.length > 240) s.shift();
  }

  _env(pen = this.mods.pen) {
    const map = this.map;
    if (!this.field || this.fieldVer !== map.version) {
      this.field = buildField(map);
      this.fieldVer = map.version;
    }
    const cfg = this.cfg;
    return { field: this.field, speed: this.mods.speed, jumpSpeed: num(cfg.jumpSpeed, 6), gravity: num(cfg.gravity, 18), pen, blockers: this.blockers };
  }

  /** Speed / pen / solid plants from the newest server state. */
  _readMods(own, snap) {
    const cfg = this.cfg;
    const map = this.map;
    let speed = num(cfg.moveSpeed, 6);
    const entities = snap && Array.isArray(snap.entities) ? snap.entities : [];
    const blockers = this.blockers;
    blockers.length = 0;
    let driving = false;
    for (const e of entities) {
      if (e.kind === 'mower') {
        if (e.state === 'driving' && String(e.driver) === String(own.id)) driving = true;
      } else if (e.kind === 'garden' && e.state === 'alive') {
        const t = cfg.plantTypes && cfg.plantTypes[e.plantKind];
        // (a plant in a pot stands up on the pot, and the pot is solid already)
        if (t && t.blocks && Math.abs(num(e.y) - map.groundHeight(e.x, e.z)) < 0.25) blockers.push({ x: e.x, z: e.z, radius: num(t.radius, 0.8) });
      }
    }
    if (driving) speed = num(cfg.mowerSpeed, 7);
    if (own.slow > 0) speed *= own.slow;
    else if (own.slowed) speed *= 0.5;
    if (typeof own.item === 'string' && own.item) speed *= num(cfg.equipment && cfg.equipment[own.item] && cfg.equipment[own.item].speedScale, 1);
    this.mods.speed = speed;
    const held = num(snap && snap.headStart) > 0 && own.team === 'zombie';
    this.mods.pen = held && cfg.map ? cfg.map.pen : null;
  }

  _hardSet(own) {
    const cfg = this.cfg;
    this.P = {
      x: own.x, y: num(own.y), z: own.z, vy: own.vy === undefined ? 0 : own.vy, grounded: own.vy === undefined,
      yaw: num(own.yaw), radius: num(cfg.playerRadius, 0.5), height: num(cfg.playerHeight, 1.8), team: own.team,
    };
    this.off.x = this.off.y = this.off.z = 0;
    this.log.length = 0;
  }

  /**
   * A snapshot arrived. `own` = our entity as the server sent it (raw, newest), `snap` = that snapshot, `now` = client ms.
   * Returns the size of the correction in metres (0 when there was nothing to compare).
   */
  reconcile(own, snap, now) {
    if (!this.map || !this.cfg || !own) return 0;
    const wasAlive = this.alive;
    this._readMods(own, snap);
    if (own.state !== 'alive' || !Number.isFinite(own.x) || !Number.isFinite(own.z)) {
      // wilted / sprouting: the server moves us (or not); follow it
      this.alive = false;
      this._hardSet(own);
      return 0;
    }
    this.alive = true;
    if (!this.P || !wasAlive) {
      this._hardSet(own);
      return 0;
    }
    // pair the sim clock with ours through the input the server just acted on
    const st = num(snap && snap.time, NaN);
    if (!Number.isFinite(st)) {
      this._hardSet(own);
      return 0;
    }
    if (own.seq !== this.lastSeq) {
      this.lastSeq = own.seq;
      let sentAt = -1;
      const s = this.sent;
      for (let i = s.length - 1; i >= 0; i--) {
        if (s[i].seq === own.seq) {
          sentAt = s[i].t;
          break;
        }
      }
      if (sentAt >= 0) {
        const sample = st - num(own.seqTicks, 1) * this.tickMs - sentAt;
        this.clockN++;
        this.clockOffset = this.clockOffset === null ? sample : this.clockOffset + (sample - this.clockOffset) * Math.max(0.04, 1 / this.clockN);
      }
    }
    if (this.clockOffset === null) {
      // nothing paired yet: the server wins
      this._hardSet(own);
      this.stats.hard++;
      return 0;
    }
    const t0 = Math.min(now, st - this.clockOffset);
    // R = the server body, then walk the frames since t0 on top of it
    const R = this._R;
    R.x = own.x; R.y = num(own.y); R.z = own.z;
    R.vy = own.vy === undefined ? 0 : own.vy;
    R.grounded = own.vy === undefined;
    R.yaw = this.P.yaw;
    R.radius = this.P.radius; R.height = this.P.height; R.team = this.P.team;
    const env = this._env();
    const log = this.log;
    for (let i = 0; i < log.length; i++) {
      const fr = log[i];
      if (fr.t <= t0) continue;
      let dt = fr.dt;
      const start = fr.t - fr.dt * 1000;
      if (start < t0) dt = (fr.t - t0) / 1000;
      if (dt <= 0) continue;
      R.yaw = fr.yaw;
      this._walk(R, fr, dt, env);
    }
    const P = this.P;
    const ex = R.x - P.x;
    const ey = R.y - P.y;
    const ez = R.z - P.z;
    const err = Math.hypot(ex, ey, ez);
    const stats = this.stats;
    stats.n++;
    stats.errs.push(err);
    if (stats.errs.length > STATS_KEEP) stats.errs.shift();
    if (err > SNAP_DIST) {
      stats.hard++;
      P.x = R.x; P.y = R.y; P.z = R.z; P.vy = R.vy; P.grounded = R.grounded;
      this.off.x = this.off.y = this.off.z = 0;
      return err;
    }
    // take most of the error now, but show it fading in (render = P + off)
    const k = P.grounded === R.grounded ? this.gain : 1;
    const cx = ex * k, cy = ey * k, cz = ez * k;
    P.x += cx; P.y += cy; P.z += cz;
    this.off.x -= cx; this.off.y -= cy; this.off.z -= cz;
    if (P.grounded !== R.grounded) {
      P.vy = R.vy;
      P.grounded = R.grounded;
    }
    return err;
  }

  _walk(body, keys, dt, env) {
    // long frames are walked in server-tick sized steps, like the server would
    let left = dt;
    while (left > 1e-6) {
      const d = Math.min(left, MAX_STEP);
      walkerStep(body, keys, d, env);
      left -= d;
    }
  }

  /**
   * Walk one frame: dt seconds ending at client time `now`, with the keys and yaw held this frame.
   * Does nothing while we are not predicting (dead, nothing to compare with yet).
   */
  step(dt, now, keys, yaw) {
    if (!this.alive || !this.P || !this.map) return;
    const P = this.P;
    const k = this._keys;
    k.f = !!keys.f; k.b = !!keys.b; k.l = !!keys.l; k.r = !!keys.r; k.jump = !!keys.jump;
    P.yaw = yaw;
    this._walk(P, k, dt, this._env());
    this.log.push({ t: now, dt, f: k.f, b: k.b, l: k.l, r: k.r, jump: k.jump, yaw });
    const cut = now - LOG_MS;
    let n = 0;
    while (n < this.log.length - 1 && this.log[n].t < cut) n++;
    if (n) this.log.splice(0, n);
    const f = Math.exp(-dt / this.tau);
    const o = this.off;
    o.x *= f; o.y *= f; o.z *= f;
    if (Math.abs(o.x) + Math.abs(o.y) + Math.abs(o.z) < 1e-4) o.x = o.y = o.z = 0;
  }

  /** Put the predicted feet position (with the fading correction) into `out` (x, y, z). Returns false when not predicting. */
  place(out) {
    if (!this.alive || !this.P) return false;
    out.x = this.P.x + this.off.x;
    out.y = this.P.y + this.off.y;
    out.z = this.P.z + this.off.z;
    return true;
  }
}
