import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { plantAt, plantMaxHp } from '../server/sim/garden.js';
import { spawnProjectile } from '../server/sim/combat.js';
import { makeGame, run, entitiesOfKind, slotIdx, keys } from './helpers.js';

const D = DEFAULT_CONFIG.difficulties;
const T = (level, k) => D[level].tough[k] ?? 1;

/** teams: ['plant'], ['zombie'] or both; features that matter on. */
function lobby(level, teams, { features = {}, config = {} } = {}) {
  const game = makeGame({ features: { gardener: true, botAI: true, waves: true, headStart: false, ...features }, ...config });
  teams.forEach((team, i) => game.addPlayer(`h${i}`, { team, mode: teams.length > 1 ? 'versus' : 'coop', difficulty: level }));
  return game;
}
const bots = (game, team) => entitiesOfKind(game, 'bot').filter((b) => b.team === team && !b.isGardener);

test('the level toughens the team the kids are fighting: plants only -> zombies, zombies only -> plants, both -> zombies (full) and plants (half)', () => {
  const plants = lobby('insane', ['plant']);
  assert.equal(plants.scaling.mode, 'zombie');
  assert.equal(plants.zombieLevel(), D.insane);
  assert.equal(plants.scaling.share, 0);
  assert.deepEqual(plants.scaling.plant, { door: 1, repair: 1, plantHp: 1, plantDmg: 1, plantRate: 1, potHp: 1 });

  const zombies = lobby('insane', ['zombie']);
  assert.equal(zombies.scaling.mode, 'plant');
  assert.equal(zombies.zombieLevel(), D.normal, 'the kid\'s zombie allies stay at Normal');
  assert.equal(zombies.scaling.share, 1);
  assert.equal(zombies.scaling.plant.door, D.insane.tough.door);
  assert.equal(zombies.scaling.plant.plantHp, D.insane.tough.plantHp);

  const versus = lobby('insane', ['plant', 'zombie']);
  assert.equal(versus.scaling.mode, 'both');
  assert.equal(versus.zombieLevel(), D.insane);
  assert.equal(versus.scaling.share, 0.5);
  assert.equal(versus.scaling.plant.door, 1 + (D.insane.tough.door - 1) / 2);
  assert.equal(versus.scaling.plant.plantDmg, 1 + (D.insane.tough.plantDmg - 1) / 2);
});

test('Easy and Normal toughen nothing, whoever plays', () => {
  for (const level of ['easy', 'normal']) {
    for (const teams of [['plant'], ['zombie'], ['plant', 'zombie']]) {
      const g = lobby(level, teams);
      assert.deepEqual(g.scaling.plant, { door: 1, repair: 1, plantHp: 1, plantDmg: 1, plantRate: 1, potHp: 1 }, `${level} ${teams}`);
    }
  }
  assert.equal(lobby('easy', ['zombie']).zombieLevel(), D.normal, 'Easy plant side = Normal; the kid\'s allies are Normal bots');
});

test('the side is recomputed when kids join or leave (what already exists keeps its numbers)', () => {
  const game = lobby('insane', ['zombie'], { features: { gardener: false } });
  assert.equal(game.scaling.mode, 'plant');
  const door = game.cover.get('door:front');
  assert.equal(door.maxHp, 220 * T('insane', 'door'));
  game.addPlayer('p', { team: 'plant', mode: 'versus' });
  assert.equal(game.scaling.mode, 'both');
  assert.equal(door.maxHp, 220 * 3, 'the round\'s doors stay as they were made');
  const early = plantAt(game, 0, 'peashooter');
  assert.equal(early.maxHp, plantMaxHp(DEFAULT_CONFIG, 'peashooter', 1, 1 + (T('insane', 'plantHp') - 1) / 2), 'a new plant: half strength in versus');
  game.removePlayer('h0');
  assert.equal(game.scaling.mode, 'zombie');
  assert.equal(plantAt(game, 1, 'peashooter').maxHp, DEFAULT_CONFIG.gardenPlantHp, 'only plants left: no toughness');
  game.startRound();
  assert.equal(game.cover.get('door:front').maxHp, 220, 'next round: doors at their normal strength');
});

test('zombie bots: the level\'s wave size, HP, speed and smarts only when kids are on the plants', () => {
  const first = (teams, level) => {
    const game = lobby(level, teams, { features: { gardener: false, headStart: false } });
    game.roundTime = 5.5;
    game.tick(1 / 30);
    return bots(game, 'zombie');
  };
  const normalWave = first(['plant'], 'normal');
  const insanePlants = first(['plant'], 'insane');
  const insaneZombieKid = first(['zombie'], 'insane');
  const insaneVersus = first(['plant', 'zombie'], 'insane');
  assert.ok(insanePlants.length > normalWave.length, `${insanePlants.length} vs ${normalWave.length}`);
  assert.equal(insaneZombieKid.length, normalWave.length, 'the zombie kid\'s allies: Normal-sized waves');
  assert.equal(insaneVersus.length, insanePlants.length, 'versus: the bots get the level');
  assert.ok(insanePlants.every((b) => Math.abs(b.maxHp - DEFAULT_CONFIG.zombieHp * D.insane.hp) < 1e-9));
  assert.ok(insaneZombieKid.every((b) => b.maxHp === DEFAULT_CONFIG.zombieHp));
  assert.ok(insaneVersus.every((b) => b.maxHp === DEFAULT_CONFIG.zombieHp * D.insane.hp));
});

