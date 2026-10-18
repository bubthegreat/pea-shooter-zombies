import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDamage } from '../server/sim/combat.js';
import { makeGame, run, entitiesOfKind } from './helpers.js';

function events(game, type) {
  return game.drainEvents().filter((e) => e.type === type);
}

test('converting a zombie bot names both sides', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { name: 'Jacob', team: 'plant', mode: 'coop' });
  const z = game.spawnBot('zombie', 0, 10);
  game.drainEvents();
  applyDamage(game, z, 99, a);
  const [ev] = events(game, 'convert');
  assert.equal(ev.byName, 'Jacob');
  assert.equal(ev.byKind, 'player');
  assert.equal(ev.targetName, 'Zombie');
  assert.equal(ev.targetKind, 'bot');
  assert.equal(ev.by, 'a');
  assert.ok(!ev.head);
});

test('a headshot kill carries head: true on the convert event', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { name: 'Jacob', team: 'plant', mode: 'coop' });
  const z = game.spawnBot('zombie', 0, 10);
  game.drainEvents();
  applyDamage(game, z, 99, a, { head: true });
  const [ev] = events(game, 'convert');
  assert.equal(ev.head, true);
});

test('human zombie target and plant fighter wilt carry names', () => {
  const game = makeGame();
  const p = game.addPlayer('p', { name: 'Pea', team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { name: 'J-Bob', team: 'zombie' });
  game.drainEvents();
  applyDamage(game, z, 99, p);
  const [conv] = events(game, 'convert');
  assert.equal(conv.targetName, 'J-Bob');
  assert.equal(conv.human, true);
  game.drainEvents();
  applyDamage(game, p, 999, z, { head: true });
  const [wilt] = events(game, 'wilt');
  assert.equal(wilt.byName, 'J-Bob');
  assert.equal(wilt.targetName, 'Pea');
  assert.equal(wilt.targetKind, 'player');
  assert.equal(wilt.head, true);
});

test('destroying a garden plant names the plant; turrets and the Gardener have names', () => {
  const game = makeGame({ features: { initialGarden: true } });
  const z = game.addPlayer('z', { name: 'J-Bob', team: 'zombie', mode: 'versus' });
  const plant = entitiesOfKind(game, 'garden')[0];
  game.drainEvents();
  applyDamage(game, plant, 999, z);
  const [ev] = events(game, 'wilt');
  assert.equal(ev.plantKind, plant.plantKind);
  assert.equal(ev.targetKind, 'garden');
  assert.match(ev.targetName, /^(Peashooter|Cactus)$/);
  assert.equal(ev.byName, 'J-Bob');
});

test('mow and mower_destroyed events carry names', () => {
  const game = makeGame({ features: { initialGarden: true } });
  const z = game.addPlayer('z', { name: 'J-Bob', team: 'zombie', mode: 'versus' });
  const m = game.mower;
  m.state = 'driving';
  m.driver = 'z';
  const plant = entitiesOfKind(game, 'garden')[0];
  z.x = plant.x;
  z.z = plant.z;
  game.drainEvents();
  run(game, 0.1);
  const mow = events(game, 'mow')[0];
  assert.ok(mow, 'a plant was mowed');
  assert.equal(mow.byName, 'J-Bob');
  assert.equal(mow.byKind, 'player');
  assert.match(mow.targetName, /^(Peashooter|Cactus)$/);

  const p = game.addPlayer('p', { name: 'Pea', team: 'plant' });
  game.drainEvents();
  applyDamage(game, m, 999, p);
  const [des] = events(game, 'mower_destroyed');
  assert.equal(des.byName, 'Pea');
  assert.equal(des.byKind, 'player');
});

test('the Gardener bot is named in events', () => {
  const game = makeGame({ features: { gardener: true, botAI: true, waves: false } });
  const z = game.addPlayer('z', { name: 'Zed', team: 'zombie', mode: 'versus' });
  run(game, 0.5);
  const g = [...game.entities.values()].find((e) => e.isGardener);
  assert.ok(g, 'gardener spawned');
  game.drainEvents();
  applyDamage(game, g, 9999, z);
  const [ev] = events(game, 'wilt');
  assert.equal(ev.targetName, 'Gardener');
  assert.equal(ev.targetKind, 'bot');
});
