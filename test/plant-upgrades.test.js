import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, publicConfig } from '../server/sim/config.js';
import { gardenSlots } from '../server/sim/world.js';
import { PLANT_LADDER } from '../server/sim/weapons.js';
import { plantAt, tryPlant, tryUpgrade, upgradeCost, levelScale, pickUpgradeTarget, stepGarden } from '../server/sim/garden.js';
import { recordKill, recordHurt } from '../server/sim/upgrades.js';
import { applyDamage, stepProjectiles } from '../server/sim/combat.js';
import { makeGame, run, entitiesOfKind } from './helpers.js';

const TYPES = DEFAULT_CONFIG.plantTypes;
const ORDER = ['peashooter', 'cactus', 'repeater', 'snowpea', 'spikesquash', 'melonpult', 'wallnut', 'gatling', 'houseplant'];

function plantGame(overrides) {
  const game = makeGame(overrides);
  const p = game.addPlayer('a', { name: 'A', team: 'plant', mode: 'coop', difficulty: 'normal' });
  p.sunshine = 5000;
  return { game, p };
}

const slotAt = (x, z) => gardenSlots().findIndex((s) => s.x === x && s.z === z);

function kills(game, p, n) {
  for (let i = 0; i < n; i++) {
    recordKill(game, p);
    recordHurt(p);
  }
}

// ---- roster and unlocks ------------------------------------------------------------------

test('nine plant types in unlock order, tiers 0,0,1..7, costs roughly rising from 50 to 300', () => {
  assert.deepEqual(Object.keys(TYPES), ORDER);
  assert.deepEqual(ORDER.map((k) => TYPES[k].tier), [0, 0, 1, 2, 3, 4, 5, 6, 7]);
  const costs = ORDER.map((k) => TYPES[k].cost);
  assert.equal(costs[0], 50);
  assert.equal(costs.at(-1), 300);
  assert.ok(Math.max(...costs) === costs.at(-1) && Math.min(...costs) === costs[0]);
  assert.equal(TYPES.peashooter.cost, 50);
  assert.equal(TYPES.cactus.cost, 100);
  for (const k of ORDER) {
    assert.equal(typeof TYPES[k].name, 'string', `${k} name`);
    if (!TYPES[k].noAttack) for (const f of ['range', 'rate', 'damage', 'speed', 'projKind']) assert.ok(TYPES[k][f] > 0 || typeof TYPES[k][f] === 'string', `${k}.${f}`);
  }
  assert.equal(TYPES.snowpea.slow.factor, 0.5);
  assert.equal(TYPES.snowpea.slow.secs, 2);
  assert.equal(TYPES.spikesquash.pellets, 8);
  assert.ok(TYPES.melonpult.splash > 1 && TYPES.melonpult.gravity > 0);
  assert.equal(TYPES.wallnut.noAttack, true);
  assert.equal(TYPES.wallnut.blocks, true);
  assert.ok(TYPES.wallnut.hp >= 5 * DEFAULT_CONFIG.gardenPlantHp);
  assert.ok(TYPES.houseplant.damage >= DEFAULT_CONFIG.zombieHp, 'one-hit convert');
  assert.ok(TYPES.houseplant.rate < TYPES.peashooter.rate, 'slow fire');
  assert.ok(TYPES.houseplant.height > 2.5);
  assert.ok(TYPES.gatling.rate > TYPES.repeater.rate && TYPES.repeater.rate > TYPES.peashooter.rate);
});

test('plant kids keep ONE gun (Pea Blaster) through every tier; the zombie ladder is unchanged', () => {
  assert.deepEqual(PLANT_LADDER.map((w) => w.id), ['pea_blaster']);
  const { game, p } = plantGame();
  kills(game, p, 23);
  assert.equal(p.tier, 7);
  assert.equal(p.weapon, 'pea_blaster');
  const z = game.addPlayer('z', { team: 'zombie' });
  kills(game, z, 23);
  assert.equal(z.tier, 7);
  assert.equal(z.weapon, 'auto_shot_rifle');
  assert.equal(publicConfig().weapons.plant.length, 1);
  assert.equal(publicConfig().weapons.zombie.length, 8);
});

