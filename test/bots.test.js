import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { plantAt, initGarden } from '../server/sim/garden.js';
import { ensureAI } from '../server/sim/bots.js';
import { MAP } from '../server/sim/map.js';
import { makeGame, run, entitiesOfKind, slotIdx, forceRoute, breakDoors, insideStatic } from './helpers.js';

const FRIDGE = WORLD.fridge.stand;
const atFridge = (b) => Math.hypot(b.x - FRIDGE.x, b.z - FRIDGE.z) < 1.3;

function botGame(features = {}, overrides = {}) {
  return makeGame({ features: { botAI: true, ...features }, botItemChance: {}, mowerBotChance: 0, ...overrides }); // no mower/tool errands unless a test asks
}

/** A game with an AFK plant kid parked far away, so bots have nothing to shoot at but the building. */
function emptyYard(overrides = {}) {
  const game = botGame({}, overrides);
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  a.x = 38;
  a.z = 44;
  return { game, a };
}

test('zombie bots slow-walk (kid-friendly speed) along their route', () => {
  const { game } = emptyYard();
  const bot = forceRoute(game, game.spawnBot('zombie', 0, WORLD.gate.z), 'front', 'front');
  assert.ok(DEFAULT_CONFIG.zombieBotSpeed < DEFAULT_CONFIG.moveSpeed);
  run(game, 2);
  const moved = Math.hypot(bot.x - 0, bot.z - WORLD.gate.z);
  assert.ok(moved > 3 && moved < 7, `moved ${moved}`);
  assert.ok(bot.z > WORLD.gate.z + 3);
});

test('every route leads to the fridge: front lawn, left gravel path, right hedge path (doors already broken)', () => {
  for (const [route, door] of [['front', 'front'], ['front', 'side'], ['left', 'back'], ['left', 'side'], ['right', 'garage']]) {
    const { game } = emptyYard();
    breakDoors(game);
    const bot = forceRoute(game, game.spawnBot('zombie', 0, WORLD.gate.z), route, door);
    bot.hp = bot.maxHp = 1e6;
    let t = 0;
    while (!atFridge(bot) && t < 110) {
      game.tick(1 / 30);
      t += 1 / 30;
      assert.equal(insideStatic(bot), null, `${route}/${door}: inside a wall at ${bot.x.toFixed(1)},${bot.z.toFixed(1)}`);
    }
    assert.ok(atFridge(bot), `${route}/${door}: reached the fridge (at ${bot.x.toFixed(1)}, ${bot.z.toFixed(1)} after ${t.toFixed(0)} s)`);
  }
});

test('closed doors stop zombies: they shoot the door down, and only then get in', () => {
  for (const [route, door] of [['front', 'front'], ['left', 'back'], ['right', 'garage']]) {
    const { game } = emptyYard();
    const bot = forceRoute(game, game.spawnBot('zombie', 0, WORLD.gate.z), route, door);
    bot.hp = bot.maxHp = 1e6;
    const piece = game.cover.get(`door:${door}`);
    let t = 0;
    let brokeAt = null;
    while (!atFridge(bot) && t < 160) {
      game.tick(1 / 30);
      t += 1 / 30;
      if (brokeAt === null && piece.state === 'broken') brokeAt = t;
      if (brokeAt === null) assert.ok(!(bot.z > WORLD.house.minZ + 1 && bot.z < WORLD.house.maxZ - 1 && bot.x < WORLD.garage.maxX - 1 && door === 'front'), 'got in through a closed door');
    }
    assert.ok(brokeAt !== null && brokeAt < t, `${door} door broke before the fridge was reached`);
    assert.ok(atFridge(bot), `${route}/${door}: reached the fridge`);
    assert.ok(game.drainEvents().some((e) => e.type === 'coverBreak' && e.id === `door:${door}`));
  }
});

test('zombie bots pick a route by weight: front 40 / left 30 / right 30 %, and all five itineraries get used', () => {
  const game = botGame({});
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const count = {};
  const total = 600;
  for (let i = 0; i < total; i++) {
    const b = game.spawnBot('zombie', 0, WORLD.gate.z);
    ensureAI(game, b);
    const k = `${b.ai.itin.route}/${b.ai.itin.door}`;
    count[k] = (count[k] ?? 0) + 1;
  }
  const fam = (r) => Object.entries(count).filter(([k]) => k.startsWith(r)).reduce((a, [, n]) => a + n, 0) / total;
  assert.ok(Math.abs(fam('front') - 0.4) < 0.07, `front ${fam('front')}`);
  assert.ok(Math.abs(fam('left') - 0.3) < 0.07, `left ${fam('left')}`);
  assert.ok(Math.abs(fam('right') - 0.3) < 0.07, `right ${fam('right')}`);
  assert.equal(Object.keys(count).length, 5, JSON.stringify(count));
});

test('zombies are held at the gate while the head start runs', () => {
  const { game } = emptyYard();
  const bot = forceRoute(game, game.spawnBot('zombie', 0, WORLD.gate.z), 'front', 'front');
  game.headStart = 3;
  run(game, 2);
  assert.ok(Math.abs(bot.z - WORLD.gate.z) < 0.01, `still at the gate, z=${bot.z}`);
  game.headStart = 0;
  run(game, 2);
  assert.ok(bot.z > WORLD.gate.z + 3, 'walking once released');
});

