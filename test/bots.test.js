import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD, gardenSlots } from '../server/sim/world.js';
import { plantAt, initGarden } from '../server/sim/garden.js';
import { ensureAI } from '../server/sim/bots.js';
import * as combat from '../server/sim/combat.js';
import { makeGame, run, entitiesOfKind } from './helpers.js';

const nearestPlantDist = (game, b) =>
  Math.min(...entitiesOfKind(game, 'garden').map((g) => Math.hypot(g.x - b.x, g.z - b.z)));

function botGame(features = {}, overrides = {}) {
  return makeGame({ features: { botAI: true, ...features }, ...overrides });
}

test('zombie bot moves toward garden over 2 s', () => {
  const game = botGame({ initialGarden: true });
  game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  const bot = game.spawnBot('zombie', 0, WORLD.gate.z);
  const d0 = nearestPlantDist(game, bot);
  run(game, 2);
  const moved = Math.hypot(bot.x - 0, bot.z - WORLD.gate.z);
  assert.ok(moved > 3 && moved < 7, `moved ${moved}`);
  assert.ok(bot.z > WORLD.gate.z + 3);
  assert.ok(nearestPlantDist(game, bot) < d0 - 3);
});

test('zombie bots slow-walk (kid-friendly speed) and stop short of the front row to shoot', () => {
  const game = botGame({ initialGarden: true });
  game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'easy' });
  const bot = game.spawnBot('zombie', 0, WORLD.gate.z);
  bot.hp = bot.maxHp = 1e6; // survive turrets for this test
  assert.ok(DEFAULT_CONFIG.zombieBotSpeed < DEFAULT_CONFIG.moveSpeed);
  run(game, 40);
  assert.ok(bot.z < -4 && bot.z > -14, `bot parked at z=${bot.z}`);
  assert.ok(bot.z <= 0);
});

test('zombie bots shoot garden plants within range', () => {
  const game = botGame({});
  game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  const plant = plantAt(game, gardenSlots().findIndex((s) => s.x === 0 && s.z === 0));
  plant.hp = plant.maxHp = 1e6; // observe damage instead of death
  const bot = game.spawnBot('zombie', 0, -12);
  bot.hp = bot.maxHp = 1e6;
  const player = game.entities.get('a');
  player.x = 25;
  player.z = 25; // far away
  run(game, 15);
  assert.ok(plant.hp < 1e6, 'plant took hits');
});

test('zombie bots shoot human plants, with a reaction delay and imperfect aim', () => {
  const game = botGame({}, { difficulties: { ...DEFAULT_CONFIG.difficulties, normal: { ...DEFAULT_CONFIG.difficulties.normal, reaction: 1 } } });
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  a.x = 0;
  a.z = 0;
  a.hp = a.maxHp = 1e6; // never wilts, so damage stays visible
  const bot = game.spawnBot('zombie', 0, -15);
  bot.hp = bot.maxHp = 1e6;
  run(game, 0.6);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0, 'still reacting');
  assert.equal(a.hp, a.maxHp);
  run(game, 14);
  assert.ok(a.hp < a.maxHp, 'player took some hits');
});

function hitsTaken(aimError, seconds = 12) {
  const diff = { ...DEFAULT_CONFIG.difficulties.normal, aimError, reaction: 0 };
  const game = botGame({}, { difficulties: { ...DEFAULT_CONFIG.difficulties, normal: diff }, seed: 42 });
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  a.x = 0;
  a.z = 0;
  a.hp = a.maxHp = 1e6;
  const bot = game.spawnBot('zombie', 0, -14);
  bot.hp = bot.maxHp = 1e6;
  run(game, seconds);
  return game.events.filter((e) => e.type === 'hit' && e.id === 'a').length;
}

test('aim error makes bots miss: sloppier aim lands fewer hits', () => {
  const sharp = hitsTaken(0);
  const sloppy = hitsTaken(0.3);
  assert.ok(sharp > 10, `sharp ${sharp}`);
  assert.ok(sloppy < sharp * 0.6, `sloppy ${sloppy} vs sharp ${sharp}`);
});

test('easy is gentler than normal', () => {
  const d = DEFAULT_CONFIG.difficulties;
  assert.ok(d.easy.aimError > d.normal.aimError);
  assert.equal(d.easy.aimError, 0.15);
  assert.equal(d.normal.aimError, 0.07);
  assert.ok(d.easy.fireScale < d.normal.fireScale);
  assert.ok(d.easy.reaction >= d.normal.reaction);
});

test('plant bots (converted zombies) walk to the guard line and shoot zombies in range', () => {
  const game = botGame({});
  const z = game.addPlayer('z', { team: 'zombie', mode: 'coop', difficulty: 'normal' });
  z.x = 10;
  z.z = -20;
  const bot = game.spawnBot('plant', -5, 20);
  z.hp = z.maxHp = 1e6; // keep the target standing so every hit is visible
  run(game, 12);
  assert.ok(Math.abs(bot.z - DEFAULT_CONFIG.guardLineZ) < 2.5, `bot parked at z=${bot.z}`);
  run(game, 60);
  const hits = game.events.filter((e) => e.type === 'hit' && e.id === 'z' && e.by === bot.id).length;
  assert.ok(hits >= 1, 'plant bot hit the zombie player');
});

