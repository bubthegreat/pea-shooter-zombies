import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD, gardenSlots } from '../server/sim/world.js';
import { clampToWorld } from '../server/sim/collide.js';
import { makeGame, run, keys } from './helpers.js';

test('addPlayer first sets mode and phase "playing"', () => {
  const game = makeGame();
  assert.equal(game.phase, 'lobby');
  game.addPlayer('a', { name: 'Jacob', team: 'plant', mode: 'coop', difficulty: 'easy' });
  assert.equal(game.phase, 'playing');
  assert.equal(game.mode, 'coop');
  assert.equal(game.difficulty, 'easy');
  const p = game.entities.get('a');
  assert.equal(p.kind, 'player');
  assert.equal(p.team, 'plant');
  assert.equal(p.name, 'Jacob');
  assert.equal(p.x, WORLD.plantSpawn.x);
  assert.equal(p.z, WORLD.plantSpawn.z);
  assert.equal(p.y, 0);
});

test('second player joins mid-round on chosen team; mode unchanged', () => {
  const game = makeGame();
  game.addPlayer('a', { name: 'A', team: 'plant', mode: 'coop', difficulty: 'easy' });
  run(game, 1);
  game.addPlayer('b', { name: 'B', team: 'zombie', mode: 'versus', difficulty: 'normal' });
  const b = game.entities.get('b');
  assert.equal(b.team, 'zombie');
  assert.ok(Math.abs(b.z - WORLD.gate.z) < 0.5, `zombie z=${b.z}`);
  assert.ok(b.x >= WORLD.gate.minX && b.x <= WORLD.gate.maxX);
  assert.equal(game.mode, 'coop');
  assert.equal(game.difficulty, 'easy');
  assert.equal(game.phase, 'playing');
  assert.ok(game.time > 0, 'running game was not restarted');
});

test('the sim has no human cap (lobbies enforce their own safety cap)', () => {
  const game = makeGame();
  for (let i = 0; i < 12; i++) assert.ok(game.addPlayer(`p${i}`, { team: i % 2 ? 'zombie' : 'plant' }), `player ${i}`);
  assert.equal(game.humans().length, 12);
});

test('addPlayer sanitizes name, team, mode and ignores duplicate ids', () => {
  const game = makeGame();
  const p = game.addPlayer('a', { name: '  ' + 'x'.repeat(40), team: 'banana', mode: 'chaos', difficulty: 'impossible' });
  assert.equal(p.name.length, DEFAULT_CONFIG.nameMaxLength);
  assert.equal(p.team, 'plant');
  assert.equal(game.mode, DEFAULT_CONFIG.defaultMode);
  assert.equal(game.difficulty, DEFAULT_CONFIG.defaultDifficulty);
  assert.equal(game.addPlayer('a', { team: 'zombie' }), p, 'duplicate id returns existing entity');
  assert.equal(game.entities.get('a').team, 'plant');
  const q = game.addPlayer('b', { name: 42, team: 'zombie' });
  assert.equal(q.name, DEFAULT_CONFIG.defaultName);
});

test('movement: forward for 1 s moves ~moveSpeed toward -z', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const z0 = game.entities.get('a').z;
  game.handleInput('a', { seq: 1, keys: keys({ f: true }), yaw: 0, pitch: 0 });
  run(game, 1);
  const p = game.entities.get('a');
  assert.ok(Math.abs(z0 - p.z - DEFAULT_CONFIG.moveSpeed) <= 0.5, `moved ${z0 - p.z}`);
  assert.ok(Math.abs(p.x - WORLD.plantSpawn.x) < 0.01);
  assert.equal(p.seq, 1);
});

test('movement is relative to yaw and diagonals are not faster', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const p = game.entities.get('a');
  const x0 = p.x;
  // yaw = +90 degrees turns left: forward is -x
  game.handleInput('a', { keys: keys({ f: true }), yaw: Math.PI / 2, pitch: 0 });
  run(game, 0.5);
  assert.ok(Math.abs(x0 - p.x - DEFAULT_CONFIG.moveSpeed * 0.5) < 0.3, `dx ${p.x - x0}`);

  const game2 = makeGame();
  game2.addPlayer('a', { team: 'plant', mode: 'coop' });
  const q = game2.entities.get('a');
  const { x, z } = q;
  game2.handleInput('a', { keys: keys({ f: true, r: true }), yaw: 0, pitch: 0 });
  run(game2, 1);
  const d = Math.hypot(q.x - x, q.z - z);
  assert.ok(Math.abs(d - DEFAULT_CONFIG.moveSpeed) < 0.3, `diag dist ${d}`);
  assert.ok(q.x > x && q.z < z, 'forward+right goes +x, -z');
});

