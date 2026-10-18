import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { applyDamage } from '../server/sim/combat.js';
import { makeGame, run, entitiesOfKind } from './helpers.js';

const gardeners = (game) => entitiesOfKind(game, 'bot').filter((b) => b.team === 'plant');

function gardenerGame(extra = {}) {
  const game = makeGame({ features: { gardener: true, botAI: true, ...extra.features }, ...extra.config });
  game.addPlayer('z', { team: 'zombie', mode: 'coop', difficulty: 'normal' });
  return game;
}

test('converted zombie bots poof into a sunshine pickup; no plant soldier appears', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const bot = game.spawnBot('zombie', 3, -10);
  game.drainEvents();
  applyDamage(game, bot, 99, a);
  assert.equal(game.entities.has(bot.id), false, 'the zombie is gone');
  assert.equal(gardeners(game).length, 0, 'no walking plant');
  const ev = game.drainEvents().find((e) => e.type === 'convert');
  assert.ok(ev && ev.id === bot.id && ev.human === false && ev.by === 'a');
  assert.equal(ev.x, 3);
  assert.equal(ev.z, -10);
  const suns = entitiesOfKind(game, 'sun');
  assert.equal(suns.length, 1);
  assert.equal(suns[0].x, 3);
  assert.equal(suns[0].z, -10);
  assert.ok(suns[0].y <= DEFAULT_CONFIG.sunRestHeight + 1e-9, 'already landed, ready to grab');
  assert.equal(a.progress, 1, 'still counts as a kill');
  // walk over it: +sunValue
  const before = a.sunshine;
  a.x = 3;
  a.z = -10;
  game.tick(1 / 30);
  assert.equal(a.sunshine, before + DEFAULT_CONFIG.sunValue);
  assert.equal(entitiesOfKind(game, 'sun').length, 0);
});

test('a converted human zombie still sprouts and pays sunshine directly (no pickup)', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { team: 'zombie' });
  const before = a.sunshine;
  applyDamage(game, z, 99, a);
  assert.equal(z.state, 'sprout');
  assert.equal(a.sunshine, before + DEFAULT_CONFIG.sunPerConversion);
  assert.equal(entitiesOfKind(game, 'sun').length, 0);
});

test('with no human on the plant team exactly one Gardener bot appears', () => {
  const game = gardenerGame();
  run(game, 0.5);
  const g = gardeners(game);
  assert.equal(g.length, 1);
  assert.equal(g[0].name, 'Gardener');
  assert.equal(g[0].kind, 'bot');
  assert.equal(g[0].team, 'plant');
  assert.equal(g[0].state, 'alive');
  assert.ok(g[0].sunshine >= 0);
  const snap = game.snapshot().entities.find((e) => e.id === g[0].id);
  assert.equal(snap.name, 'Gardener');
  assert.equal(typeof snap.sunshine, 'number');
  run(game, 5);
  assert.equal(gardeners(game).length, 1, 'never more than one');
});

test('no Gardener while a human plays plants; it leaves when a plant kid joins', () => {
  const coop = makeGame({ features: { gardener: true, botAI: true } });
  coop.addPlayer('a', { team: 'plant', mode: 'coop' });
  run(coop, 1);
  assert.equal(gardeners(coop).length, 0);

  const game = gardenerGame();
  run(game, 0.5);
  assert.equal(gardeners(game).length, 1);
  game.addPlayer('p', { team: 'plant' });
  run(game, 0.5);
  assert.equal(gardeners(game).length, 0);
});

test('feature switch: gardener off means no bot', () => {
  const game = gardenerGame({ features: { gardener: false } });
  run(game, 2);
  assert.equal(gardeners(game).length, 0);
});

test('the Gardener replants empty slots with its own sunshine income', () => {
  const game = gardenerGame();
  run(game, 0.2);
  const g = gardeners(game)[0];
  const first = game.gardenCount();
  const income = DEFAULT_CONFIG.gardener.income;
  run(game, 30);
  const planted = game.gardenCount();
  assert.ok(planted >= 3 && planted > first, `replanted ${planted}`);
  // it cannot out-spend its income: start sunshine + 30 s of trickle covers at most this many peashooters
  const maxAffordable = Math.floor((g.sunshine + DEFAULT_CONFIG.gardener.startSunshine + income * 30) / DEFAULT_CONFIG.plantTypes.peashooter.cost) + 1;
  assert.ok(planted <= maxAffordable, `planted ${planted} <= ${maxAffordable}`);
  const events = game.drainEvents().filter((e) => e.type === 'plant');
  assert.ok(events.length >= planted && events.every((e) => e.by === g.id));
  assert.ok(g.z < WORLD.bounds.maxZ && g.z > WORLD.bounds.minZ);
});

test('the Gardener never plants without sunshine', () => {
  const game = gardenerGame({ config: { gardener: { ...DEFAULT_CONFIG.gardener, income: 0, startSunshine: 0 } } });
  run(game, 20);
  assert.equal(game.gardenCount(), 0);
});

test('the Gardener respawns after it wilts, still just one', () => {
  const game = gardenerGame();
  run(game, 0.5);
  const first = gardeners(game)[0];
  applyDamage(game, first, 999, game.entities.get('z'));
  assert.equal(gardeners(game).length, 0);
  run(game, DEFAULT_CONFIG.gardener.respawn - 0.5);
  assert.equal(gardeners(game).length, 0, 'still waiting');
  run(game, 1);
  assert.equal(gardeners(game).length, 1);
  assert.notEqual(gardeners(game)[0].id, first.id);
});

test('the Gardener shoots at zombies, but only weakly', () => {
  const game = gardenerGame();
  run(game, 0.5);
  const g = gardeners(game)[0];
  const target = game.spawnBot('zombie', g.x, g.z - 12);
  target.hp = target.maxHp = 1e6;
  game.entities.get('z').x = 28;
  game.entities.get('z').z = 25;
  game.drainEvents();
  g.sunshine = 0; // stay put and shoot instead of planting
  const shotsBefore = game.events.length;
  run(game, 10);
  const shots = entitiesOfKind(game, 'projectile').length + game.events.filter((e) => e.type === 'hit' && e.by === g.id).length;
  assert.ok(shots >= 1 || game.events.length > shotsBefore, 'it fires now and then');
  const hits = game.events.filter((e) => e.type === 'hit' && e.by === g.id).length;
  assert.ok(hits <= 10 * 4 * 0.5, `weak fire: ${hits} hits in 10 s`);
});

test('no plant soldiers: a long round never creates a plant bot other than the Gardener', () => {
  const game = makeGame({ features: { gardener: true, botAI: true, waves: true, initialGarden: true } });
  game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  run(game, 60);
  assert.equal(gardeners(game).length, 0);
  assert.equal(entitiesOfKind(game, 'bot').filter((b) => b.team === 'plant').length, 0);
});
