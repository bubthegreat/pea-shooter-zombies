// WebSocket client + snapshot interpolation.
//
// Every snapshot carries the server's sim clock in milliseconds (`snap.time`). We keep a short history keyed by that clock and
// render the world a little in the past, on a render clock that runs at wall-clock speed:
//
//   offset  = how far the client clock is ahead of the sim clock: a robust (low-envelope) estimate of `arrival - snap.time`,
//             so one late packet does not move it; it follows real drift slowly and drops to a faster path at once.
//   lag     = how far behind the newest data we render: max(100 ms, 2.5 x snapshot interval + jitter), where jitter is how
//             late snapshots arrive on top of the offset (fast attack, slow decay).
//   render  = the render clock. It chases (now - offset - lag) with a bounded slew, so a change of offset or lag speeds
//             it up or slows it down by a few percent instead of jumping.
//
// Entities are placed by bracketing the render clock between two snapshots (so unevenly spaced snapshots cost nothing: the
// positions are interpolated against the sim clock, not against arrival times). If the render clock runs past the newest
// snapshot (a late packet) entities keep going on their last velocity for up to EXTRAP_MS, then hold.
// Snapshots arrive as deltas (shared/snapcodec.js) and are rebuilt into whole ones first.
// Our own entity is normally placed by the client-side prediction (predict.js); `view().self` carries the newest server state
// and, without a predictor, an interpolated position a short way behind.

import { SnapDecoder } from '../shared/snapcodec.js';

const MAX_BUF = 60;
export const MIN_LAG = 100; // ms behind the newest data, at least
export const EXTRAP_MS = 100; // how long a late stream keeps moving on its last velocity
const EXTRAP_MAX_M = 3; // ...and never further than this
const TELEPORT_M = 10; // a jump this big between two snapshots is a respawn, not a velocity
const MAX_LAG = 450;
const SLEW_SLOWER = 0.1; // render clock may run up to 10 % slower than wall time (the lag grows) ...
const SLEW_FASTER = 0.03; // ... and up to 3 % faster (the lag shrinks)
const RESYNC_MS = 600; // render clock further than this from where it should be: jump

