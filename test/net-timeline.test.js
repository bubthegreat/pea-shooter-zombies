import test from 'node:test';
import assert from 'node:assert/strict';
import { Net } from '../client/net.js';
import { mulberry32 } from './helpers.js';

const V = 4; // m/s

/**
 * Feed a 20 s stream of snapshots of one entity moving at V m/s into a Net and render at 60 fps. `cadence(i)` = sim ms of
 * snapshot i, `late(i)` = ms its arrival is delayed. Returns the per-frame rendered speeds (after a 3 s warm-up).
 */
function run({ cadence, late = () => 0, selfId = null }) {
  const net = new Net();
  const snaps = [];
  for (let i = 1; cadence(i) < 20000; i++) snaps.push(cadence(i));
  const arr = snaps.map((s, i) => 1000 + s + late(i));
  let si = 0;
  let prev = null;
  const speeds = [];
  const xs = [];
  for (let f = 1000; f < 20000; f += 1000 / 60) {
    while (si < snaps.length && arr[si] <= f) {
      net._onSnap({ time: snaps[si], entities: [{ id: 'z', kind: 'bot', x: (V * snaps[si]) / 1000, y: 0, z: 0, yaw: 0 }] }, arr[si]);
      si++;
    }
    const v = net.view(f, selfId);
    if (!v) continue;
    const x = v.entities.get('z').x;
    xs.push(x);
    if (prev !== null && f > 4000) speeds.push(((x - prev) * 60));
    prev = x;
  }
  return { speeds, xs, net };
}

const spread = (a) => ({ min: Math.min(...a), max: Math.max(...a) });

test('entities move at a steady speed whatever the snapshot cadence (33/67 ms or even)', () => {
  // 20 Hz from 30 Hz ticks: sim times 33, 67, 100, 133 ... (gaps alternate 33 / 67)
  const uneven = (i) => Math.round(Math.ceil(i * 1.5) * (1000 / 30));
  const even = (i) => Math.round(i * (1000 / 30));
  for (const [name, cadence] of [['uneven', uneven], ['even', even]]) {
    const rnd = mulberry32(5);
    const { speeds } = run({ cadence, late: () => (rnd() - 0.5) * 12 });
    const s = spread(speeds);
    assert.ok(s.min > V * 0.9 && s.max < V * 1.1, `${name}: rendered speed ${s.min.toFixed(2)}..${s.max.toFixed(2)} for ${V}`);
  }
});

test('a 120 ms hiccup does not freeze the picture, and it does not run away either', () => {
  const even = (i) => Math.round(i * (1000 / 30));
  const { speeds, xs } = run({ cadence: even, late: (i) => (i % 100 === 50 ? 120 : 0) });
  const stalled = speeds.filter((s) => s < V * 0.1).length;
  assert.equal(stalled, 0, 'frames that stood still');
  assert.ok(Math.max(...speeds) < V * 1.15, `fastest ${Math.max(...speeds).toFixed(2)}`);
  assert.ok(xs.every(Number.isFinite));
});

test('past the newest snapshot an entity carries on for 100 ms, then holds', () => {
  const net = new Net();
  for (let i = 1; i <= 10; i++) net._onSnap({ time: i * 33, entities: [{ id: 'z', kind: 'bot', x: i * 0.132, y: 0, z: 0, yaw: 0 }] }, 1000 + i * 33);
  let x1 = null;
  let x2 = null;
  net.view(1400, null);
  x1 = net.view(1400 + 16, null).entities.get('z').x;
  // jump the clock far ahead with no new data
  for (let t = 1500; t < 3000; t += 16) x2 = net.view(t, null).entities.get('z').x;
  const last = 10 * 0.132;
  assert.ok(x1 <= last + 0.0001 + 0.5);
  assert.ok(x2 <= last + 4 * 0.1 + 0.02, `bounded extrapolation: ${x2} vs ${last}`);
  assert.ok(x2 >= last, 'it did not go backwards');
  const again = net.view(3016, null).entities.get('z').x;
  assert.equal(again, x2, 'and then it holds');
});

test('view() hands out reused containers and tracks entities coming and going; self takes the newest non-position state', () => {
  const net = new Net();
  net._onSnap({ time: 1000, entities: [{ id: 'a', kind: 'player', x: 0, y: 0, z: 0, yaw: 0, hp: 100, seq: 1 }, { id: 'b', kind: 'bot', x: 5, y: 0, z: 0, yaw: 0 }] }, 5000);
  net._onSnap({ time: 1033, entities: [{ id: 'a', kind: 'player', x: 0.2, y: 0, z: 0, yaw: 0, hp: 90, seq: 2 }] }, 5033);
  const v1 = net.view(5200, 'a');
  assert.equal(v1.self.hp, 90);
  assert.equal(v1.self.seq, 2);
  assert.ok(v1.entities.has('a'));
  const v2 = net.view(5216, 'a');
  assert.equal(v1, v2, 'the same container');
  net._onSnap({ time: 1066, entities: [{ id: 'a', kind: 'player', x: 0.4, y: 0, z: 0, yaw: 0, hp: 90, seq: 3 }, { id: 'c', kind: 'bot', x: 1, y: 0, z: 0, yaw: 0 }] }, 5066);
  const v3 = net.view(5300, 'a');
  assert.ok(v3.entities.has('c'));
  assert.ok(!v3.entities.has('b'));
});

test('a sim clock that restarts (new game on the same socket) starts a new timeline', () => {
  const net = new Net();
  for (let i = 1; i <= 5; i++) net._onSnap({ time: 10000 + i * 33, entities: [{ id: 'z', kind: 'bot', x: 9, y: 0, z: 0, yaw: 0 }] }, 1000 + i * 33);
  net._onSnap({ time: 33, entities: [{ id: 'z', kind: 'bot', x: 1, y: 0, z: 0, yaw: 0 }] }, 5000);
  net._onSnap({ time: 66, entities: [{ id: 'z', kind: 'bot', x: 1, y: 0, z: 0, yaw: 0 }] }, 5033);
  const v = net.view(5300, null);
  assert.equal(v.entities.get('z').x, 1);
  // a duplicate / straggler is ignored
  net._onSnap({ time: 60, entities: [] }, 5040);
  assert.equal(net.buf.length, 2);
});
