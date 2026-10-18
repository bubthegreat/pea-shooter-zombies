// WebSocket client + snapshot interpolation.
//
// Snapshots arrive at ~20 Hz. We keep a short history and render other entities ~100 ms in
// the past so there are always two snapshots to blend between. Our own entity is rendered
// closer to "now" (about one snapshot behind) to keep aiming responsive.

const MAX_BUF = 40;
const lerp = (a, b, k) => a + (b - a) * k;

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
    this.buf = []; // { vt, recv, snap, map }
    this.interval = 50; // ms between snapshots (EMA)
    this.lastRecv = 0;
    this.handlers = { open: [], close: [], welcome: [], snap: [], msg: [] };
    this.reconnectTimer = null;
    this.wantOpen = true;
    this.latest = null;
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
    this.lastRecv = 0;
  }

  _onSnap(snap) {
    const now = performance.now();
    const entities = Array.isArray(snap.entities) ? snap.entities : [];
    const map = new Map();
    for (const e of entities) {
      if (e && typeof e === 'object' && e.id !== undefined && e.id !== null) map.set(String(e.id), e);
    }
    let vt = now;
    const last = this.buf[this.buf.length - 1];
    if (last) {
      const gap = now - this.lastRecv;
      this.interval += (Math.min(250, Math.max(10, gap)) - this.interval) * 0.05;
      const expected = last.vt + this.interval;
      vt = expected + (now - expected) * 0.12;
      if (Math.abs(now - vt) > 300) vt = now;
      if (vt <= last.vt) vt = last.vt + 1;
    }
    this.lastRecv = now;
    const rec = { vt, recv: now, snap, map };
    this.buf.push(rec);
    if (this.buf.length > MAX_BUF) this.buf.shift();
    this.latest = rec;
    this._emit('snap', snap);
  }

  /** Index pair bracketing time t (in the virtual timeline). */
  _bracket(t) {
    const b = this.buf;
    if (!b.length) return null;
    if (t <= b[0].vt) return { a: b[0], b: b[0], k: 0 };
    for (let i = b.length - 1; i > 0; i--) {
      if (b[i - 1].vt <= t) {
        const A = b[i - 1], B = b[i];
        if (t >= B.vt) return { a: B, b: B, k: 1 };
        return { a: A, b: B, k: (t - A.vt) / Math.max(1, B.vt - A.vt) };
      }
    }
    return { a: b[0], b: b[0], k: 0 };
  }

  static blend(ea, eb, k) {
    const o = Object.assign({}, eb);
    if (ea && ea !== eb) {
      if (isNum(ea.x) && isNum(eb.x)) o.x = lerp(ea.x, eb.x, k);
      if (isNum(ea.y) && isNum(eb.y)) o.y = lerp(ea.y, eb.y, k);
      if (isNum(ea.z) && isNum(eb.z)) o.z = lerp(ea.z, eb.z, k);
      if (isNum(ea.yaw) && isNum(eb.yaw)) o.yaw = lerpAngle(ea.yaw, eb.yaw, k);
      if (isNum(ea.pitch) && isNum(eb.pitch)) o.pitch = lerp(ea.pitch, eb.pitch, k);
    }
    return o;
  }

  /**
   * Interpolated world for rendering.
   * Returns null before the first snapshot; otherwise
   * { snap (latest raw snapshot), entities: Map<id, entity>, self: entity|null }.
   */
  view(now, selfId, delay = 100, selfDelay = 50) {
    if (!this.latest) return null;
    const br = this._bracket(now - delay);
    const entities = new Map();
    for (const [id, eb] of br.b.map) {
      const ea = br.a.map.get(id);
      entities.set(id, Net.blend(ea, eb, br.k));
    }
    let self = null;
    if (selfId !== null && selfId !== undefined) {
      const sid = String(selfId);
      const bs = this._bracket(now - selfDelay);
      const eb = bs.b.map.get(sid);
      if (eb) self = Net.blend(bs.a.map.get(sid), eb, bs.k);
      else {
        // not in the bracketed snapshot (just joined / removed): fall back to newest
        const le = this.latest.map.get(sid);
        if (le) self = Object.assign({}, le);
      }
      if (self) entities.set(sid, self);
      else entities.delete(sid);
    }
    return { snap: this.latest.snap, entities, self };
  }
}
