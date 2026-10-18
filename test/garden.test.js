import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD, gardenSlots } from '../server/sim/world.js';
import { initGarden, tryPlant, stepGarden, stepSun, spawnSun, plantAt } from '../server/sim/garden.js';
import { stepProjectiles, applyDamage } from '../server/sim/combat.js';
import { makeGame, run, entitiesOfKind, S, slotIdx } from './helpers.js';

const gardenOf = (game) => entitiesOfKind(game, 'garden');

function plantGame(overrides = {}) {
  const game = makeGame(overrides);
  const p = game.addPlayer('a', { name: 'A', team: 'plant', mode: 'coop', difficulty: 'normal' });
  return { game, p };
}

test('initGarden plants 32 (every other column, all rows, all four plots)', () => {
  const { game } = plantGame();
  assert.equal(gardenOf(game).length, 0);
  initGarden(game);
  const plants = gardenOf(game);
  assert.equal(plants.length, 32);
  assert.equal(game.gardenCount(), 32);
  assert.equal(plants.filter((g) => g.plantKind === 'peashooter').length, 16);
  assert.equal(plants.filter((g) => g.plantKind === 'cactus').length, 16);
  for (const g of plants) {
    assert.equal(g.team, 'plant');
    assert.equal(g.hp, DEFAULT_CONFIG.gardenPlantHp);
    assert.equal(g.state, 'alive');
  }
  const slots = gardenSlots();
  for (const g of plants) {
    const idx = slots.findIndex((s) => s.x === g.x && s.z === g.z);
    assert.ok(idx >= 0 && slots[idx].col % 2 === 0, `plant at slot ${idx}`);
    assert.equal(slots[idx].kind, g.plantKind);
  }
  initGarden(game); // idempotent: occupied slots are skipped
  assert.equal(gardenOf(game).length, 32);
});

test('round start pre-plants the garden when the feature is on, and resets sunshine', () => {
  const game = makeGame({ features: { initialGarden: true } });
  const p = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  assert.equal(game.gardenCount(), 32);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine);
  const z = game.addPlayer('z', { team: 'zombie' });
  assert.equal(z.sunshine, undefined);
  p.sunshine = 3;
  applyDamage(game, gardenOf(game)[0], 1000, null);
  assert.equal(game.gardenCount(), 31);
  game.startRound();
  assert.equal(game.gardenCount(), 32);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine);
});

test('tryPlant succeeds near an empty peashooter slot and costs 50', () => {
  const { game, p } = plantGame();
  initGarden(game);
  p.x = S(0, 1).x;
  p.z = S(0, 1).z + 1; // next to the empty front-row slot (column 1)
  const before = game.gardenCount();
  const plant = tryPlant(game, p, 'peashooter');
  assert.ok(plant);
  assert.equal(plant.kind, 'garden');
  assert.equal(plant.plantKind, 'peashooter');
  assert.equal(plant.x, S(0, 1).x);
  assert.equal(plant.z, S(0, 1).z);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine - 50);
  assert.equal(game.gardenCount(), before + 1);
  const ev = game.drainEvents().find((e) => e.type === 'plant');
  assert.ok(ev && ev.id === plant.id && ev.plantKind === 'peashooter' && ev.by === 'a');
  // the slot is now taken: a second attempt in the same spot finds nothing nearby
  p.sunshine = 500;
  p.x = S(0, 1).x;
  p.z = S(0, 1).z - 4.5; // out in front of the plot: columns 0 and 2 are planted, row 1 is 8 m away
  assert.equal(tryPlant(game, p, 'peashooter'), null);
});

test('tryPlant takes the nearest empty slot of any row (a cactus goes in the front row too)', () => {
  const { game, p } = plantGame();
  initGarden(game);
  p.sunshine = 500;
  p.x = S(0, 1).x;
  p.z = S(0, 1).z + 0.5; // the empty front-row slot (column 1) is the nearest one
  const cactus = tryPlant(game, p, 'cactus');
  assert.ok(cactus);
  assert.equal(cactus.plantKind, 'cactus');
  assert.equal(cactus.z, S(0, 1).z);
  assert.equal(p.sunshine, 500 - 100);
});