test('positions stay clamped inside the yard (house and fence block)', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const p = game.entities.get('a');
  game.handleInput('a', { keys: keys({ b: true }), yaw: 0, pitch: 0 }); // backwards => +z, toward house
  run(game, 4);
  assert.ok(p.z <= WORLD.bounds.maxZ, `z=${p.z}`);
  game.handleInput('a', { keys: keys({ l: true }), yaw: 0, pitch: 0 });
  run(game, 10);
  assert.ok(p.x >= WORLD.bounds.minX, `x=${p.x}`);
  game.handleInput('a', { keys: keys({ f: true }), yaw: 0, pitch: 0 });
  run(game, 15);
  assert.ok(p.z >= WORLD.bounds.minZ, `z=${p.z}`);
  game.handleInput('a', { keys: keys({ r: true }), yaw: 0, pitch: 0 });
  run(game, 15);
  assert.ok(p.x <= WORLD.bounds.maxX, `x=${p.x}`);
});

test('the garage is reachable through its door (plants walk through their own doors), walls block elsewhere', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const p = game.entities.get('a');
  const d = WORLD.doors.find((x) => x.id === 'garage');
  p.x = WORLD.garage.maxX + 3;
  p.z = d.z;
  game.handleInput('a', { keys: keys({ f: true }), yaw: Math.PI / 2, pitch: 0 }); // toward -x
  run(game, 2);
  assert.ok(p.x < WORLD.garage.maxX - 3, `entered garage x=${p.x}`);
  assert.ok(p.x >= WORLD.garage.minX, 'stays inside the garage');
  // beside the door: blocked at the wall
  p.x = WORLD.garage.maxX + 3;
  p.z = WORLD.garage.maxZ - 1;
  run(game, 2);
  assert.ok(p.x >= WORLD.garage.maxX, `blocked at x=${p.x}`);
});

test('clampToWorld pushes points out of the static walls and the yard edge', () => {
  const pos = clampToWorld({ x: -10, y: 0, z: WORLD.house.minZ + 0.2 }); // inside the front wall
  assert.ok(pos.z <= WORLD.house.minZ - 0.4 || pos.z >= WORLD.house.minZ + 0.4 + 0.4, `z=${pos.z}`);
  const inside = clampToWorld({ x: 0, y: 0, z: 15 }); // inside the kitchen: free
  assert.equal(inside.x, 0);
  assert.equal(inside.z, 15);
  const out = clampToWorld({ x: 99, y: 0, z: -99 });
  assert.ok(out.x <= WORLD.bounds.maxX && out.z >= WORLD.bounds.minZ);
});

test('jump rises and lands again', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const p = game.entities.get('a');
  game.handleInput('a', { keys: keys({ jump: true }), yaw: 0, pitch: 0 });
  let peak = 0;
  for (let i = 0; i < 60; i++) {
    game.tick(1 / 30);
    peak = Math.max(peak, p.y);
    if (i === 0) game.handleInput('a', { keys: keys() });
  }
  const expected = (DEFAULT_CONFIG.jumpSpeed ** 2) / (2 * DEFAULT_CONFIG.gravity);
  assert.ok(peak > expected * 0.7 && peak < expected * 1.3, `peak ${peak} vs ${expected}`);
  assert.equal(p.y, 0);
});

test('removing a player mid-round removes only their entity', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  game.addPlayer('b', { team: 'zombie' });
  game.removePlayer('b');
  assert.equal(game.entities.has('b'), false);
  assert.equal(game.entities.has('a'), true);
  assert.equal(game.phase, 'playing');
});