test('a bot converted mid-round switches to plant behavior', () => {
  const game = botGame({});
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  const bot = game.spawnBot('zombie', 0, -30);
  run(game, 0.5);
  assert.equal(bot.ai.role, 'zombie');
  combat.applyDamage(game, bot, 99, a);
  assert.equal(bot.team, 'plant');
  assert.equal(bot.ai, null, 'brain reset on conversion');
  run(game, 0.5);
  assert.equal(bot.ai.role, 'plant');
  run(game, 20);
  assert.ok(Math.abs(bot.z - DEFAULT_CONFIG.guardLineZ) < 2.5, `parked at z=${bot.z}`);
});

test('about 1 in 4 zombie bots go for the mower', () => {
  const game = botGame({});
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  let n = 0;
  const total = 400;
  for (let i = 0; i < total; i++) {
    const b = game.spawnBot('zombie', 0, 0);
    ensureAI(game, b);
    if (b.ai.seeksMower) n++;
  }
  const share = n / total;
  assert.ok(share > 0.15 && share < 0.35, `share ${share}`);
});

test('a mower-seeking bot fetches the mower and drives it into the garden', () => {
  const game = botGame({ initialGarden: true });
  game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  const bot = game.spawnBot('zombie', 10, 20);
  bot.hp = bot.maxHp = 1e6;
  ensureAI(game, bot);
  bot.ai.seeksMower = true;
  const states = new Set();
  const startPlants = game.gardenCount();
  for (let i = 0; i < 30 * 90 && game.gardenCount() === startPlants; i++) {
    game.tick(1 / 30);
    states.add(game.mower.state);
  }
  assert.ok(states.has('starting'), 'bot started the mower');
  assert.ok(states.has('driving'), 'bot drove the mower');
  assert.ok(game.gardenCount() < startPlants, 'mower mowed a plant');
  const mow = game.events.find((e) => e.type === 'mow');
  assert.ok(mow);
});

test('a bot that loses the race for the mower gives up on it', () => {
  const game = botGame({ initialGarden: true });
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const z = game.addPlayer('z', { team: 'zombie' });
  const bot = game.spawnBot('zombie', 0, -40);
  ensureAI(game, bot);
  bot.ai.seeksMower = true;
  game.mower.state = 'driving';
  game.mower.driver = z.id;
  run(game, 2);
  assert.equal(bot.ai.seeksMower, false);
});

test('defenders: 4 plant bots appear when no human plays plants, and respawn after 8 s', () => {
  const game = botGame({ defenders: true });
  game.addPlayer('z', { team: 'zombie', mode: 'coop' });
  run(game, 0.2);
  let defenders = entitiesOfKind(game, 'bot').filter((b) => b.team === 'plant');
  assert.equal(defenders.length, 4);
  for (const d of defenders) {
    assert.equal(d.hp, DEFAULT_CONFIG.plantHp);
    assert.ok(d.ai.defender);
  }
  run(game, 12);
  for (const d of defenders) assert.ok(Math.abs(d.z - DEFAULT_CONFIG.guardLineZ) < 3, `defender z=${d.z}`);
  combat.applyDamage(game, defenders[0], 1000, game.entities.get('z'));
  assert.equal(entitiesOfKind(game, 'bot').filter((b) => b.team === 'plant').length, 3);
  run(game, 7.5);
  assert.equal(entitiesOfKind(game, 'bot').filter((b) => b.team === 'plant').length, 3);
  run(game, 1);
  defenders = entitiesOfKind(game, 'bot').filter((b) => b.team === 'plant');
  assert.equal(defenders.length, 4);
});

test('defender count follows mode and whether a human plays plants', () => {
  const coopPlant = botGame({ defenders: true });
  coopPlant.addPlayer('a', { team: 'plant', mode: 'coop' });
  run(coopPlant, 0.2);
  assert.equal(entitiesOfKind(coopPlant, 'bot').length, 0);

  const versus = botGame({ defenders: true });
  versus.addPlayer('a', { team: 'plant', mode: 'versus' });
  versus.addPlayer('z', { team: 'zombie' });
  run(versus, 0.2);
  assert.equal(entitiesOfKind(versus, 'bot').filter((b) => b.team === 'plant').length, DEFAULT_CONFIG.versusDefenderCount);

  const off = botGame({ defenders: false });
  off.addPlayer('z', { team: 'zombie', mode: 'coop' });
  run(off, 0.2);
  assert.equal(entitiesOfKind(off, 'bot').length, 0);
});

test('bots survive degenerate situations (no garden, no targets, everything dead)', () => {
  const game = botGame({ defenders: true });
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  game.spawnBot('zombie', 0, -40);
  game.spawnBot('plant', 0, 0);
  assert.doesNotThrow(() => run(game, 5));
  initGarden(game);
  for (const g of entitiesOfKind(game, 'garden')) game.removeEntity(g);
  assert.doesNotThrow(() => run(game, 5));
});

test('bots stay inside the world and never walk through the house', () => {
  const game = botGame({ initialGarden: true });
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const bots = [];
  for (let i = 0; i < 6; i++) {
    const b = game.spawnBot('zombie', -20 + i * 8, WORLD.gate.z);
    b.hp = b.maxHp = 1e6;
    bots.push(b);
  }
  run(game, 60);
  for (const b of bots) {
    assert.ok(b.z <= WORLD.bounds.maxZ + 0.01 || (b.x >= 14 && b.x <= 26), `bot at ${b.x}, ${b.z}`);
    assert.ok(Math.abs(b.x) <= WORLD.bounds.maxX);
  }
});