test('zombie bots shoot garden plants in sight and in range', () => {
  const game = botGame({});
  game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  const plant = plantAt(game, slotIdx(0, 0, 1));
  plant.hp = plant.maxHp = 1e6; // observe damage instead of death
  const bot = game.spawnBot('zombie', plant.x, plant.z - 12);
  bot.hp = bot.maxHp = 1e6;
  const player = game.entities.get('a');
  player.x = 38;
  player.z = 44; // far away
  run(game, 15);
  assert.ok(plant.hp < 1e6, 'plant took hits');
});

test('zombie bots do not shoot through walls', () => {
  const game = botGame({});
  game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  const a = game.entities.get('a');
  a.x = -3;
  a.z = 12; // inside the house, behind the front wall
  a.hp = a.maxHp = 1e6;
  const bot = game.spawnBot('zombie', -3, 0); // 12 m away, wall in between
  bot.hp = bot.maxHp = 1e6;
  forceRoute(game, bot, 'front', 'front');
  bot.ai.pi = 99; // no walking, only looking
  bot.ai.mode = 'inside';
  bot.ai.path = [{ x: -3, z: 0 }];
  run(game, 6);
  assert.equal(game.events.filter((e) => e.type === 'hit' && e.id === 'a').length, 0, 'no hits through the wall');
});

test('zombie bots shoot human plants, with a reaction delay and imperfect aim', () => {
  const game = botGame({}, { difficulties: { ...DEFAULT_CONFIG.difficulties, normal: { ...DEFAULT_CONFIG.difficulties.normal, reaction: 1 } } });
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  a.x = 0;
  a.z = -30;
  a.hp = a.maxHp = 1e6; // never wilts, so damage stays visible
  const bot = game.spawnBot('zombie', 0, -45);
  bot.hp = bot.maxHp = 1e6;
  run(game, 0.6);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0, 'still reacting');
  assert.equal(a.hp, a.maxHp);
  run(game, 40);
  assert.ok(a.hp < a.maxHp, 'player took some hits');
});

function hitsTaken(aimError, seconds = 12) {
  const diff = { ...DEFAULT_CONFIG.difficulties.normal, aimError, reaction: 0 };
  const game = botGame({}, { difficulties: { ...DEFAULT_CONFIG.difficulties, normal: diff }, seed: 42 });
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  a.x = 0;
  a.z = -30;
  a.hp = a.maxHp = 1e6;
  const bot = game.spawnBot('zombie', 0, -44);
  bot.hp = bot.maxHp = 1e6;
  forceRoute(game, bot, 'front', 'front');
  bot.ai.mode = 'inside';
  bot.ai.path = [{ x: 0, z: -44 }]; // stand still and shoot
  bot.ai.replan = 1e9;
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
  assert.equal(d.normal.aimError, 0.14);
  assert.ok(d.easy.fireScale <= d.normal.fireScale);
  assert.ok(d.easy.reaction > d.normal.reaction);
  assert.ok(d.easy.waveBase < d.normal.waveBase);
});

test('bots survive degenerate situations (no garden, no targets, everything dead)', () => {
  const game = botGame({ gardener: true });
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  game.spawnBot('zombie', 0, -40);
  game.spawnBot('plant', 0, 0);
  assert.doesNotThrow(() => run(game, 5));
  initGarden(game);
  for (const g of entitiesOfKind(game, 'garden')) game.removeEntity(g);
  assert.doesNotThrow(() => run(game, 5));
});

test('bots stay inside the world and never walk through walls', () => {
  const { game } = emptyYard();
  const bots = [];
  for (let i = 0; i < 8; i++) {
    const b = game.spawnBot('zombie', -20 + i * 5, WORLD.gate.z);
    b.hp = b.maxHp = 1e6;
    bots.push(b);
  }
  for (let t = 0; t < 90; t++) {
    run(game, 1);
    for (const b of bots) {
      assert.equal(insideStatic(b), null, `bot inside a wall at ${b.x.toFixed(1)}, ${b.z.toFixed(1)}`);
      assert.ok(b.x >= WORLD.bounds.minX && b.x <= WORLD.bounds.maxX && b.z >= WORLD.bounds.minZ && b.z <= WORLD.bounds.maxZ);
    }
  }
});

test('the nav graph: every edge is walkable and every doorway node is reachable from the gate', async () => {
  const { planRoute, nodePath, NAV_IDS } = await import('../server/sim/nav.js');
  const game = botGame({});
  for (const [a, b] of MAP.edges) {
    const pa = MAP.nodes[a];
    const pb = MAP.nodes[b];
    assert.ok(game.field.walkLine(pa[0], pa[1], pb[0], pb[1], 'plant'), `edge ${a} - ${b} is blocked by a wall`);
  }
  for (const id of NAV_IDS) assert.ok(nodePath('f1', id), `${id} is connected`);
  assert.ok(planRoute(game.field, 0, WORLD.gate.z, FRIDGE.x, FRIDGE.z, 'zombie').length > 1);
});