test('tryPlant with 40 sunshine is a no-op', () => {
  const { game, p } = plantGame();
  initGarden(game);
  p.x = S(0, 1).x;
  p.z = S(0, 1).z + 1;
  p.sunshine = 40;
  const before = game.gardenCount();
  game.drainEvents();
  assert.equal(tryPlant(game, p, 'peashooter'), null);
  assert.equal(p.sunshine, 40);
  assert.equal(game.gardenCount(), before);
  assert.deepEqual(game.drainEvents(), []);
  p.sunshine = 99;
  assert.equal(tryPlant(game, p, 'cactus'), null, 'cactus costs 100');
  assert.equal(p.sunshine, 99);
});

test('tryPlant with no free slot within 4 m is a no-op', () => {
  const { game, p } = plantGame();
  initGarden(game);
  // the yard far from every plot
  p.x = 30;
  p.z = -30;
  assert.equal(tryPlant(game, p, 'peashooter'), null);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine);
  // right at an occupied slot with all neighbours >4 m away or occupied
  p.x = S(0, 0).x - 4.6;
  p.z = S(0, 0).z - 4.6;
  assert.equal(tryPlant(game, p, 'cactus'), null);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine);
  assert.equal(game.gardenCount(), 32);
});

test('only living plant humans can plant', () => {
  const game = makeGame();
  const z = game.addPlayer('z', { team: 'zombie', mode: 'coop' });
  const p = game.addPlayer('p', { team: 'plant' });
  initGarden(game);
  z.sunshine = 500;
  z.x = S(0, 1).x;
  z.z = S(0, 1).z + 1;
  assert.equal(tryPlant(game, z, 'peashooter'), null);
  p.x = S(0, 1).x;
  p.z = S(0, 1).z + 1;
  p.state = 'wilted';
  assert.equal(tryPlant(game, p, 'peashooter'), null);
  assert.equal(tryPlant(game, p, 'nonsense'), null);
  assert.equal(tryPlant(game, null, 'cactus'), null);
});

test('planting via input is edge-triggered', () => {
  const { game, p } = plantGame();
  initGarden(game);
  p.sunshine = 500;
  p.x = S(0, 1).x;
  p.z = S(0, 1).z + 1;
  game.handleInput('a', { plant: 1 });
  run(game, 0.5); // key held for many ticks
  assert.equal(p.sunshine, 450);
  game.handleInput('a', { plant: 0 });
  game.handleInput('a', { plant: 1 });
  p.x = S(0, 3).x; // another empty front-row slot
  p.z = S(0, 3).z + 1;
  game.tick(1 / 30);
  assert.equal(p.sunshine, 400);
  // a tap that is released before the next tick still plants
  game.handleInput('a', { plant: 0 });
  p.x = S(1, 1).x;
  p.z = S(1, 1).z + 1;
  game.handleInput('a', { plant: 2 });
  game.handleInput('a', { plant: 0 });
  game.tick(1 / 30);
  assert.equal(p.sunshine, 300);
});

test('plantSeq: back-to-back presses of the same key each plant, with no zero in between', () => {
  const { game, p } = plantGame();
  p.sunshine = 500;
  p.x = (S(0, 0).x + S(0, 1).x) / 2; // between two empty front-row slots
  p.z = S(0, 0).z + 1;
  assert.equal(game.gardenCount(), 0);
  game.handleInput('a', { plant: 1, plantSeq: 1 });
  game.handleInput('a', { plant: 1, plantSeq: 2 }); // arrives in the same tick, never released
  game.tick(1 / 30);
  assert.equal(game.gardenCount(), 2);
  p.x = (S(0, 2).x + S(0, 3).x) / 2; // the other two slots
  game.handleInput('a', { plant: 1, plantSeq: 3 });
  game.tick(1 / 30);
  game.handleInput('a', { plant: 1, plantSeq: 4 });
  game.tick(1 / 30);
  assert.equal(game.gardenCount(), 4);
  assert.equal(p.sunshine, 300);
});

