import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD, gardenSlots } from '../server/sim/world.js';
import { initGarden, tryPlant, stepGarden, stepSun, spawnSun, plantAt } from '../server/sim/garden.js';
import { stepProjectiles, applyDamage } from '../server/sim/combat.js';
import { makeGame, run, entitiesOfKind } from './helpers.js';

const gardenOf = (game) => entitiesOfKind(game, 'garden');

function plantGame(overrides = {}) {
  const game = makeGame(overrides);
  const p = game.addPlayer('a', { name: 'A', team: 'plant', mode: 'coop', difficulty: 'normal' });
  return { game, p };
}

test('initGarden plants 20 (every other column, all rows)', () => {
  const { game } = plantGame();
  assert.equal(gardenOf(game).length, 0);
  initGarden(game);
  const plants = gardenOf(game);
  assert.equal(plants.length, 20);
  assert.equal(game.gardenCount(), 20);
  assert.equal(plants.filter((g) => g.plantKind === 'peashooter').length, 10);
  assert.equal(plants.filter((g) => g.plantKind === 'cactus').length, 10);
  for (const g of plants) {
    assert.equal(g.team, 'plant');
    assert.equal(g.hp, DEFAULT_CONFIG.gardenPlantHp);
    assert.equal(g.state, 'alive');
  }
  const slots = gardenSlots();
  for (const g of plants) {
    const idx = slots.findIndex((s) => s.x === g.x && s.z === g.z);
    assert.ok(idx >= 0 && (idx % 9) % 2 === 0, `plant at slot ${idx}`);
    assert.equal(slots[idx].kind, g.plantKind);
  }
  initGarden(game); // idempotent: occupied slots are skipped
  assert.equal(gardenOf(game).length, 20);
});

test('round start pre-plants the garden when the feature is on, and resets sunshine', () => {
  const game = makeGame({ features: { initialGarden: true } });
  const p = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  assert.equal(game.gardenCount(), 20);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine);
  const z = game.addPlayer('z', { team: 'zombie' });
  assert.equal(z.sunshine, undefined);
  p.sunshine = 3;
  applyDamage(game, gardenOf(game)[0], 1000, null);
  assert.equal(game.gardenCount(), 19);
  game.startRound();
  assert.equal(game.gardenCount(), 20);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine);
});

test('tryPlant succeeds near an empty peashooter slot and costs 50', () => {
  const { game, p } = plantGame();
  initGarden(game);
  p.x = -12;
  p.z = -1; // next to the empty front-row slot at x=-12
  const before = game.gardenCount();
  const plant = tryPlant(game, p, 'peashooter');
  assert.ok(plant);
  assert.equal(plant.kind, 'garden');
  assert.equal(plant.plantKind, 'peashooter');
  assert.equal(plant.x, -12);
  assert.equal(plant.z, 0);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine - 50);
  assert.equal(game.gardenCount(), before + 1);
  const ev = game.drainEvents().find((e) => e.type === 'plant');
  assert.ok(ev && ev.id === plant.id && ev.plantKind === 'peashooter' && ev.by === 'a');
  // the slot is now taken: a second attempt in the same spot finds nothing nearby
  p.sunshine = 500;
  p.x = -12;
  p.z = -3.5;
  assert.equal(tryPlant(game, p, 'peashooter'), null);
});

test('tryPlant only plants a kind in its own row (cactus goes to cactus rows)', () => {
  const { game, p } = plantGame();
  initGarden(game);
  p.sunshine = 500;
  p.x = -12;
  p.z = 0.5; // front (peashooter) row slot at (-12,0) is empty, but cactus rows are 3.5 m+ away
  const cactus = tryPlant(game, p, 'cactus');
  assert.ok(cactus);
  assert.equal(cactus.plantKind, 'cactus');
  assert.equal(cactus.z, 4);
  assert.equal(p.sunshine, 500 - 100);
});

test('tryPlant with 40 sunshine is a no-op', () => {
  const { game, p } = plantGame();
  initGarden(game);
  p.x = -12;
  p.z = -1;
  p.sunshine = 40;
  const before = game.gardenCount();
  game.drainEvents();
  assert.equal(tryPlant(game, p, 'peashooter'), null);
  assert.equal(p.sunshine, 40);
  assert.equal(game.gardenCount(), before);
  assert.deepEqual(game.drainEvents(), []);
  p.sunshine = 99;
  p.z = 3;
  assert.equal(tryPlant(game, p, 'cactus'), null, 'cactus costs 100');
  assert.equal(p.sunshine, 99);
});