test('each tier unlocks the next plant: upgrade event carries plantKind and name', () => {
  const { game, p } = plantGame();
  const th = DEFAULT_CONFIG.tierThresholds;
  for (let t = 1; t < th.length; t++) {
    game.drainEvents();
    kills(game, p, th[t] - p.progress);
    assert.equal(p.tier, t);
    const ev = game.drainEvents().filter((e) => e.type === 'upgrade');
    assert.equal(ev.length, 1, `one upgrade event at tier ${t}`);
    assert.equal(ev[0].id, 'a');
    assert.equal(ev[0].tier, t);
    assert.equal(ev[0].plantKind, ORDER[t + 1]);
    assert.equal(ev[0].name, TYPES[ORDER[t + 1]].name);
    assert.equal(ev[0].bonus, false);
    assert.equal(ev[0].weapon, undefined, 'no gun in a plant upgrade');
  }
  assert.equal(p.weapon, 'pea_blaster');
});

test('streak bonus jumping two tiers unlocks both plants, event names the newest', () => {
  const { game, p } = plantGame({ streakBonus: 3 });
  recordKill(game, p);
  recordKill(game, p); // 2 kills -> tier 1
  game.drainEvents();
  recordKill(game, p); // streak 3 -> threshold tier 1, bonus -> tier 2
  const ev = game.drainEvents().filter((e) => e.type === 'upgrade');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].bonus, true);
  assert.equal(ev[0].tier, 2);
  assert.equal(ev[0].plantKind, 'snowpea');
  assert.deepEqual(ev[0].plantKinds, ['snowpea']);
});

test('planting a locked plant does nothing; unlocking it allows it', () => {
  const { game, p } = plantGame();
  p.x = -6;
  p.z = -1;
  assert.equal(tryPlant(game, p, 'repeater'), null, 'repeater needs tier 1');
  assert.equal(p.sunshine, 5000);
  assert.ok(tryPlant(game, p, 'peashooter'));
  kills(game, p, 2);
  assert.equal(p.tier, 1);
  const r = tryPlant(game, p, 'repeater');
  assert.ok(r);
  assert.equal(r.plantKind, 'repeater');
  assert.equal(p.sunshine, 5000 - 50 - TYPES.repeater.cost);
  assert.equal(tryPlant(game, p, 'houseplant'), null);
});

// ---- planting rules ------------------------------------------------------------------------

test('any plant goes in any slot: a cactus in a peashooter-row slot, nearest empty slot wins', () => {
  const { game, p } = plantGame();
  p.x = -12.5;
  p.z = -1;
  const c = tryPlant(game, p, 'cactus');
  assert.ok(c);
  assert.equal(c.z, 0, 'front row is a peashooter row, cactus goes there anyway');
  assert.equal(c.x, -12);
  p.x = 10;
  p.z = 6; // between rows 4 and 8: row 4 slot (8 or 12) is nearest
  const q = tryPlant(game, p, 'peashooter');
  assert.ok(q);
  assert.equal(q.z, 4, 'a peashooter in a cactus row');
  assert.equal(q.x, 8);
});

test('planting still needs an empty slot within 4 m', () => {
  const { game, p } = plantGame();
  p.x = 0;
  p.z = 20;
  assert.equal(tryPlant(game, p, 'peashooter'), null);
  assert.equal(p.sunshine, 5000);
});

test('input plant 1-9 picks the kind by index; 10 and junk are ignored', () => {
  const { game, p } = plantGame();
  kills(game, p, 23); // everything unlocked
  p.x = -14;
  p.z = -1;
  for (let n = 1; n <= 9; n++) {
    game.handleInput('a', { plant: n, plantSeq: n });
    p.x = -16 + 4 * ((n - 1) % 9);
    p.z = 0.4 + 4 * Math.floor((n - 1) / 9);
    game.tick(1 / 30);
  }
  const kinds = entitiesOfKind(game, 'garden').map((g) => g.plantKind).sort();
  assert.deepEqual(kinds, [...ORDER].sort());
  const before = game.gardenCount();
  game.handleInput('a', { plant: 10, plantSeq: 20 });
  game.tick(1 / 30);
  assert.equal(game.gardenCount(), before);
});

// ---- levels ---------------------------------------------------------------------------------

test('upgrade cost is 0.75x then 1.25x the base cost', () => {
  assert.equal(upgradeCost(DEFAULT_CONFIG, 'cactus', 1), 75);
  assert.equal(upgradeCost(DEFAULT_CONFIG, 'cactus', 2), 125);
  assert.equal(upgradeCost(DEFAULT_CONFIG, 'peashooter', 1), 38);
  assert.equal(upgradeCost(DEFAULT_CONFIG, 'cactus', 3), null, 'max level');
  const s = levelScale(DEFAULT_CONFIG, 3);
  assert.equal(s.damage, 1.8);
  assert.equal(s.rate, 1.5);
  assert.equal(s.hp, 2);
  assert.deepEqual(levelScale(DEFAULT_CONFIG, 1), { damage: 1, rate: 1, hp: 1 });
});

