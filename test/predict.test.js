import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, stat, makeScript } from './predict-sim.js';
import { makeGame } from './helpers.js';
import { publicConfig } from '../server/sim/config.js';
import { MapData } from '../client/map.js';
import { buildField } from '../client/predict.js';
import { walkerStep } from '../shared/walker.js';

const finalGap = (r) => {
  const f = r.frames[r.frames.length - 1];
  return Math.hypot(f.x - f.sx, f.y - f.sy, f.z - f.sz);
};

test('prediction: walking over an 80 ms +-20 ms network stays close to the server and settles exactly', () => {
  for (const seed of [1, 2, 3]) {
    const r = simulate({ seconds: 25, latency: 80, jitter: 20, seed });
    const e = stat(r.errs);
    assert.ok(e.mean < 0.08, `seed ${seed}: mean correction ${e.mean.toFixed(3)} m`);
    assert.ok(e.p95 < 0.3, `seed ${seed}: p95 correction ${e.p95.toFixed(3)} m`);
    assert.ok(e.max < 1.0, `seed ${seed}: max correction ${e.max.toFixed(3)} m`);
    assert.ok(r.hard <= 2, `seed ${seed}: ${r.hard} hard snaps`);
    assert.ok(finalGap(r) < 0.02, `seed ${seed}: ended ${finalGap(r).toFixed(3)} m from the server`);
  }
});

test('prediction: the camera answers a key at once, not a round trip later', () => {
  const r = simulate({ seconds: 3, latency: 80, jitter: 0, seed: 4, script: (t) => ({ keys: { f: t > 1, b: false, l: false, r: false, jump: false }, yaw: 0 }), rest: 0 });
  const start = r.frames.find((f) => Math.abs(f.z - r.frames[0].z) > 0.05);
  const moved = start.t;
  assert.ok(moved < 1000 + 60, `first visible movement at ${moved.toFixed(0)} ms (key at 1000 ms)`);
  const serverFirst = r.frames.find((f) => Math.abs(f.sz - r.frames[0].sz) > 0.05).t;
  assert.ok(serverFirst > moved + 100, 'the server is a round trip behind');
});

test('prediction: a steady run has no corrections at all once the clocks are paired', () => {
  const r = simulate({ seconds: 6, latency: 50, jitter: 0, seed: 6, script: (t) => ({ keys: { f: t > 0.3, b: false, l: false, r: false, jump: false }, yaw: 0.4 }), rest: 0 });
  const tail = r.errs.slice(r.errs.length - 60, r.errs.length - 10);
  assert.ok(Math.max(...tail) < 0.05, `late corrections ${Math.max(...tail).toFixed(3)} m`);
});

test('prediction: a door the server breaks is walked through without a fight', () => {
  const r = simulate({
    seconds: 8, latency: 60, jitter: 10, seed: 7, team: 'zombie',
    setup: (g, me) => { me.x = 5; me.z = 9; me.y = 0; },
    script: (t) => ({ keys: { f: t > 0.3, b: false, l: false, r: false, jump: false }, yaw: 0 }),
    onTick: (g, t) => { if (t > 0.8 && g.cover.get('door:front').state === 'alive') g.cover.destroy(g.cover.get('door:front')); },
  });
  const f = r.frames[r.frames.length - 1];
  assert.ok(f.sz < 6, `the server walked through (z ${f.sz.toFixed(2)})`);
  assert.ok(finalGap(r) < 0.05, `and so did we, ${finalGap(r).toFixed(3)} m apart`);
  assert.ok(stat(r.errs).max < 1.5);
});

test('prediction: a wall stops us on both sides', () => {
  const r = simulate({
    seconds: 6, latency: 60, jitter: 10, seed: 8, team: 'zombie',
    setup: (g, me) => { me.x = 5; me.z = 9; me.y = 0; },
    script: (t) => ({ keys: { f: t > 0.3, b: false, l: false, r: false, jump: false }, yaw: 0 }),
  });
  const f = r.frames[r.frames.length - 1];
  assert.ok(f.sz > 6.2, `still outside the front door (z ${f.sz.toFixed(2)})`);
  assert.ok(finalGap(r) < 0.02);
});

test('prediction: a teleport (respawn) is followed at once, not slid to', () => {
  let moved = false;
  const r = simulate({
    seconds: 5, latency: 40, jitter: 5, seed: 9,
    script: (t) => ({ keys: { f: false, b: false, l: false, r: false, jump: false }, yaw: 0 }),
    onTick: (g, t) => { if (t > 2 && !moved) { moved = true; const me = g.entities.get('me'); me.x = -20; me.z = -10; me.y = 0; } },
  });
  const f = r.frames[r.frames.length - 1];
  assert.ok(Math.hypot(f.x + 20, f.z + 10) < 0.01, `now at ${f.x.toFixed(2)}, ${f.z.toFixed(2)}`);
  assert.ok(r.hard >= 1);
});

test('prediction: jumping lands where the server lands', () => {
  const r = simulate({
    seconds: 6, latency: 60, jitter: 10, seed: 10,
    script: (t) => ({ keys: { f: false, b: false, l: false, r: false, jump: (t % 1.5) < 0.1 }, yaw: 0 }),
  });
  const e = stat(r.errs);
  assert.ok(e.p95 < 0.15, `p95 ${e.p95.toFixed(3)} m`);
  assert.ok(finalGap(r) < 0.02);
});

test('the client field (built from the welcome map) walks exactly like the server field', () => {
  const game = makeGame({ features: { cover: true } });
  game.addPlayer('p', { team: 'plant', mode: 'versus' }); // starts the round: doors and cover go up
  const cfg = publicConfig(game.config);
  const map = new MapData(cfg.map, cfg.builds, game.mapState());
  const cf = buildField(map);
  const sf = game.field;
  const rnd = makeScript(11);
  let worst = 0;
  for (let run = 0; run < 12; run++) {
    const a = { x: -20 + run * 3, y: 0, z: 20 - run * 2, yaw: 0, vy: 0, grounded: true, radius: 0.5, height: 1.8, team: run % 2 ? 'zombie' : 'plant' };
    const b = { ...a };
    for (let i = 0; i < 400; i++) {
      const s = rnd(run * 13 + i / 30);
      a.yaw = b.yaw = s.yaw;
      walkerStep(a, s.keys, 1 / 30, { field: sf, speed: 6, jumpSpeed: 6, gravity: 18, pen: null, blockers: null });
      walkerStep(b, s.keys, 1 / 30, { field: cf, speed: 6, jumpSpeed: 6, gravity: 18, pen: null, blockers: null });
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.z - b.z, a.y - b.y));
    }
  }
  assert.ok(worst < 0.03, `paths drifted ${worst.toFixed(4)} m`);
});