test('plant side: door HP, plant HP, damage, fire rate, pot HP, repair speed and the Gardeners follow the level when the kids are zombies', () => {
  const zombies = lobby('insane', ['zombie']);
  const plain = lobby('normal', ['zombie']);
  // doors
  for (const id of ['front', 'side', 'back', 'garage']) assert.equal(zombies.cover.get(`door:${id}`).maxHp, Math.round(DEFAULT_CONFIG.doorHp[id] * 3), id);
  assert.deepEqual(zombies.snapshot().doorMax, [660, 660, 660, 1080]);
  assert.deepEqual(plain.snapshot().doorMax, [220, 220, 220, 360]);
  assert.deepEqual(zombies.snapshot().doors, [660, 660, 660, 1080]);
  // plants
  const p = plantAt(zombies, slotIdx(0, 0, 0), 'cactus');
  assert.equal(p.maxHp, Math.round(60 * 2));
  // a turret's shots hurt more and come faster
  const shotsAndDamage = (game) => {
    const pl = plantAt(game, slotIdx(0, 3, 1), 'peashooter');
    pl.cooldown = 0;
    const z = game.spawnBot('zombie', pl.x, pl.z - 12);
    z.hp = z.maxHp = 1e9;
    const j0 = game._ids.j ?? 0;
    let dmg = 0;
    for (let i = 0; i < 30 * 12; i++) {
      game.tick(1 / 30);
      for (const q of entitiesOfKind(game, 'projectile')) dmg = Math.max(dmg, q.damage);
    }
    return { n: (game._ids.j ?? 0) - j0, dmg };
  };
  const a = shotsAndDamage(lobby('insane', ['zombie'], { features: { gardener: false, waves: false, botAI: false, cover: false } }));
  const b = shotsAndDamage(lobby('normal', ['zombie'], { features: { gardener: false, waves: false, botAI: false, cover: false } }));
  assert.equal(b.dmg, 1);
  assert.equal(a.dmg, 1.5, 'x1.5 damage');
  assert.ok(Math.abs(a.n / b.n - 1.25) < 0.1, `shots ${a.n} vs ${b.n}: x1.25 fire rate`);
  // pots: more HP
  const pg = lobby('insane', ['zombie'], { features: { gardener: false, waves: false, botAI: false } });
  const kid = pg.addPlayer('k', { team: 'plant' }); // joins: versus now, half strength
  kid.x = -5;
  kid.z = 11;
  kid.sunshine = 100;
  pg.removePlayer('h0'); // plants only: no toughness at all
  assert.equal(pg.scaling.plant.potHp, 1);
  // Gardeners
  run(zombies, 0.5);
  const gs = entitiesOfKind(zombies, 'bot').filter((b) => b.isGardener);
  assert.equal(gs.length, 2);
  assert.ok(gs.every((g) => g.maxHp === 200 && g.hp === 200));
  const hard = lobby('hard', ['zombie']);
  run(hard, 0.5);
  assert.equal(entitiesOfKind(hard, 'bot').find((b) => b.isGardener).maxHp, D.hard.gardener.hp);
  const norm = lobby('normal', ['zombie']);
  run(norm, 0.5);
  assert.equal(entitiesOfKind(norm, 'bot').find((b) => b.isGardener).maxHp, DEFAULT_CONFIG.plantHp, 'the basic Gardener is unchanged');
});

test('pots and repair follow the level: tougher pots, faster mending (zombie kids only)', () => {
  const build = (level) => {
    const game = lobby(level, ['zombie'], { features: { gardener: false, waves: false, botAI: false } });
    const g = makeGame({ features: { cover: false } });
    void g;
    const owner = { id: 'own', team: 'plant', kind: 'player', sunshine: 1000, x: -2, z: 11, y: 0, state: 'alive' };
    const idx = DEFAULT_CONFIG.builds.plant.findIndex((d) => d.pot);
    const def = DEFAULT_CONFIG.builds.plant[idx];
    const piece = game.cover.addBuild(def, owner, -5, 11, 0, { lo: 0, hi: 0 });
    return { piece, game };
  };
  assert.equal(build('normal').piece.maxHp, 90);
  assert.equal(build('insane').piece.maxHp, 90 * 3);
  // repair speed: a repairer at the front pile heals 9 HP/s x the level's factor
  const rate = (level) => {
    const game = lobby(level, ['zombie'], { features: { gardener: false, waves: false, botAI: false } });
    const p = game.addPlayer('p', { team: 'plant', mode: 'versus' });
    game.removePlayer('h0'); // plants only
    void p;
    const z = game.addPlayer('z', { team: 'zombie' });
    z.x = 30;
    z.z = -30;
    game.scaling.plant = { ...game.scaling.plant, repair: D[level].tough.repair ?? 1 }; // as if the kids were zombies and a Gardener mended
    const door = game.cover.get('door:front');
    door.hp = 10;
    p.x = WORLD.repair[0].x;
    p.z = WORLD.repair[0].z;
    p.y = 0;
    game.handleInput('p', { use: true, keys: keys() });
    run(game, 2);
    return (door.hp - 10) / 2;
  };
  assert.ok(Math.abs(rate('normal') - 9) < 0.7);
  assert.ok(Math.abs(rate('insane') - 9 * 1.5) < 1);
});