test('tryUpgrade levels a nearby plant 1 -> 2 -> 3, charges, heals to a bigger max HP, emits plantUp', () => {
  const { game, p } = plantGame();
  const g = plantAt(game, slotAt(0, 4), 'cactus');
  g.hp = 10;
  p.x = 0;
  p.z = 6;
  p.sunshine = 400;
  game.drainEvents();
  assert.equal(g.level, 1);
  const u2 = tryUpgrade(game, p);
  assert.equal(u2, g);
  assert.equal(g.level, 2);
  assert.equal(p.sunshine, 400 - 75);
  assert.equal(g.maxHp, DEFAULT_CONFIG.gardenPlantHp * 1.5);
  assert.equal(g.hp, g.maxHp, 'healed to full');
  const ev = game.drainEvents().filter((e) => e.type === 'plantUp');
  assert.deepEqual(ev.map((e) => [e.id, e.plantKind, e.level, e.by]), [[g.id, 'cactus', 2, 'a']]);
  assert.equal(ev[0].x, g.x);
  assert.equal(ev[0].z, g.z);
  tryUpgrade(game, p);
  assert.equal(g.level, 3);
  assert.equal(p.sunshine, 400 - 75 - 125);
  assert.equal(g.maxHp, DEFAULT_CONFIG.gardenPlantHp * 2);
  assert.equal(tryUpgrade(game, p), null, 'level 3 is the top');
  assert.equal(p.sunshine, 400 - 75 - 125);
  assert.equal(game.snapshot().entities.find((e) => e.id === g.id).level, 3, 'level is in snapshots');
});

test('tryUpgrade needs sunshine, a plant within 3 m, a living plant kid, and a playing round', () => {
  const { game, p } = plantGame();
  const g = plantAt(game, slotAt(0, 4), 'cactus');
  p.x = 0;
  p.z = 6;
  p.sunshine = 74;
  assert.equal(tryUpgrade(game, p), null);
  assert.equal(g.level, 1);
  assert.equal(p.sunshine, 74);
  p.sunshine = 500;
  p.z = 4 + 3.2;
  assert.equal(tryUpgrade(game, p), null, 'too far');
  p.z = 4 + 2.9;
  assert.ok(tryUpgrade(game, p));
  const z = game.addPlayer('z', { team: 'zombie' });
  z.x = 0;
  z.z = 6;
  z.sunshine = 999;
  assert.equal(tryUpgrade(game, z), null);
  p.state = 'wilted';
  assert.equal(tryUpgrade(game, p), null);
  p.state = 'alive';
  game.phase = 'ended';
  assert.equal(tryUpgrade(game, p), null);
});

test('upgrade target: the plant you look at beats a nearer one; otherwise the nearest', () => {
  const { game, p } = plantGame();
  const left = plantAt(game, slotAt(-4, 4), 'cactus');
  const right = plantAt(game, slotAt(0, 4), 'cactus');
  p.x = -1.5; // 2.5 m from the left plant, 1.5 m from the right one... both within 3 m of (x=-1.5,z=4)
  p.z = 4;
  p.yaw = Math.PI / 2; // +yaw turns left: faces -x, toward the left plant
  assert.equal(pickUpgradeTarget(game, p), left);
  p.yaw = -Math.PI / 2; // faces +x, toward the right plant
  assert.equal(pickUpgradeTarget(game, p), right);
  p.yaw = 0; // faces -z: neither in the cone: nearest wins (the right one at 1.5 m)
  assert.equal(pickUpgradeTarget(game, p), right);
  p.x = -2.6;
  assert.equal(pickUpgradeTarget(game, p), left, 'nearest follows the player');
  p.x = 20;
  assert.equal(pickUpgradeTarget(game, p), null);
});

test('input upgrade is a rising edge: one press, one level', () => {
  const { game, p } = plantGame();
  const g = plantAt(game, slotAt(0, 4), 'peashooter');
  p.x = 0;
  p.z = 6;
  game.handleInput('a', { upgrade: true });
  run(game, 0.5); // held for many ticks
  assert.equal(g.level, 2);
  game.handleInput('a', { upgrade: false });
  game.handleInput('a', { upgrade: true });
  game.tick(1 / 30);
  assert.equal(g.level, 3);
  game.handleInput('a', { upgrade: false });
  game.handleInput('a', { upgrade: true }); // tap released again before the tick still counts
  game.handleInput('a', { upgrade: false });
  game.tick(1 / 30);
  assert.equal(g.level, 3);
});