test('tryPlant with no free slot within 4 m is a no-op', () => {
  const { game, p } = plantGame();
  initGarden(game);
  // spawn is ~14 m from the nearest row
  assert.equal(tryPlant(game, p, 'peashooter'), null);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine);
  // right at an occupied slot with all neighbours >4 m away or occupied: stand far left of the garden
  p.x = -28;
  p.z = 6;
  assert.equal(tryPlant(game, p, 'cactus'), null);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine);
  assert.equal(game.gardenCount(), 20);
});

test('only living plant humans can plant', () => {
  const game = makeGame();
  const z = game.addPlayer('z', { team: 'zombie', mode: 'coop' });
  const p = game.addPlayer('p', { team: 'plant' });
  initGarden(game);
  z.sunshine = 500;
  z.x = -12;
  z.z = -1;
  assert.equal(tryPlant(game, z, 'peashooter'), null);
  p.x = -12;
  p.z = -1;
  p.state = 'wilted';
  assert.equal(tryPlant(game, p, 'peashooter'), null);
  assert.equal(tryPlant(game, p, 'nonsense'), null);
  assert.equal(tryPlant(game, null, 'cactus'), null);
});

test('planting via input is edge-triggered', () => {
  const { game, p } = plantGame();
  initGarden(game);
  p.sunshine = 500;
  p.x = -12;
  p.z = -1;
  game.handleInput('a', { plant: 1 });
  run(game, 0.5); // key held for many ticks
  assert.equal(p.sunshine, 450);
  game.handleInput('a', { plant: 0 });
  game.handleInput('a', { plant: 1 });
  p.x = -4; // another empty front-row slot (x=-4)
  p.z = -1;
  game.tick(1 / 30);
  assert.equal(p.sunshine, 400);
  // a tap that is released before the next tick still plants
  game.handleInput('a', { plant: 0 });
  p.x = 4;
  game.handleInput('a', { plant: 2 });
  game.handleInput('a', { plant: 0 });
  p.z = 3;
  game.tick(1 / 30);
  assert.equal(p.sunshine, 300);
});

function fixedPlantTypes(over) {
  return {
    peashooter: { ...DEFAULT_CONFIG.plantTypes.peashooter, ...over.peashooter },
    cactus: { ...DEFAULT_CONFIG.plantTypes.cactus, ...over.cactus },
  };
}

test('cactus turret hits zombie 40 m away', () => {
  const { game } = plantGame({ plantTypes: fixedPlantTypes({ cactus: { aimError: 0 } }) });
  const idx = gardenSlots().findIndex((s) => s.kind === 'cactus' && s.x === 0 && s.z === 4);
  const cactus = plantAt(game, idx);
  const zombie = game.spawnBot('zombie', 0, 4 - 40);
  const dist = Math.hypot(zombie.x - cactus.x, zombie.z - cactus.z);
  assert.equal(dist, 40);
  for (let i = 0; i < 90 && zombie.team === 'zombie'; i++) {
    stepGarden(game, 1 / 30);
    stepProjectiles(game, 1 / 30);
  }
  // 2 damage per spike vs 5 hp: converted after 3 hits (~3.75 s) -- stop earlier to inspect
  assert.ok(zombie.hp < DEFAULT_CONFIG.zombieHp || zombie.team === 'plant');
  const hits = game.drainEvents().filter((e) => e.type === 'hit' && e.id === zombie.id);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].dmg, 2);
  assert.equal(hits[0].by, cactus.id);
});