test('plantSeq: resending the same sequence number never plants twice; a new number plants again', () => {
  const { game, p } = plantGame();
  p.sunshine = 500;
  p.x = (S(0, 0).x + S(0, 1).x) / 2;
  p.z = S(0, 0).z + 1;
  for (let i = 0; i < 10; i++) {
    game.handleInput('a', { plant: 1, plantSeq: 5 });
    game.tick(1 / 30);
  }
  assert.equal(game.gardenCount(), 1);
  game.handleInput('a', { plant: 0, plantSeq: 5 });
  game.tick(1 / 30);
  game.handleInput('a', { plant: 1, plantSeq: 6 });
  game.tick(1 / 30);
  assert.equal(game.gardenCount(), 2);
  game.handleInput('a', { plant: 1, plantSeq: 6 });
  game.handleInput('a', { plant: 1, plantSeq: 4 }); // stale / out-of-order numbers are ignored
  run(game, 0.3);
  assert.equal(game.gardenCount(), 2);
});

test('plantSeq: junk values are ignored', () => {
  const { game, p } = plantGame();
  p.sunshine = 500;
  p.x = (S(0, 0).x + S(0, 1).x) / 2;
  p.z = S(0, 0).z + 1;
  for (const bad of ['1', 1.5, -3, NaN, Infinity, null, {}, [1]]) {
    game.handleInput('a', { plant: 1, plantSeq: bad });
    game.tick(1 / 30);
  }
  game.handleInput('a', { plant: 0, plantSeq: 0 });
  game.tick(1 / 30);
  // legacy edge-triggered clients (no plantSeq) still work
  game.handleInput('a', { plant: 1 });
  game.tick(1 / 30);
  assert.equal(game.gardenCount(), 1);
});

function fixedPlantTypes(over) {
  return {
    peashooter: { ...DEFAULT_CONFIG.plantTypes.peashooter, ...over.peashooter },
    cactus: { ...DEFAULT_CONFIG.plantTypes.cactus, ...over.cactus },
  };
}

test('cactus turret hits zombie 40 m away', () => {
  const { game } = plantGame({ plantTypes: fixedPlantTypes({ cactus: { aimError: 0 } }) });
  const cactus = plantAt(game, slotIdx(0, 1, 1));
  const zombie = game.spawnBot('zombie', cactus.x, cactus.z - 40);
  const dist = Math.hypot(zombie.x - cactus.x, zombie.z - cactus.z);
  assert.equal(dist, 40);
  for (let i = 0; i < 90 && zombie.team === 'zombie'; i++) {
    stepGarden(game, 1 / 30);
    stepProjectiles(game, 1 / 30);
  }
  // 3 damage per spike vs 5 hp: converted after 2 hits
  assert.ok(zombie.hp < DEFAULT_CONFIG.zombieHp || zombie.team === 'plant');
  const hits = game.drainEvents().filter((e) => e.type === 'hit' && e.id === zombie.id);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].dmg, DEFAULT_CONFIG.plantTypes.cactus.damage);
  assert.equal(DEFAULT_CONFIG.plantTypes.cactus.damage, 3);
  assert.equal(hits[0].by, cactus.id);
});

