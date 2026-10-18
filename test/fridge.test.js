import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { applyDamage } from '../server/sim/combat.js';
import { plantAt, stepGarden } from '../server/sim/garden.js';
import { makeGame, run, entitiesOfKind, slotIdx } from './helpers.js';

const FR = WORLD.fridge.stand;

function fridgeGame(features = {}, config = {}) {
  const game = makeGame({ features: { fridge: true, winRules: true, ...features }, ...config });
  const p = game.addPlayer('p', { team: 'plant', mode: 'versus' });
  p.x = 38;
  p.z = 44;
  const z = game.addPlayer('z', { team: 'zombie' });
  z.x = FR.x;
  z.z = FR.z;
  return { game, p, z };
}

test('one zombie at the fridge fills the meter in about 10 s, more zombies are faster, the meter never drains', () => {
  const { game, z } = fridgeGame();
  run(game, 5);
  assert.ok(Math.abs(game.fridge.meter - 0.5) < 0.02, `meter ${game.fridge.meter}`);
  assert.equal(game.snapshot().fridge.n, 1);
  z.x = 0;
  z.z = 0; // walks off: the meter stays
  const kept = game.fridge.meter;
  run(game, 3);
  assert.equal(game.fridge.meter, kept);
  assert.equal(game.snapshot().fridge.n, 0);
  assert.ok(game.drainEvents().some((e) => e.type === 'fridgeAlarm'), 'alarm when the first zombie arrives');

  const two = fridgeGame();
  const bot = two.game.spawnBot('zombie', FR.x + 0.5, FR.z);
  bot.hp = bot.maxHp = 1e6;
  run(two.game, 2.5);
  assert.ok(Math.abs(two.game.fridge.meter - 0.5) < 0.03, `two zombies: ${two.game.fridge.meter}`);

  const many = fridgeGame();
  for (let i = 0; i < 7; i++) many.game.spawnBot('zombie', FR.x + (i - 3) * 0.3, FR.z);
  run(many.game, 1);
  assert.ok(Math.abs(many.game.fridge.meter - 0.4) < 0.03, `capped at ${DEFAULT_CONFIG.fridge.maxZombies} at once: ${many.game.fridge.meter}`);
});

test('only living zombies inside the kitchen near the fridge count', () => {
  const { game, z } = fridgeGame();
  const sprout = game.spawnBot('zombie', FR.x, FR.z);
  sprout.state = 'sprout';
  const plant = game.spawnBot('plant', FR.x, FR.z);
  z.x = FR.x + 2.6; // too far
  run(game, 2);
  assert.equal(game.fridge.meter, 0);
  assert.equal(game.fridge.n, 0);
  z.x = WORLD.rooms.kitchen.maxX + 0.3; // the hall side of the wall is close but not the kitchen
  z.z = FR.z;
  run(game, 1);
  assert.equal(game.fridge.meter, 0);
  assert.ok(plant);
});

test('a full meter is a zombie win; plants shooting zombies off the fridge slow it down', () => {
  const { game, z } = fridgeGame();
  run(game, 9);
  assert.equal(game.phase, 'playing');
  assert.ok(game.fridge.meter > 0.85);
  run(game, 1.3);
  assert.equal(game.phase, 'ended');
  assert.equal(game.winner, 'zombie');
  assert.equal(game.snapshot().fridge.m, 1);

  const { game: g2, z: z2, p } = fridgeGame();
  run(g2, 5);
  applyDamage(g2, z2, 99, p); // converted (sprout): off the fridge
  run(g2, 6);
  assert.ok(g2.fridge.meter < 0.55, `stalled at ${g2.fridge.meter}`);
  assert.equal(g2.phase, 'playing');
});

test('no zombie meter during the head start; snapshots carry the fridge and the countdown', () => {
  const { game } = fridgeGame({ headStart: true });
  assert.equal(game.headStart, DEFAULT_CONFIG.headStart);
  run(game, 3);
  assert.equal(game.fridge.meter, 0);
  assert.equal(game.snapshot().headStart, 12);
  assert.equal(typeof game.snapshot().fridge.m, 'number');
});

test('feature off: nothing fills', () => {
  const { game } = fridgeGame({ fridge: false });
  run(game, 12);
  assert.equal(game.fridge.meter, 0);
  assert.equal(game.phase, 'playing');
});

// ---- head start -------------------------------------------------------------------------------

function headStartGame(extra = {}) {
  const game = makeGame({ features: { headStart: true, waves: true, botAI: true, ...extra.features }, ...extra.config });
  const p = game.addPlayer('p', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  const z = game.addPlayer('z', { team: 'zombie' });
  return { game, p, z };
}

test('plants start with 300 sunshine and nothing planted; zombies wait in the gate pen and cannot fire', () => {
  const { game, p, z } = headStartGame();
  assert.equal(p.sunshine, 300);
  assert.equal(game.gardenCount(), 0);
  assert.equal(game.headStart, 15);
  game.handleInput('z', { keys: { f: true, b: false, l: false, r: false, jump: false }, yaw: Math.PI, pitch: 0, fire: true }); // try to walk to the house, shooting
  run(game, 10);
  const pen = WORLD.pen;
  assert.ok(z.z <= pen.maxZ && z.z >= pen.minZ && z.x >= pen.minX && z.x <= pen.maxX, `still in the pen at ${z.x}, ${z.z}`);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0, 'held zombies do not shoot');
  assert.equal(entitiesOfKind(game, 'bot').filter((b) => b.team === 'zombie').length, 0, 'the first wave waits for the head start');
  run(game, 5.5);
  assert.equal(game.headStart, 0);
  assert.ok(game.drainEvents().some((e) => e.type === 'release'));
  run(game, 3);
  assert.ok(z.z > pen.maxZ, 'released: out of the pen');
  run(game, 3);
  assert.ok(entitiesOfKind(game, 'bot').filter((b) => b.team === 'zombie').length > 0, 'wave 1 arrived');
});

test('held zombies cannot be shot (turrets at 40 m would otherwise convert them in the pen)', () => {
  const { game, z } = headStartGame();
  const t = plantAt(game, slotIdx(0, 0, 1)); // outermost cactus-range slot... any plant
  t.plantKind = 'cactus';
  t.x = z.x;
  t.z = z.z + 30;
  for (let i = 0; i < 60; i++) {
    stepGarden(game, 1 / 30);
  }
  assert.equal(entitiesOfKind(game, 'projectile').length, 0);
  assert.equal(z.hp, z.maxHp);
});

test('the Gardener plants during the head start', () => {
  const game = makeGame({ features: { headStart: true, gardener: true, botAI: true } });
  game.addPlayer('z', { team: 'zombie', mode: 'coop' });
  run(game, 14);
  assert.ok(game.gardenCount() >= 2, `planted ${game.gardenCount()} in the head start`);
});

test('turrets do not shoot at zombies they cannot see (behind the house wall)', () => {
  const game = makeGame();
  game.addPlayer('p', { team: 'plant', mode: 'coop' });
  const t = plantAt(game, slotIdx(0, 3, 1));
  const behind = game.spawnBot('zombie', t.x - 6, 12); // inside the house, wall between
  behind.hp = behind.maxHp = 1e6;
  for (let i = 0; i < 90; i++) stepGarden(game, 1 / 30);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0, 'no shots into the wall');
  behind.x = t.x;
  behind.z = t.z - 10; // out in the open
  for (let i = 0; i < 45; i++) stepGarden(game, 1 / 30);
  assert.ok(entitiesOfKind(game, 'projectile').length > 0, 'and it fires at one it can see');
});