const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function lerpAngle(a, b, k) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export class Net {
  constructor() {
    this.ws = null;
    this.open = false;
    this.id = null;
    this.config = {};
    this.buf = []; // { st (sim ms), recv, snap, map }
    this.handlers = { open: [], close: [], welcome: [], snap: [], msg: [] };
    this.reconnectTimer = null;
    this.wantOpen = true;
    this.latest = null;
    this.decoder = new SnapDecoder();
    this._scratch = { a: null, b: null, k: 0 };
    this._pool = new Map(); // id -> { o (the object handed out), src (the snapshot entity it was filled from), seen }
    this._viewFrame = 0;
    this._entities = new Map();
    this._selfPool = { o: null, src: null };
    this._out = { snap: null, entities: this._entities, self: null };
    this.reset();
  }

  on(type, fn) {
    this.handlers[type].push(fn);
    return this;
  }

  _emit(type, arg) {
    for (const fn of this.handlers[type]) {
      try { fn(arg); } catch (err) { console.error('net handler error', type, err); }
    }
  }

  connect() {
    this.wantOpen = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(this.reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}`);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.open = true;
      this._emit('open');
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'welcome') {
        this.id = msg.id;
        this.config = msg.config || {};
        this.reset();
        this._emit('welcome', msg);
      } else if (msg.t === 'snap') {
        this._onSnap(msg);
      } else {
        this._emit('msg', msg);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.open = false;
      this.ws = null;
      this.id = null;
      this.reset();
      this._emit('close');
      if (this.wantOpen) this._scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 1500);
  }

  /** Drop the connection and open a fresh one (used by "change team"). */
  restart() {
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    this.id = null;
    this.reset();
    if (ws) { try { ws.close(); } catch (_) { /* ignore */ } }
    this._emit('close');
    this.connect();
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch (_) { /* ignore */ }
      return true;
    }
    return false;
  }

  reset() {
    this.buf.length = 0;
    this.latest = null;
    this.decoder?.reset();
    this.interval = 1000 / 30; // sim ms between snapshots (EMA)
    this.offset = null; // client ms minus sim ms
    this.jitter = 0; // ms
    this.lagTarget = MIN_LAG; // ms the render clock aims to stay behind the newest data
    this.render = null; // render clock, sim ms
    this._viewAt = 0;
    this._pool?.clear();
  }

  /** Where the render clock wants to be at client time `now` (sim ms). */
  _wantedRender(now) {
    return now - this.offset - this.lagTarget;
  }

  /** How far behind the newest data the render clock is at client time `now` (ms). */
  lag(now = performance.now()) {
    if (this.offset === null || this.render === null) return MIN_LAG;
    return now - this.offset - this.render;
  }

  /** Client time at which the render clock reaches sim time `st`: when a server event stamped `st` should show. */
  dueAt(st, now = performance.now()) {
    if (this.offset === null || !isNum(st)) return now;
    return st + this.offset + this.lag(now);
  }

  _onSnap(snap, now = performance.now()) {
    if (!this.decoder.apply(snap)) return; // a delta with no picture to land on: wait for the next full one
    const entities = Array.isArray(snap.entities) ? snap.entities : [];
    const map = new Map();
    for (const e of entities) {
      if (e && typeof e === 'object' && e.id !== undefined && e.id !== null) map.set(String(e.id), e);
    }
    let last = this.buf[this.buf.length - 1];
    let st = snap.time;
    if (!isNum(st)) st = last ? last.st + this.interval : 0; // no sim clock: assume an even cadence
    if (last && st <= last.st) {
      if (st > last.st - 500) return; // a straggler / duplicate: the stream is in order, so drop it
      this.buf.length = 0; // the sim clock restarted (a new game on the same socket): start a fresh timeline
      this.latest = null;
      this.offset = null;
      this.render = null;
      this.lagTarget = MIN_LAG;
      last = undefined;
    }
    const sample = now - st;
    if (this.offset === null) {
      this.offset = sample;
      this.jitter = 0;
    } else {
      this.interval += (clamp(st - last.st, 10, 250) - this.interval) * 0.02;
      if (sample < this.offset) this.offset += (sample - this.offset) * 0.5; // packets got faster: follow quickly
      else this.offset += (sample - this.offset) * 0.004; // slower: this is jitter, only real drift sticks
      const late = Math.max(0, sample - this.offset);
      this.jitter += (late - this.jitter) * (late > this.jitter ? 0.3 : 0.02);
    }
    // the lag target grows quickly (a stall is coming) and shrinks slowly
    const want = clamp(Math.max(MIN_LAG, 2.5 * this.interval + this.jitter), MIN_LAG, MAX_LAG);
    this.lagTarget += (want - this.lagTarget) * (want > this.lagTarget ? 0.25 : 0.01);
    const rec = { st, recv: now, snap, map };
    this.buf.push(rec);
    if (this.buf.length > MAX_BUF) this.buf.shift();
    this.latest = rec;
    this._emit('snap', snap);
  }

  /** Snapshot pair bracketing sim time t: { a, b, k } with k in 0..1, or k > 1 past `b` (extrapolation, bounded by the caller). */
  _bracket(t) {
    const b = this.buf;
    const out = this._scratch;
    if (!b.length) return null;
    const n = b.length;
    if (t <= b[0].st) {
      out.a = out.b = b[0];
      out.k = 0;
      return out;
    }
    if (t >= b[n - 1].st) {
      const B = b[n - 1];
      if (n < 2) {
        out.a = out.b = B;
        out.k = 1;
        return out;
      }
      const A = b[n - 2];
      out.a = A;
      out.b = B;
      out.k = 1 + Math.min(t - B.st, EXTRAP_MS) / Math.max(1, B.st - A.st);
      return out;
    }
    for (let i = n - 1; i > 0; i--) {
      if (b[i - 1].st <= t) {
        out.a = b[i - 1];
        out.b = b[i];
        out.k = (t - b[i - 1].st) / Math.max(1, b[i].st - b[i - 1].st);
        return out;
      }
    }
    out.a = out.b = b[0];
    out.k = 0;
    return out;
  }

  /** Make slot.o (kept between frames) a copy of entity `src`; cheap when `src` is the same object as last time. */
  static _copy(slot, src) {
    let o = slot.o;
    if (slot.src === src && o) return o;
    if (!o) o = slot.o = {};
    else for (const key in o) if (!(key in src)) delete o[key];
    for (const key in src) o[key] = src[key];
    slot.src = src;
    return o;
  }

  /** Set o's position and angles to the blend of ea -> eb at k (k > 1 extrapolates, bounded). */
  static _place(o, ea, eb, k) {
    if (ea && ea !== eb) {
      let kk = k;
      if (kk > 1) {
        // extrapolating: never run off on a teleport (respawn) or further than a few metres
        const run = Math.hypot(eb.x - ea.x, eb.z - ea.z);
        if (!(run < TELEPORT_M)) kk = 1;
        else if (run * (kk - 1) > EXTRAP_MAX_M) kk = 1 + EXTRAP_MAX_M / run;
      }
      o.x = isNum(ea.x) && isNum(eb.x) ? lerp(ea.x, eb.x, kk) : eb.x;
      o.y = isNum(ea.y) && isNum(eb.y) ? lerp(ea.y, eb.y, kk) : eb.y;
      o.z = isNum(ea.z) && isNum(eb.z) ? lerp(ea.z, eb.z, kk) : eb.z;
      o.yaw = isNum(ea.yaw) && isNum(eb.yaw) ? lerpAngle(ea.yaw, eb.yaw, Math.min(kk, 1.5)) : eb.yaw;
      o.pitch = isNum(ea.pitch) && isNum(eb.pitch) ? lerp(ea.pitch, eb.pitch, Math.min(kk, 1.5)) : eb.pitch;
    } else {
      o.x = eb.x;
      o.y = eb.y;
      o.z = eb.z;
      o.yaw = eb.yaw;
      o.pitch = eb.pitch;
    }
    return o;
  }

  /** Plain blended copy of two entity states (used by tests and tools). */
  static blend(ea, eb, k) {
    return Net._place(Net._copy({ o: null, src: null }, eb), ea, eb, k);
  }

  /** Advance the render clock to client time `now`. */
  _advance(now) {
    const want = this._wantedRender(now);
    if (this.render === null || now - this._viewAt > 1000 || Math.abs(want - this.render) > RESYNC_MS) {
      this.render = want;
    } else {
      const dt = clamp(now - this._viewAt, 0, 100);
      this.render += dt;
      const err = want - this.render;
      const lim = dt * (err < 0 ? SLEW_SLOWER : SLEW_FASTER);
      this.render += clamp(err, -lim, lim);
    }
    this._viewAt = now;
  }

  /**
   * Interpolated world for rendering.
   * Returns null before the first snapshot; otherwise
   * { snap (latest raw snapshot), entities: Map<id, entity>, self: entity|null }.
   * The returned containers and entity objects are reused from frame to frame (valid until the next call).
   * `self` is our newest server state; unless the caller places it (client-side prediction), its position is interpolated
   * `selfLag` ms behind the newest data.
   */
  view(now, selfId, selfLag = 45) {
    if (!this.latest) return null;
    this._advance(now);
    const br = this._bracket(this.render);
    const entities = this._entities;
    entities.clear();
    const frame = ++this._viewFrame;
    for (const [id, eb] of br.b.map) {
      let slot = this._pool.get(id);
      if (!slot) {
        slot = { o: null, src: null, seen: 0 };
        this._pool.set(id, slot);
      }
      slot.seen = frame;
      entities.set(id, Net._place(Net._copy(slot, eb), br.a.map.get(id), eb, br.k));
    }
    if (this._pool.size > entities.size) for (const [id, slot] of this._pool) if (slot.seen !== frame) this._pool.delete(id);
    let self = null;
    if (selfId !== null && selfId !== undefined) {
      const sid = String(selfId);
      const newest = this.latest.map.get(sid);
      if (newest) {
        // everything but the position is the newest we know (hit points, sunshine, seq...); the position a short way behind
        self = Net._copy(this._selfPool, newest);
        const bs = this._bracket(Math.min(now - this.offset - selfLag, this.latest.st));
        const eb = bs.b.map.get(sid) || newest;
        Net._place(self, bs.a.map.get(sid), eb, Math.min(bs.k, 1));
      }
      if (self) entities.set(sid, self);
      else entities.delete(sid);
    }
    const out = this._out;
    out.snap = this.latest.snap;
    out.self = self;
    return out;
  }
}