test('turrets are inaccurate at range but still land hits on a distant stationary zombie', () => {
  const { game } = plantGame();
  const cactus = plantAt(game, slotIdx(0, 1, 1));
  const zombie = game.spawnBot('zombie', cactus.x, cactus.z - 40);
  zombie.hp = zombie.maxHp = 1e6;
  let shots = 0;
  const seen = new Set();
  let hits = 0;
  for (let i = 0; i < 30 * 300; i++) {
    stepGarden(game, 1 / 30);
    for (const p of entitiesOfKind(game, 'projectile')) if (!seen.has(p.id)) { seen.add(p.id); shots++; }
    stepProjectiles(game, 1 / 30);
    hits += game.drainEvents().filter((e) => e.type === 'hit' && e.id === zombie.id).length;
  }
  assert.ok(hits >= 1, 'lands at least some hits');
  assert.ok(hits < shots * 0.25, `inaccurate at 40 m: ${hits}/${shots}`);
});

test('turret ranges: peashooter 25 m, cactus 50 m; turrets ignore plants and never shoot out of range', () => {
  const { game } = plantGame();
  const pea = plantAt(game, slotIdx(0, 0, 1));
  game.spawnBot('zombie', pea.x, pea.z - 26);
  game.spawnBot('plant', pea.x, pea.z - 10);
  for (let i = 0; i < 90; i++) stepGarden(game, 1 / 30);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0);
  game.spawnBot('zombie', pea.x, pea.z - 20);
  stepGarden(game, 1 / 30);
  for (let i = 0; i < 60; i++) stepGarden(game, 1 / 30);
  const shots = entitiesOfKind(game, 'projectile');
  assert.ok(shots.length >= 1);
  assert.ok(shots.every((s) => s.team === 'plant' && s.projKind === 'pea'));
  assert.ok(pea.yaw !== 0 || pea.pitch !== 0, 'turret aims at its target');
});

test('turret fire rate: peashooter ~1.5/s', () => {
  const { game } = plantGame();
  const pea = plantAt(game, slotIdx(0, 0, 1));
  game.spawnBot('zombie', pea.x, pea.z - 10);
  const seen = new Set();
  for (let i = 0; i < 30 * 10; i++) {
    stepGarden(game, 1 / 30);
    for (const p of entitiesOfKind(game, 'projectile')) seen.add(p.id);
    stepProjectiles(game, 1 / 30);
    // keep the target alive and stationary
    for (const e of game.entities.values()) if (e.kind === 'bot') { e.hp = e.maxHp; e.team = 'zombie'; }
  }
  assert.ok(seen.size >= 13 && seen.size <= 17, `peashooter shots in 10 s: ${seen.size}`);
});

test('sun pickup adds 25', () => {
  const { game, p } = plantGame();
  p.x = 30;
  p.z = -30;
  const sun = spawnSun(game, 30, -30, { landed: true });
  assert.equal(entitiesOfKind(game, 'sun').length, 1);
  stepSun(game, 1 / 30);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine + 25);
  assert.equal(game.entities.has(sun.id), false);
});

test('sun is not collected from afar, by zombies, or while still falling', () => {
  const game = makeGame();
  const p = game.addPlayer('p', { team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { team: 'zombie' });
  p.x = 0;
  p.z = -30;
  z.x = 10;
  z.z = -20;
  spawnSun(game, 5, -25, { landed: true }); // 7 m from the plant
  spawnSun(game, 10, -20, { landed: true }); // under a zombie
  stepSun(game, 1 / 30);
  assert.equal(entitiesOfKind(game, 'sun').length, 2);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine);
  const falling = spawnSun(game, 0, -30);
  assert.ok(falling.y > DEFAULT_CONFIG.sunRestHeight);
  stepSun(game, 1 / 30);
  assert.ok(game.entities.has(falling.id), 'still falling, not picked up');
  for (let i = 0; i < 30 * 5; i++) stepSun(game, 1 / 30);
  assert.equal(game.entities.has(falling.id), false, 'picked up after landing');
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine + 25);
});

