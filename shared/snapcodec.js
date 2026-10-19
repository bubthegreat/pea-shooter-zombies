// Snapshot delta coding. A snapshot used to repeat every entity in full, 20-30 times a second, although most of what is in it (kind,
// team, a rack tool that sits there, a plant that is not hurt) never changes. The server's SnapEncoder sends a FULL snapshot now and
// then (and whenever somebody joins) and DELTA snapshots in between; the client's SnapDecoder rebuilds the full picture from them.
// WebSocket is ordered and reliable, so a delta always lands on the picture it was cut against.
//
//   full:  { t:'snap', time, phase, ..., entities: [every entity, every field], events }            (what Game.snapshot() makes)
//   delta: { t:'snap', d:1, time, roundTime, <header fields that changed>,
//            entities: [{ id, <fields that changed>, '-': [fields that went away] }, or a whole new entity],
//            gone: [ids that left], events? }
//
// An entity that did not change is not in a delta; header fields that did not change are not in it either. After decoding, a
// delta looks exactly like a full snapshot (every entity, every header field, events: []), and entities that did not change are
// the very same objects as in the snapshot before (the interpolation buffer can compare them by identity).
// Pure: used by server/lobby.js, client/net.js and the tests.

export const FULL_EVERY = 90; // snapshots between full ones, at the very most (3 s at 30 Hz); a join forces one sooner
const HEADER = ['phase', 'round', 'headStart', 'fridge', 'doors', 'doorMax', 'winner', 'roundLength', 'wave', 'gardenCount'];

export class SnapEncoder {
  constructor() {
    this.reset();
  }

  /** Forget what the clients have: the next snapshot is a full one. */
  reset() {
    this.last = new Map(); // id -> the entity record as the clients now know it
    this.head = new Map(); // header field -> JSON the clients now have
    this.since = Infinity;
  }

  /** `snap` as made by Game.snapshot() -> the JSON to send. `full` forces a full snapshot. */
  encode(snap, full = false) {
    if (full || this.since >= FULL_EVERY) {
      this.since = 1;
      this.last = new Map();
      for (const e of snap.entities) this.last.set(e.id, e);
      this.head.clear();
      for (const k of HEADER) this.head.set(k, JSON.stringify(snap[k] ?? null));
      return JSON.stringify(snap);
    }
    this.since++;
    const out = { t: 'snap', d: 1, time: snap.time, roundTime: snap.roundTime };
    for (const k of HEADER) {
      const j = JSON.stringify(snap[k] ?? null);
      if (this.head.get(k) !== j) {
        this.head.set(k, j);
        out[k] = snap[k] ?? null;
      }
    }
    const cur = new Map();
    const list = [];
    for (const e of snap.entities) {
      cur.set(e.id, e);
      const prev = this.last.get(e.id);
      if (!prev) {
        list.push(e);
        continue;
      }
      let rec = null;
      for (const k in e) {
        if (k !== 'id' && e[k] !== prev[k]) (rec ??= { id: e.id })[k] = e[k];
      }
      let gone = null;
      for (const k in prev) if (!(k in e)) (gone ??= []).push(k);
      if (gone) (rec ??= { id: e.id })['-'] = gone;
      if (rec) list.push(rec);
    }
    let left = null;
    for (const id of this.last.keys()) if (!cur.has(id)) (left ??= []).push(id);
    this.last = cur;
    out.entities = list;
    if (left) out.gone = left;
    if (snap.events && snap.events.length) out.events = snap.events;
    return JSON.stringify(out);
  }
}

export class SnapDecoder {
  constructor() {
    this.reset();
  }

  reset() {
    this.ents = new Map();
    this.head = {};
    this.ready = false;
  }

  /**
   * Turn a received snapshot (full or delta) into a full one, in place. Returns false for a delta that has no picture to land on
   * (it cannot happen on an ordered socket that starts with a full snapshot; the caller ignores the message).
   */
  apply(msg) {
    if (!msg.d) {
      this.ents = new Map();
      if (Array.isArray(msg.entities)) for (const e of msg.entities) if (e && e.id !== undefined) this.ents.set(e.id, e);
      for (const k of HEADER) this.head[k] = msg[k];
      this.ready = true;
      return true;
    }
    if (!this.ready) return false;
    msg.d = 0;
    for (const k of HEADER) {
      if (k in msg) this.head[k] = msg[k];
      else if (this.head[k] !== undefined) msg[k] = this.head[k];
    }
    const ents = this.ents;
    if (Array.isArray(msg.entities)) {
      for (const r of msg.entities) {
        if (!r || r.id === undefined) continue;
        const prev = ents.get(r.id);
        if (!prev) {
          if (r.kind !== undefined) ents.set(r.id, r); // a new entity comes whole
          continue;
        }
        const next = Object.assign({}, prev);
        for (const k in r) if (k !== '-') next[k] = r[k];
        if (r['-']) for (const k of r['-']) delete next[k];
        ents.set(r.id, next);
      }
    }
    if (Array.isArray(msg.gone)) for (const id of msg.gone) ents.delete(id);
    delete msg.gone;
    msg.entities = [...ents.values()];
    if (!Array.isArray(msg.events)) msg.events = [];
    return true;
  }
}
