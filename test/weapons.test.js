import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, publicConfig } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { PLANT_LADDER, ZOMBIE_LADDER, getWeapon } from '../server/sim/weapons.js';
import { fireWeapon, stepProjectiles, spawnProjectile, applyDamage } from '../server/sim/combat.js';
import { plantAt } from '../server/sim/garden.js';
import { tierForProgress } from '../server/sim/upgrades.js';
import { makeGame, run, entitiesOfKind, slotIdx } from './helpers.js';

const SPAWN = WORLD.plantSpawn;

function setup(dist = 8, zombieTeam = 'zombie') {
  const game = makeGame();
  const a = game.addPlayer('a', { name: 'A', team: 'plant', mode: 'coop' });
  a.x = 0;
  a.z = 0;
  const z = game.spawnBot(zombieTeam, 0, -dist);
  z.hp = z.maxHp = 5;
  return { game, a, z };
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

test('the zombie ladder has 8 tiers; plant kids have a single gun (their upgrades are plants)', () => {
  assert.deepEqual(PLANT_LADDER.map((w) => w.id), ['pea_blaster']);
  assert.deepEqual(ZOMBIE_LADDER.map((w) => w.id), [
    'goo_blaster', 'slime_pistol', 'zombie_rifle', 'bone_burst', 'zombie_shotgun', 'sludge_sprayer', 'brain_cannon', 'auto_shot_rifle',
  ]);
  assert.deepEqual(DEFAULT_CONFIG.tierThresholds, [0, 2, 4, 7, 10, 14, 18, 23]);
  const th = DEFAULT_CONFIG.tierThresholds;
  assert.equal(tierForProgress(th, 0), 0);
  assert.equal(tierForProgress(th, 2), 1);
  assert.equal(tierForProgress(th, 22), 6);
  assert.equal(tierForProgress(th, 23), 7);
  for (const w of [...PLANT_LADDER, ...ZOMBIE_LADDER]) {
    for (const k of ['id', 'name', 'damage', 'rate', 'pellets', 'spread', 'speed', 'projKind']) assert.ok(w[k] !== undefined, `${w.id}.${k}`);
    assert.ok(getWeapon(w.id) === w);
  }
  assert.equal(new Set([...PLANT_LADDER, ...ZOMBIE_LADDER].map((w) => w.id)).size, 9);
  assert.equal(ZOMBIE_LADDER.at(-1).id, 'auto_shot_rifle');
  for (const gone of ['double_pea', 'pea_rifle', 'snow_pea', 'spike_shotgun', 'repeater', 'melon_lobber', 'house_gun']) assert.equal(getWeapon(gone), null, `${gone} is retired`);
  assert.ok(getWeapon('brain_cannon').splash > 1);
});

test('publicConfig carries the plant gun, all 8 zombie tiers and per-kind projectile radii', () => {
  const cfg = publicConfig();
  assert.equal(cfg.weapons.plant.length, 1);
  assert.equal(cfg.weapons.zombie.length, 8);
  assert.equal(cfg.tierThresholds.length, 8);
  for (const k of ['pea', 'snow', 'spike', 'melon', 'housepea', 'bullet', 'slime', 'bone', 'sludge', 'brain']) {
    assert.ok(cfg.projectileRadius[k] > 0, `radius ${k}`);
  }
  assert.equal(cfg.headshotMultiplier, 3);
  assert.equal(cfg.headHeight, 0.4);
  JSON.parse(JSON.stringify(cfg));
});

test('zombie shotgun: 8 pellets and far more close-range damage than the zombie rifle', () => {
  assert.equal(getWeapon('zombie_shotgun').pellets, 8);
  const dmgIn = (weapon) => {
    const game = makeGame();
    const p = game.addPlayer('p', { team: 'plant', mode: 'versus' });
    p.x = 0;
    p.z = 0;
    p.hp = p.maxHp = 1e6;
    const z = game.addPlayer('z', { team: 'zombie' });
    z.x = 0;
    z.z = 5;
    z.yaw = 0;
    z.weapon = weapon;
    z.hp = z.maxHp = 1e6;
    game.handleInput('z', { fire: true, yaw: 0, pitch: -0.12 });
    z.x = 0;
    z.z = 5;
    game.handleInput('p', { yaw: 0 });
    fireWeapon(game, z);
    run(game, 0.5);
    return 1e6 - p.hp;
  };
  const shotgun = dmgIn('zombie_shotgun');
  const rifle = dmgIn('zombie_rifle');
  assert.ok(shotgun > rifle * 3, `zombie shotgun ${shotgun} vs rifle shot ${rifle}`);
});

test('enemy bullets are slow, big and visible; plant turret peas stay fast', () => {
  for (const w of ZOMBIE_LADDER) {
    assert.ok(w.speed >= 16 && w.speed <= 24, `${w.id} speed ${w.speed}`);
    assert.ok(DEFAULT_CONFIG.projectileRadius[w.projKind] >= 0.25, `${w.projKind} radius`);
  }
  assert.ok(DEFAULT_CONFIG.plantTypes.peashooter.speed >= 40);
  assert.ok(DEFAULT_CONFIG.plantTypes.cactus.speed >= 40);
  for (const w of PLANT_LADDER) assert.ok(w.speed >= 40, `${w.id} stays fast`);
  for (const [k, t] of Object.entries(DEFAULT_CONFIG.plantTypes)) if (!t.noAttack && !t.gravity) assert.ok(t.speed >= 40, `${k} stays fast`);
});

test('zombie bots fire 40-50% less often than before', () => {
  const d = DEFAULT_CONFIG.difficulties;
  assert.ok(d.easy.fireScale <= 0.5 * 0.6 + 1e-9, `easy ${d.easy.fireScale}`);
  assert.ok(d.normal.fireScale <= 0.8 * 0.6 + 1e-9, `normal ${d.normal.fireScale}`);
  assert.ok(d.easy.fireScale <= d.normal.fireScale);
});

// ---- headshots ---------------------------------------------------------------

function shootAtHeight(targetKind, yOff, projKind = 'pea', damage = 1) {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'versus' });
  let t;
  if (targetKind === 'bot') t = game.spawnBot('zombie', 0, -10);
  else {
    t = game.addPlayer('z', { team: 'zombie' });
    t.x = 0;
    t.z = -10;
  }
  t.hp = t.maxHp = 100;
  spawnProjectile(game, { team: 'plant', owner: 'a', projKind, damage, speed: 50, x: 0, y: yOff, z: -5, dir: { x: 0, y: 0, z: -1 } });
  for (let i = 0; i < 20; i++) stepProjectiles(game, 1 / 30);
  const hit = game.events.find((e) => e.type === 'hit' && e.id === t.id);
  return { t, hit, taken: 100 - t.hp };
}