test('level multipliers: +40% damage per level on the shot, +25% fire rate per level', () => {
  const fire = (level, seconds) => {
    const { game } = plantGame({ plantTypes: { ...TYPES, peashooter: { ...TYPES.peashooter, aimError: 0, range: 40 } } });
    const g = plantAt(game, slotAt(0, 0), 'peashooter');
    g.level = level;
    g.cooldown = 0;
    const z = game.spawnBot('zombie', 0, -12);
    z.hp = z.maxHp = 1e6;
    game.drainEvents();
    for (let i = 0; i < Math.round(seconds * 30); i++) {
      stepGarden(game, 1 / 30);
      stepProjectiles(game, 1 / 30);
    }
    const hits = game.drainEvents().filter((e) => e.type === 'hit' && e.id === z.id);
    return { n: hits.length, dmg: hits[0]?.dmg };
  };
  const l1 = fire(1, 20);
  const l2 = fire(2, 20);
  const l3 = fire(3, 20);
  assert.equal(l1.dmg, 1);
  assert.ok(Math.abs(l2.dmg - 1.4) < 1e-9, `level 2 dmg ${l2.dmg}`);
  assert.ok(Math.abs(l3.dmg - 1.8) < 1e-9);
  assert.ok(l2.n / l1.n > 1.2 && l2.n / l1.n < 1.3, `rate x${l2.n / l1.n}`);
  assert.ok(l3.n / l1.n > 1.45 && l3.n / l1.n < 1.55, `rate x${l3.n / l1.n}`);
});

// ---- the new plants ---------------------------------------------------------------------------

function turretFixture(kind, targetZ = -10, over = {}) {
  const types = { ...TYPES, [kind]: { ...TYPES[kind], aimError: 0, ...over } };
  const { game } = plantGame({ plantTypes: types });
  const g = plantAt(game, slotAt(0, 4), kind);
  g.cooldown = 0;
  const z = game.spawnBot('zombie', 0, targetZ);
  z.hp = z.maxHp = 1e6;
  game.drainEvents();
  return { game, g, z };
}

test('every plant type can be planted and has the right size and hp', () => {
  const { game } = plantGame();
  const g = {};
  ORDER.forEach((k, i) => { g[k] = plantAt(game, i * 2, k); });
  for (const k of ORDER) {
    assert.equal(g[k].plantKind, k);
    assert.equal(g[k].hp, TYPES[k].hp ?? DEFAULT_CONFIG.gardenPlantHp);
    assert.equal(g[k].level, 1);
    assert.equal(g[k].radius, TYPES[k].radius ?? DEFAULT_CONFIG.gardenPlantRadius);
    assert.equal(g[k].height, TYPES[k].height ?? DEFAULT_CONFIG.gardenPlantHeight);
  }
  assert.ok(g.houseplant.height > 2.5 && g.wallnut.hp > g.houseplant.hp);
});

test('Spike Squash blasts 8 spikes at once over a short range', () => {
  const { game } = turretFixture('spikesquash', -6);
  stepGarden(game, 1 / 30);
  const shots = entitiesOfKind(game, 'projectile');
  assert.equal(shots.length, 8);
  assert.ok(shots.every((s) => s.projKind === 'spike'));
  run(game, 0.5);
  const hits = game.drainEvents().filter((e) => e.type === 'hit');
  assert.ok(hits.length >= 6, `a tight spread: ${hits.length}/8 pellets landed at 10 m`);
  assert.ok(TYPES.spikesquash.range <= 20 && TYPES.spikesquash.range < TYPES.cactus.range);
});

test('Snow Pea slows zombies to half speed for 2 s', () => {
  const { game, z } = turretFixture('snowpea', -10);
  for (let i = 0; i < 40; i++) {
    stepGarden(game, 1 / 30);
    stepProjectiles(game, 1 / 30);
    if (z.slowTimer > 0) break;
  }
  assert.ok(z.slowTimer > 1.9 && z.slowTimer <= 2);
  assert.equal(z.slowFactor, 0.5);
});

test('Melon-pult lobs an arcing melon that splashes a clump of zombies', () => {
  const { game, g, z } = turretFixture('melonpult', -20);
  const z2 = game.spawnBot('zombie', 1.2, -20);
  z2.hp = z2.maxHp = 1e6;
  stepGarden(game, 1 / 30);
  const shots = entitiesOfKind(game, 'projectile');
  assert.equal(shots.length, 1);
  assert.equal(shots[0].projKind, 'melon');
  assert.ok(shots[0].gravity > 0 && shots[0].splash > 1);
  assert.ok(g.pitch > 0.05, `catapult tilts up (${g.pitch})`);
  run(game, 3);
  const hit = game.drainEvents();
  assert.ok(hit.some((e) => e.type === 'explode'));
  const ids = new Set(hit.filter((e) => e.type === 'hit').map((e) => e.id));
  assert.ok(ids.has(z.id) && ids.has(z2.id), 'splash reaches both');
});

