import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapEncoder, SnapDecoder, FULL_EVERY } from '../shared/snapcodec.js';
import { makeGame, mulberry32 } from './helpers.js';

const byId = (list) => new Map(list.map((e) => [e.id, e]));

/** A busy game: humans on both sides, bots, shooting, pickups. */
function busyGame(seed = 5) {
  const game = makeGame({ seed, features: { cover: true, waves: true, botAI: true, sunDrops: true, gardener: true, headStart: true }, headStart: 1, waveFirst: 2, waveInterval: 5 });
  game.addPlayer('a', { team: 'plant', mode: 'versus', difficulty: 'hard' });
  game.addPlayer('z', { team: 'zombie' });
  return game;
}

test('a decoded delta stream equals the full snapshots, every time', () => {
  const game = busyGame();
  const enc = new SnapEncoder();
  const dec = new SnapDecoder();
  const rnd = mulberry32(3);
  let fulls = 0;
  let sentBytes = 0;
  let fullBytes = 0;
  for (let i = 0; i < 30 * 40; i++) {
    const a = game.entities.get('a');
    const z = game.entities.get('z');
    if (i % 20 === 0) {
      for (const p of [a, z]) {
        p.input.keys = { f: rnd() < 0.7, b: rnd() < 0.1, l: rnd() < 0.3, r: rnd() < 0.3, jump: rnd() < 0.1 };
        p.input.fire = rnd() < 0.6;
        p.yaw += rnd() - 0.5;
      }
    }
    game.tick(1 / 30);
    if (i % 1) continue;
    const snap = game.snapshot();
    game.drainEvents();
    const json = enc.encode(snap, false);
    const full = JSON.stringify(snap);
    sentBytes += json.length;
    fullBytes += full.length;
    const msg = JSON.parse(json);
    if (!msg.d) fulls++;
    assert.ok(dec.apply(msg), 'applies');
    const want = JSON.parse(full);
    assert.deepEqual(msg.entities.length, want.entities.length, `tick ${i}: entity count`);
    const got = byId(msg.entities);
    for (const e of want.entities) assert.deepEqual(got.get(e.id), e, `tick ${i}: ${e.id}`);
    for (const k of ['time', 'phase', 'round', 'headStart', 'fridge', 'doors', 'doorMax', 'winner', 'roundTime', 'roundLength', 'wave', 'gardenCount']) {
      assert.deepEqual(msg[k], want[k], `tick ${i}: ${k}`);
    }
    assert.deepEqual(msg.events, want.events, `tick ${i}: events`);
  }
  assert.ok(fulls >= 2 && fulls <= 1 + Math.ceil((30 * 40) / FULL_EVERY), `fulls ${fulls}`);
  assert.ok(sentBytes < fullBytes * 0.7, `${sentBytes} of ${fullBytes} bytes`);
});

test('unchanged entities are the very same objects from one decoded snapshot to the next', () => {
  const game = busyGame(9);
  const enc = new SnapEncoder();
  const dec = new SnapDecoder();
  let prev = null;
  let shared = 0;
  for (let i = 0; i < 90; i++) {
    game.tick(1 / 30);
    const snap = game.snapshot();
    game.drainEvents();
    const msg = JSON.parse(enc.encode(snap));
    dec.apply(msg);
    if (prev) {
      const was = byId(prev);
      for (const e of msg.entities) if (was.get(e.id) === e) shared++;
    }
    prev = msg.entities;
  }
  assert.ok(shared > 100, `${shared} reused objects`);
});

test('a client that joins mid-round starts from a full snapshot; a delta alone is refused', () => {
  const game = busyGame(11);
  const enc = new SnapEncoder();
  for (let i = 0; i < 40; i++) {
    game.tick(1 / 30);
    enc.encode(game.snapshot());
    game.drainEvents();
  }
  const late = new SnapDecoder();
  game.tick(1 / 30);
  const delta = JSON.parse(enc.encode(game.snapshot()));
  assert.equal(delta.d, 1);
  assert.equal(late.apply(delta), false);
  game.tick(1 / 30);
  const full = JSON.parse(enc.encode(game.snapshot(), true));
  assert.ok(!full.d);
  assert.equal(late.apply(full), true);
  game.tick(1 / 30);
  const next = JSON.parse(enc.encode(game.snapshot()));
  assert.equal(late.apply(next), true);
  assert.equal(next.entities.length, game.snapshot().entities.length);
});

test('entities that leave are gone, fields that go away are removed, entities that appear come whole', () => {
  const enc = new SnapEncoder();
  const dec = new SnapDecoder();
  const mk = (entities, extra = {}) => ({ t: 'snap', time: 1, phase: 'playing', roundTime: 1, entities, events: [], ...extra });
  const a = { id: 'a', kind: 'player', team: 'plant', x: 1, y: 0, z: 1, hp: 100, maxHp: 100, slowed: true };
  const b = { id: 'b', kind: 'bot', team: 'zombie', x: 2, y: 0, z: 2, hp: 5, maxHp: 5 };
  const s1 = JSON.parse(enc.encode(mk([a, b])));
  assert.ok(dec.apply(s1));
  const a2 = { id: 'a', kind: 'player', team: 'plant', x: 1.5, y: 0, z: 1, hp: 100, maxHp: 100 }; // slowed ended
  const c = { id: 'c', kind: 'projectile', team: 'plant', x: 0, y: 1, z: 0, hp: 1, maxHp: 1, projKind: 'pea' };
  const wire = enc.encode(mk([a2, c], { time: 34 }));
  const s2 = JSON.parse(wire);
  assert.equal(s2.d, 1);
  assert.deepEqual(s2.gone, ['b']);
  assert.ok(dec.apply(s2));
  const got = byId(s2.entities);
  assert.deepEqual(got.get('a'), a2);
  assert.ok(!('slowed' in got.get('a')));
  assert.deepEqual(got.get('c'), c);
  assert.ok(!got.has('b'));
  assert.ok(wire.length < JSON.stringify(mk([a2, c])).length);
});

test('every Nth snapshot is full, and a forced one is too', () => {
  const game = busyGame(2);
  const enc = new SnapEncoder();
  const kinds = [];
  for (let i = 0; i < FULL_EVERY * 2 + 3; i++) {
    game.tick(1 / 30);
    kinds.push(JSON.parse(enc.encode(game.snapshot(), i === 5)).d ? 'd' : 'F');
    game.drainEvents();
  }
  assert.equal(kinds[0], 'F');
  assert.equal(kinds[5], 'F', 'forced');
  assert.ok(kinds.filter((k) => k === 'F').length >= 3);
  assert.equal(kinds.filter((k) => k === 'd').length > 50, true);
});