test('turrets are inaccurate at range but still land hits on a distant stationary zombie', () => {
  const { game } = plantGame();
  const idx = gardenSlots().findIndex((s) => s.kind === 'cactus' && s.x === 0 && s.z === 4);
  plantAt(game, idx);
  const zombie = game.spawnBot('zombie', 0, 4 - 40);
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
  const pea = plantAt(game, gardenSlots().findIndex((s) => s.kind === 'peashooter' && s.x === 0 && s.z === 0));
  game.spawnBot('zombie', 0, -26);
  game.spawnBot('plant', 0, -10);
  for (let i = 0; i < 90; i++) stepGarden(game, 1 / 30);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0);
  game.spawnBot('zombie', 0, -20);
  stepGarden(game, 1 / 30);
  for (let i = 0; i < 60; i++) stepGarden(game, 1 / 30);
  const shots = entitiesOfKind(game, 'projectile');
  assert.ok(shots.length >= 1);
  assert.ok(shots.every((s) => s.team === 'plant' && s.projKind === 'pea'));
  assert.ok(pea.yaw !== 0 || pea.pitch !== 0, 'turret aims at its target');
});

test('turret fire rate: peashooter ~1.5/s', () => {
  const { game } = plantGame();
  plantAt(game, gardenSlots().findIndex((s) => s.kind === 'peashooter' && s.x === 0 && s.z === 0));
  game.spawnBot('zombie', 0, -10);
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
  p.x = 3;
  p.z = 3;
  const sun = spawnSun(game, 3, 3, { landed: true });
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
  p.z = 0;
  z.x = 10;
  z.z = 10;
  spawnSun(game, 5, 5, { landed: true }); // 7 m from the plant
  spawnSun(game, 10, 10, { landed: true }); // under a zombie
  stepSun(game, 1 / 30);
  assert.equal(entitiesOfKind(game, 'sun').length, 2);
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine);
  const falling = spawnSun(game, 0, 0);
  assert.ok(falling.y > DEFAULT_CONFIG.sunRestHeight);
  stepSun(game, 1 / 30);
  assert.ok(game.entities.has(falling.id), 'still falling, not picked up');
  for (let i = 0; i < 30 * 5; i++) stepSun(game, 1 / 30);
  assert.equal(game.entities.has(falling.id), false, 'picked up after landing');
  assert.equal(p.sunshine, DEFAULT_CONFIG.startSunshine + 25);
});

test('sun drops every 8 s in the yard and expires after 30 s; none without a plant human', () => {
  const game = makeGame({ features: { sunDrops: true } });
  const p = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  p.x = 29; // far from the drop area so nothing gets collected
  p.z = 29;
  run(game, 7.8);
  assert.equal(entitiesOfKind(game, 'sun').length, 0);
  run(game, 0.5);
  const suns = entitiesOfKind(game, 'sun');
  assert.equal(suns.length, 1);
  assert.ok(suns[0].z >= -30 && suns[0].z <= 20, `sun z=${suns[0].z}`);
  assert.ok(suns[0].x >= WORLD.bounds.minX && suns[0].x <= WORLD.bounds.maxX);
  const firstId = suns[0].id;
  run(game, 30);
  assert.equal(game.entities.has(firstId), false, 'expired');

  const zgame = makeGame({ features: { sunDrops: true } });
  zgame.addPlayer('z', { team: 'zombie', mode: 'coop' });
  run(zgame, 20);
  assert.equal(entitiesOfKind(zgame, 'sun').length, 0);
});

test('converting a zombie gives the plant attacker +25 sunshine', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { team: 'zombie' });
  const bot = game.spawnBot('zombie', 0, 0);
  applyDamage(game, bot, 99, a);
  assert.equal(a.sunshine, DEFAULT_CONFIG.startSunshine + 25);
  applyDamage(game, z, 99, a);
  assert.equal(z.state, 'sprout');
  assert.equal(a.sunshine, DEFAULT_CONFIG.startSunshine + 50);
  // zombie damage on plants gives no sunshine
  const pbot = game.spawnBot('plant', 5, 5);
  applyDamage(game, pbot, 999, z);
  assert.equal(z.sunshine, undefined);
});

test('zombie fire destroys garden plants, frees the slot, and counts as a kill', () => {
  const game = makeGame();
  const z = game.addPlayer('z', { team: 'zombie', mode: 'coop' });
  const slot = gardenSlots().findIndex((s) => s.kind === 'peashooter' && s.x === 0 && s.z === 0);
  const plant = plantAt(game, slot);
  assert.equal(game.gardenCount(), 1);
  z.x = 0;
  z.z = -12;
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
  p.x = 0;
  p.z = -1;
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
