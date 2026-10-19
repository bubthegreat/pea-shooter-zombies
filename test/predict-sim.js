// A laggy-network simulation of one human walking in a real Game, used by predict.test.js (and handy for tuning).
// Not a test itself. Time runs in 0.25 ms slices; messages in each direction arrive in order after `latency` +- `jitter` ms.
import { makeGame, mulberry32 } from './helpers.js';
import { publicConfig } from '../server/sim/config.js';
import { MapData } from '../client/map.js';
import { Predictor } from '../client/predict.js';

const TICK = 1000 / 30;

/** A pile of keyboard behaviour as a pure function of time (s): hold a direction for a while, sometimes jump, turn the camera smoothly. */
export function makeScript(seed, { jumpy = true, span = 120 } = {}) {
  const rnd = mulberry32(seed);
  const dirs = [
    { f: true }, { f: true, l: true }, { f: true, r: true }, { b: true }, { l: true }, { r: true }, {}, { f: true }, { f: true },
  ];
  const segs = [];
  for (let t = 0; t < span; ) {
    const len = 0.4 + rnd() * 1.6;
    segs.push({ t0: t, t1: t + len, d: dirs[Math.floor(rnd() * dirs.length)] });
    t += len;
  }
  const jumps = [];
  if (jumpy) for (let t = 1; t < span; t += 0.8 + rnd() * 3) jumps.push(t);
  const w = [0.7 + rnd(), 1.9 + rnd(), 0.3 + rnd()];
  const ph = [rnd() * 6, rnd() * 6, rnd() * 6];
  return (t) => {
    let d = {};
    for (const sg of segs) if (t >= sg.t0 && t < sg.t1) { d = sg.d; break; }
    const jump = jumps.some((j) => t >= j && t < j + 0.12);
    const yaw = 1.6 * Math.sin(w[0] * t + ph[0]) + 0.9 * Math.sin(w[1] * t + ph[1]) + 0.5 * Math.sin(w[2] * t + ph[2]);
    return { keys: { f: !!d.f, b: !!d.b, l: !!d.l, r: !!d.r, jump }, yaw };
  };
}

/**
 * Walk for `seconds` and report. Options: latency (one way, ms), jitter (+- ms), seed, script, features (game), team, setup(game, me).
 * Returns { errs (reconcile corrections, m), frames: [{ t, x, y, z, px, py, pz }], hard, game, me }.
 */
export function simulate({ seconds = 20, latency = 40, jitter = 10, seed = 1, script = makeScript(seed), features = { cover: true }, team = 'plant', setup = null, rest = 1.5, tune = null, onTick = null } = {}) {
  const rnd = mulberry32(seed * 7919);
  const game = makeGame({ features, seed });
  const me = game.addPlayer('me', { team, mode: 'versus' });
  if (setup) setup(game, me);
  const cfg = publicConfig(game.config);
  const map = new MapData(cfg.map, cfg.builds, game.mapState(), { potRules: cfg.potRules, pots: cfg.pots, doorHp: cfg.doorHp });
  const pred = new Predictor();
  pred.setWorld(map, cfg);
  if (tune) Object.assign(pred, tune);

  const toServer = [];
  const toClient = [];
  let lastS = 0;
  let lastC = 0;
  const post = (q, last, at, msg) => {
    const arrive = Math.max(last, at + latency + (rnd() * 2 - 1) * jitter);
    q.push({ at: arrive, msg });
    return arrive;
  };

  let nextTick = TICK * (0.3 + rnd() * 0.4); // the server's phase is not the client's
  let nextFrame = 0;
  let nextSend = 5 + rnd() * 20;
  let seq = 0;
  let prevFrameAt = 0;
  let latestSnap = null;
  let snapSeen = null;
  const frames = [];
  const total = (seconds + rest) * 1000;
  let keys = { f: false, b: false, l: false, r: false, jump: false };
  let yaw = 0;
  for (let t = 0; t < total; t += 0.25) {
    // client sends (setInterval-ish)
    while (t >= nextSend) {
      const s = nextSend / 1000 < seconds ? script(nextSend / 1000) : { keys: { f: false, b: false, l: false, r: false, jump: false }, yaw };
      seq++;
      const msg = { t: 'input', seq, keys: { ...s.keys }, yaw: s.yaw, pitch: 0, fire: false };
      pred.noteSent(seq, nextSend);
      lastS = post(toServer, lastS, nextSend, msg);
      nextSend += TICK + (rnd() - 0.5) * 3;
    }
    // messages reaching the server
    while (toServer.length && toServer[0].at <= t) game.handleInput('me', toServer.shift().msg);
    // server ticks
    while (t >= nextTick) {
      if (onTick) onTick(game, nextTick / 1000);
      game.tick(1 / 30);
      const snap = game.snapshot();
      lastC = post(toClient, lastC, nextTick, snap);
      nextTick += TICK;
    }
    // snapshots reaching the client
    while (toClient.length && toClient[0].at <= t) latestSnap = toClient.shift().msg;
    // client frame
    if (t >= nextFrame) {
      const now = nextFrame;
      const dt = Math.max(0.0001, (now - prevFrameAt) / 1000);
      prevFrameAt = now;
      if (latestSnap && latestSnap !== snapSeen) {
        snapSeen = latestSnap;
        for (const ev of snapSeen.events) if (ev.type === 'coverBreak' || ev.type === 'build' || ev.type === 'doorUp' || ev.type === 'coverHit') map.onEvent(ev);
        map.setDoorHps(snapSeen.doors, snapSeen.doorMax);
        pred.reconcile(snapSeen.entities.find((e) => e.id === 'me'), snapSeen, now);
      }
      if (now / 1000 < seconds) {
        const s = script(now / 1000);
        keys = s.keys;
        yaw = s.yaw;
      } else keys = { f: false, b: false, l: false, r: false, jump: false };
      pred.step(dt, now, keys, yaw);
      const out = { x: 0, y: 0, z: 0 };
      if (pred.place(out)) {
        const sv = game.entities.get('me');
        frames.push({ t: now, x: out.x, y: out.y, z: out.z, px: pred.P.x, py: pred.P.y, pz: pred.P.z, sx: sv.x, sy: sv.y, sz: sv.z, keys: { ...keys } });
      }
      nextFrame += 1000 / 60 + (rnd() - 0.5) * 2;
    }
  }
  return { errs: pred.stats.errs, hard: pred.stats.hard, frames, game, me: game.entities.get('me'), pred };
}

export const stat = (a) => {
  const b = [...a].sort((x, y) => x - y);
  const q = (p) => b[Math.min(b.length - 1, Math.floor(b.length * p))] ?? NaN;
  return { n: b.length, mean: b.reduce((s, x) => s + x, 0) / (b.length || 1), p50: q(0.5), p95: q(0.95), max: b[b.length - 1] ?? NaN };
};