test('House Plant converts a zombie with one hit, slowly', () => {
  const { game, z } = turretFixture('houseplant', -15, {});
  z.hp = z.maxHp = DEFAULT_CONFIG.zombieHp;
  for (let i = 0; i < 90 && game.entities.has(z.id) && z.team === 'zombie'; i++) {
    stepGarden(game, 1 / 30);
    stepProjectiles(game, 1 / 30);
  }
  assert.equal(game.entities.has(z.id), false, 'one shot converts');
  assert.equal(game.drainEvents().filter((e) => e.type === 'convert').length, 1);
});

test('Wall-nut never shoots, soaks up projectiles aimed past it, and zombies cannot walk through it', () => {
  const { game } = plantGame();
  const w = plantAt(game, slotAt(0, 4), 'wallnut');
  const z = game.spawnBot('zombie', 0, -4);
  z.hp = z.maxHp = 1e6;
  run(game, 3);
  assert.equal(entitiesOfKind(game, 'projectile').filter((s) => s.owner === w.id).length, 0);
  game.drainEvents();
  // a zombie shot flies at the plant behind it: the wall-nut takes it
  const behind = plantAt(game, slotAt(0, 8), 'peashooter');
  const shooter = game.spawnBot('zombie', 0, -4);
  shooter.hp = shooter.maxHp = 1e6;
  shooter.yaw = Math.PI;
  shooter.pitch = 0;
  shooter.x = 0;
  shooter.z = 0.5;
  shooter.input.fire = true;
  shooter.fireScale = 1;
  game.config.features.botAI = false;
  run(game, 2);
  assert.ok(w.hp < w.maxHp, 'wall-nut took hits');
  assert.equal(behind.hp, behind.maxHp, 'the plant behind is untouched');
});

test('Wall-nut blocks walking: a zombie pushing against it stays outside its radius', () => {
  const { game } = plantGame();
  const w = plantAt(game, slotAt(0, 4), 'wallnut');
  const z = game.addPlayer('z', { team: 'zombie', mode: 'versus' });
  z.x = 0;
  z.z = 0;
  z.yaw = Math.PI; // facing +z toward the nut at z=4
  game.handleInput('z', { keys: { f: true }, yaw: Math.PI, pitch: 0 });
  run(game, 3);
  assert.ok(z.z < 4 - w.radius - z.radius + 0.01, `stopped at z=${z.z.toFixed(2)}`);
  assert.ok(z.z > 4 - w.radius - z.radius - 0.2);
  // other plants do not block
  const pea = plantAt(game, slotAt(8, 4), 'peashooter');
  z.x = 8;
  z.z = 0;
  game.handleInput('z', { keys: { f: true }, yaw: Math.PI });
  run(game, 3);
  assert.ok(z.z > pea.z + 1, 'walked straight through the peashooter');
});

test('mower still flattens a Wall-nut', () => {
  const { game } = plantGame();
  const w = plantAt(game, slotAt(0, 4), 'wallnut');
  game.mower.state = 'driving';
  const z = game.addPlayer('z', { team: 'zombie', mode: 'versus' });
  game.mower.driver = z.id;
  z.x = 0;
  z.z = 0;
  game.handleInput('z', { keys: { f: true }, yaw: Math.PI });
  run(game, 2);
  assert.equal(game.entities.has(w.id), false);
});

// ---- Gardener -----------------------------------------------------------------------------------

test('the Gardener spends spare sunshine upgrading plants (and still only plants basic kinds)', () => {
  const game = makeGame({ features: { gardener: true, botAI: true, initialGarden: true }, seed: 77 });
  const cfg = game.config;
  game.addPlayer('z', { team: 'zombie', mode: 'coop' }).x = 28;
  game.entities.get('z').z = 25;
  run(game, 0.2);
  const gardener = [...game.entities.values()].find((e) => e.isGardener);
  assert.ok(gardener);
  gardener.sunshine = cfg.gardener.maxSunshine;
  run(game, 90);
  const plants = entitiesOfKind(game, 'garden');
  assert.ok(plants.some((g) => g.level > 1), 'at least one plant was upgraded by the Gardener');
  assert.ok(plants.every((g) => g.plantKind === 'peashooter' || g.plantKind === 'cactus'));
});