test('headshots (top 0.4 m of the 1.8 m body) deal triple damage and flag the hit event', () => {
  for (const kind of ['bot', 'player']) {
    const body = shootAtHeight(kind, 0.9);
    assert.equal(body.taken, 1, `${kind} body shot`);
    assert.ok(body.hit && !body.hit.head, 'no head flag on body hits');
    const head = shootAtHeight(kind, 1.65);
    assert.equal(head.taken, 3, `${kind} headshot is triple`);
    assert.equal(head.hit.head, true);
    assert.equal(head.hit.dmg, 3);
    const neckBelow = shootAtHeight(kind, 1.3);
    assert.equal(neckBelow.taken, 1, 'below the head zone');
    const edge = shootAtHeight(kind, 1.45);
    assert.equal(edge.taken, 3, 'inside the top 0.4 m');
  }
});

test('zombie shots headshot plant players too', () => {
  const game = makeGame();
  game.addPlayer('z', { team: 'zombie', mode: 'versus' });
  const p = game.addPlayer('p', { team: 'plant' });
  p.x = 0;
  p.z = -10;
  spawnProjectile(game, { team: 'zombie', owner: 'z', projKind: 'bullet', damage: 8, speed: 20, x: 0, y: 1.6, z: -5, dir: { x: 0, y: 0, z: -1 } });
  for (let i = 0; i < 30; i++) stepProjectiles(game, 1 / 30);
  assert.equal(p.maxHp - p.hp, 24);
  assert.equal(game.events.find((e) => e.type === 'hit' && e.id === 'p').head, true);
});

test('garden plants have no head zone', () => {
  const game = makeGame();
  game.addPlayer('z', { team: 'zombie', mode: 'coop' });
  const plant = plantAt(game, slotIdx(0, 0, 1));
  plant.x = 0;
  plant.z = 0;
  plant.height = 3; // tall enough that a high shot would be a "head" on a fighter
  spawnProjectile(game, { team: 'zombie', owner: 'z', projKind: 'bullet', damage: 8, speed: 20, x: 0, y: 2.8, z: 5, dir: { x: 0, y: 0, z: -1 } });
  for (let i = 0; i < 30; i++) stepProjectiles(game, 1 / 30);
  assert.equal(plant.maxHp - plant.hp, 8);
  assert.ok(!game.events.find((e) => e.type === 'hit' && e.id === plant.id).head);
});

test('garden turret shots never headshot', () => {
  const game = makeGame();
  game.addPlayer('p', { team: 'plant', mode: 'coop' });
  const turret = plantAt(game, slotIdx(0, 0, 1));
  turret.x = 0;
  turret.z = 0;
  const z = game.spawnBot('zombie', 0, -10);
  z.hp = z.maxHp = 100;
  spawnProjectile(game, { team: 'plant', owner: turret.id, projKind: 'pea', damage: 1, speed: 50, x: 0, y: 1.65, z: -5, dir: { x: 0, y: 0, z: -1 } });
  for (let i = 0; i < 20; i++) stepProjectiles(game, 1 / 30);
  assert.equal(100 - z.hp, 1);
  assert.ok(!game.events.find((e) => e.type === 'hit' && e.id === z.id).head);
});