test('removing last human resets to lobby with no entities', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  game.addPlayer('b', { team: 'zombie' });
  run(game, 1);
  game.removePlayer('a');
  game.removePlayer('b');
  assert.equal(game.phase, 'lobby');
  assert.equal(game.entities.size, 0);
  assert.equal(game.mode, null);
  // a fresh first joiner may pick the mode again
  game.addPlayer('c', { team: 'zombie', mode: 'versus', difficulty: 'easy' });
  assert.equal(game.mode, 'versus');
  assert.equal(game.phase, 'playing');
  game.removePlayer('nobody'); // harmless
});

test('malformed input is ignored without throwing or changing state', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  game.handleInput('a', { seq: 5, keys: keys({ f: true }), yaw: 0.5, pitch: 0.2 });
  const before = JSON.stringify(game.snapshot().entities);
  assert.doesNotThrow(() => game.handleInput('a', { yaw: 'x' }));
  assert.doesNotThrow(() => game.handleInput('nobody', {}));
  assert.doesNotThrow(() => game.handleInput('a', null));
  assert.doesNotThrow(() => game.handleInput('a', 'junk'));
  assert.doesNotThrow(() => game.handleInput('a', { keys: 'zzz', yaw: NaN, pitch: Infinity, plant: 99, seq: 'q', fire: undefined }));
  assert.doesNotThrow(() => game.handleInput('a', { keys: { f: { toString() { throw new Error('boom'); } } } }));
  assert.equal(JSON.stringify(game.snapshot().entities), before);
  const p = game.entities.get('a');
  assert.equal(p.yaw, 0.5);
  assert.equal(p.pitch, 0.2);
  assert.equal(p.seq, 5);
});

test('pitch is clamped and yaw wrapped', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  game.handleInput('a', { yaw: 7, pitch: 9 });
  const p = game.entities.get('a');
  assert.ok(p.pitch <= DEFAULT_CONFIG.pitchLimit && p.pitch > 0);
  assert.ok(Math.abs(p.yaw) <= Math.PI);
});

test('snapshot follows the protocol shape', () => {
  const game = makeGame();
  game.addPlayer('a', { name: 'Jacob', team: 'plant', mode: 'coop' });
  run(game, 0.2);
  const s = game.snapshot();
  assert.equal(s.t, 'snap');
  assert.equal(typeof s.time, 'number');
  assert.equal(s.phase, 'playing');
  assert.equal(s.winner, null);
  assert.equal(typeof s.roundTime, 'number');
  assert.equal(s.roundLength, DEFAULT_CONFIG.roundLength);
  assert.equal(typeof s.wave, 'number');
  assert.equal(typeof s.gardenCount, 'number');
  assert.ok(Array.isArray(s.events));
  const e = s.entities.find((x) => x.id === 'a');
  for (const k of ['id', 'kind', 'team', 'x', 'y', 'z', 'yaw', 'hp', 'maxHp']) assert.ok(k in e, `missing ${k}`);
  assert.equal(e.name, 'Jacob');
  assert.ok(!('input' in e) && !('radius' in e), 'no internal fields leak');
  assert.doesNotThrow(() => JSON.stringify(s));
});

test('gardenSlots: four plots of 4 rows x 4 columns, rows Peashooter / Cactus / Cactus / Peashooter', () => {
  const slots = gardenSlots();
  assert.equal(slots.length, 64);
  for (let plot = 0; plot < 4; plot++) {
    const mine = slots.filter((s) => s.plot === plot);
    assert.equal(mine.length, 16);
    assert.deepEqual([0, 1, 2, 3].map((r) => mine.find((s) => s.row === r && s.col === 0).kind), ['peashooter', 'cactus', 'cactus', 'peashooter']);
    assert.deepEqual(new Set(mine.map((s) => s.door)).size, 1);
  }
  assert.deepEqual(['front', 'side', 'back', 'garage'], [0, 1, 2, 3].map((i) => slots[i * 16].door));
  // plots sit outside their doors, facing the way zombies come
  const front = slots.filter((s) => s.plot === 0);
  assert.ok(front.every((s) => s.z < WORLD.house.minZ));
  assert.ok(slots.filter((s) => s.plot === 2).every((s) => s.z > WORLD.house.maxZ + 4));
});

test('Game constructor defaults work', () => {
  const g = new Game();
  assert.equal(g.phase, 'lobby');
  assert.ok(g.entities instanceof Map);
  assert.deepEqual(g.drainEvents(), []);
});