test('sun drops on a timer in the yard and expires after 30 s; none without a plant human', () => {
  const game = makeGame({ features: { sunDrops: true } });
  const p = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  p.x = 38; // far from the drop area so nothing gets collected
  p.z = 45;
  run(game, DEFAULT_CONFIG.sunDropInterval - 0.2);
  assert.equal(entitiesOfKind(game, 'sun').length, 0);
  run(game, 0.5);
  const suns = entitiesOfKind(game, 'sun');
  assert.equal(suns.length, 1);
  assert.ok(suns[0].z >= DEFAULT_CONFIG.sunDropZ[0] && suns[0].z <= DEFAULT_CONFIG.sunDropZ[1], `sun z=${suns[0].z}`);
  assert.ok(suns[0].x >= WORLD.bounds.minX && suns[0].x <= WORLD.bounds.maxX);
  const firstId = suns[0].id;
  run(game, 30);
  assert.equal(game.entities.has(firstId), false, 'expired');
  assert.ok(entitiesOfKind(game, 'sun').length <= DEFAULT_CONFIG.sunMaxActive, 'never more than sunMaxActive at once');

  const zgame = makeGame({ features: { sunDrops: true } });
  zgame.addPlayer('z', { team: 'zombie', mode: 'coop' });
  run(zgame, 20);
  assert.equal(entitiesOfKind(zgame, 'sun').length, 0);
});

test('converting a zombie human gives the plant attacker +25 sunshine; a bot drops a 25 sun pickup instead', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { team: 'zombie' });
  a.x = 20; // out of pickup reach of the bot's spot
  a.z = -30;
  const bot = game.spawnBot('zombie', 0, -30);
  applyDamage(game, bot, 99, a);
  assert.equal(a.sunshine, DEFAULT_CONFIG.startSunshine, 'not paid directly');
  assert.equal(entitiesOfKind(game, 'sun').length, 1);
  a.x = 0;
  a.z = -30;
  game.tick(1 / 30);
  assert.equal(a.sunshine, DEFAULT_CONFIG.startSunshine + 25);
  applyDamage(game, z, 99, a);
  assert.equal(z.state, 'sprout');
  assert.equal(a.sunshine, DEFAULT_CONFIG.startSunshine + 50);
  // zombie damage on plants gives no sunshine
  const pbot = game.spawnBot('plant', 5, -20);
  applyDamage(game, pbot, 999, z);
  assert.equal(z.sunshine, undefined);
});

test('zombie fire destroys garden plants, frees the slot, and counts as a kill', () => {
  const game = makeGame();
  const z = game.addPlayer('z', { team: 'zombie', mode: 'coop' });
  const plant = plantAt(game, slotIdx(0, 0, 1));
  assert.equal(game.gardenCount(), 1);
  z.x = plant.x;
  z.z = plant.z - 12;
  z.yaw = Math.PI; // facing +z
  z.pitch = Math.atan2(0.6 - DEFAULT_CONFIG.eyeHeight, 12); // plants are low: aim down at the stem
  z.input.fire = true;
  for (let i = 0; i < 30 * 5 && game.gardenCount() > 0; i++) game.tick(1 / 30);
  assert.equal(game.gardenCount(), 0);
  assert.equal(plant.state, 'dead');
  assert.equal(z.progress, 1);
  const wilt = game.drainEvents().find((e) => e.type === 'wilt' && e.id === plant.id);
  assert.ok(wilt && wilt.plantKind === 'peashooter');
  // the freed slot can be replanted
  const p = game.addPlayer('p', { team: 'plant' });
  p.x = plant.x;
  p.z = plant.z + 1;
  assert.ok(tryPlant(game, p, 'peashooter'));
});

test('garden entities serialize with plant kind and aim', () => {
  const { game } = plantGame();
  plantAt(game, 0);
  const g = game.snapshot().entities.find((e) => e.kind === 'garden');
  assert.equal(g.plantKind, 'peashooter');
  assert.equal(g.team, 'plant');
  assert.equal(g.hp, 60);
  assert.equal(g.maxHp, 60);
  assert.equal(g.state, 'alive');
});