test('pellets headshot independently', () => {
  const game = makeGame();
  const p = game.addPlayer('p', { team: 'plant', mode: 'versus' });
  p.x = 0;
  p.z = -5;
  p.hp = p.maxHp = 1000;
  const z = game.addPlayer('z', { team: 'zombie' });
  z.x = 0;
  z.z = 0;
  z.weapon = 'zombie_shotgun';
  z.yaw = 0;
  z.pitch = 0; // the 1.6 m eye line is inside the head zone of a 1.8 m target
  fireWeapon(game, z);
  run(game, 1);
  const hits = game.events.filter((e) => e.type === 'hit' && e.id === 'p');
  assert.ok(hits.length >= 6, `pellets landed: ${hits.length}`);
  const heads = hits.filter((h) => h.head).length;
  assert.ok(heads >= 1, 'some pellets land in the head zone');
  assert.ok(heads < hits.length || hits.length === 8, 'body and head pellets are scored one by one');
  assert.equal(sum(hits.map((h) => h.dmg)), p.maxHp - p.hp);
});

// ---- snow pea ----------------------------------------------------------------------

test('a snow shot slows zombies to half speed for 2 s', () => {
  const { game, z } = setup(10);
  z.hp = z.maxHp = 100;
  const base = game.moveSpeedFor(z);
  spawnProjectile(game, { team: 'plant', owner: 'a', projKind: 'snow', damage: 1, speed: 55, x: 0, y: 1, z: -2, dir: { x: 0, y: 0, z: -1 }, slow: { factor: 0.5, secs: 2 } });
  run(game, 0.5);
  assert.ok(z.slowTimer > 0, 'slowed');
  assert.equal(game.moveSpeedFor(z), base * 0.5);
  assert.equal(game.snapshot().entities.find((e) => e.id === z.id).slowed, true);
  run(game, 2.2);
  assert.equal(game.moveSpeedFor(z), base);
  assert.ok(!('slowed' in game.snapshot().entities.find((e) => e.id === z.id)));
});

test('the Pea Blaster does not slow', () => {
  const { game, a, z } = setup(10);
  z.hp = z.maxHp = 100;
  game.handleInput('a', { fire: true, yaw: 0, pitch: 0 });
  run(game, 0.5);
  assert.ok(!(z.slowTimer > 0));
});

// ---- splash weapons ----------------------------------------------------------------

test('splash never hurts the shooter team, does not headshot, and falls off with distance', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { team: 'plant', mode: 'versus' });
  a.x = 0;
  a.z = 0;
  const friendly = game.spawnBot('plant', 0.5, -10);
  const near = game.spawnBot('zombie', 0.3, -10);
  const mid = game.spawnBot('zombie', 2.5, -10);
  for (const b of [near, mid]) b.hp = b.maxHp = 100;
  spawnProjectile(game, { team: 'plant', owner: 'a', projKind: 'melon', damage: 7, speed: 1, x: 0, y: 0.3, z: -10, dir: { x: 0, y: -1, z: 0 }, splash: 3.5, gravity: 0 });
  for (let i = 0; i < 5; i++) stepProjectiles(game, 1 / 30);
  assert.equal(friendly.hp, DEFAULT_CONFIG.plantHp, 'no friendly fire');
  const dNear = 100 - near.hp;
  const dMid = 100 - mid.hp;
  assert.ok(dNear > dMid && dMid > 0, `falloff ${dNear} > ${dMid} > 0`);
  assert.ok(game.events.filter((e) => e.type === 'hit').every((e) => !e.head));
});

test('brain cannon splash hurts garden plants and plant kids alike', () => {
  const game = makeGame();
  game.addPlayer('z', { team: 'zombie', mode: 'versus' });
  const p = game.addPlayer('p', { team: 'plant' });
  p.x = 0;
  p.z = -10;
  const plant = plantAt(game, slotIdx(0, 0, 1));
  plant.x = 3;
  plant.z = -10;
  const w = getWeapon('brain_cannon');
  spawnProjectile(game, { team: 'zombie', owner: 'z', projKind: 'brain', damage: w.damage, speed: w.speed, x: 0, y: 1, z: -5, dir: { x: 0, y: 0, z: -1 }, splash: w.splash });
  for (let i = 0; i < 40; i++) stepProjectiles(game, 1 / 30);
  assert.ok(p.hp < p.maxHp - 20, `plant kid took ${p.maxHp - p.hp}`);
  assert.ok(plant.hp < plant.maxHp, 'garden plant caught in the splash');
  assert.ok(game.events.some((e) => e.type === 'explode' && e.projKind === 'brain' && e.team === 'zombie'));
});
