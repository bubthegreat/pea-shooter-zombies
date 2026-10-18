import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { fireWeapon, stepProjectiles, applyDamage, spawnProjectile } from '../server/sim/combat.js';
import { makeGame, run, keys, entitiesOfKind } from './helpers.js';

const SPAWN = WORLD.plantSpawn;

/** Plant player 'a' at spawn facing -z, plus a stationary zombie bot `dist` meters ahead. */
function setup(dist = 10) {
  const game = makeGame();
  const a = game.addPlayer('a', { name: 'A', team: 'plant', mode: 'coop', difficulty: 'normal' });
  const zombie = game.spawnBot('zombie', SPAWN.x, SPAWN.z - dist);
  return { game, a, zombie };
}

function ticksUntil(game, pred, maxSeconds = 10) {
  for (let i = 0; i < maxSeconds * 30; i++) {
    game.tick(1 / 30);
    if (pred()) return true;
  }
  return false;
}

const hitsOn = (events, id) => events.filter((e) => e.type === 'hit' && e.id === id).length;

test('zombie bot converts after 5 pea hits', () => {
  const { game, zombie } = setup();
  game.handleInput('a', { fire: true, yaw: 0, pitch: -0.07 }); // aimed at the body: head shots count triple
  assert.equal(zombie.hp, DEFAULT_CONFIG.zombieHp);
  const converted = ticksUntil(game, () => !game.entities.has(zombie.id));
  assert.ok(converted, 'zombie converted');
  const events = game.drainEvents();
  assert.equal(hitsOn(events, zombie.id), 5);
  const ev = events.find((e) => e.type === 'convert');
  assert.ok(ev, 'convert event emitted');
  assert.equal(ev.id, zombie.id);
  assert.equal(ev.by, 'a');
  assert.equal(ev.human, false);
  assert.equal(entitiesOfKind(game, 'bot').length, 0, 'no plant soldier takes its place');
  assert.equal(entitiesOfKind(game, 'sun').length, 1, 'it leaves a sunshine pickup');
});

test('human zombie converted becomes sprout then respawns at the gate after 5 s with same tier', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { name: 'Zed', team: 'zombie' });
  z.x = SPAWN.x;
  z.z = SPAWN.z - 10;
  z.tier = 2;
  z.weapon = 'zombie_shotgun';
  game.handleInput('a', { fire: true, yaw: 0, pitch: 0 });
  assert.ok(ticksUntil(game, () => z.state === 'sprout'));
  game.handleInput('a', { fire: false });
  const conv = game.drainEvents().find((e) => e.type === 'convert');
  assert.ok(conv && conv.id === 'z' && conv.human === true);
  assert.equal(z.kind, 'player');
  run(game, 4.7);
  assert.equal(z.state, 'sprout', 'still a sprout before 5 s');
  assert.ok(game.snapshot().entities.find((e) => e.id === 'z').respawnIn > 0);
  run(game, 0.6);
  assert.equal(z.state, 'alive');
  assert.equal(z.team, 'zombie');
  assert.ok(Math.abs(z.z - WORLD.gate.z) < 0.5, `respawned at gate z=${z.z}`);
  assert.equal(z.hp, DEFAULT_CONFIG.zombieHp);
  assert.equal(z.tier, 2);
  assert.equal(z.weapon, 'zombie_shotgun');
});

test('sprouts and wilted players cannot be hit, move, or fire', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { team: 'zombie' });
  z.x = SPAWN.x;
  z.z = SPAWN.z - 10;
  applyDamage(game, z, 99, game.entities.get('a'));
  assert.equal(z.state, 'sprout');
  const hpBefore = z.hp;
  assert.equal(applyDamage(game, z, 5, game.entities.get('a')), false);
  game.handleInput('z', { keys: keys({ f: true }), fire: true, yaw: 0 });
  const x = z.x;
  const zz = z.z;
  run(game, 1);
  assert.equal(z.x, x);
  assert.equal(z.z, zz);
  assert.equal(z.hp, hpBefore);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0);
});

test('plant player wilts at 0 hp, respawns at plant spawn after 4 s with full hp, tier kept', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  a.tier = 2;
  const shooter = game.spawnBot('zombie', SPAWN.x, SPAWN.z - 10);
  shooter.yaw = Math.PI; // face +z toward the plant
  shooter.input.fire = true;
  assert.ok(ticksUntil(game, () => a.state === 'wilted'));
  shooter.input.fire = false;
  const wilt = game.drainEvents().find((e) => e.type === 'wilt' && e.id === 'a');
  assert.ok(wilt, 'wilt event emitted');
  assert.equal(a.hp, 0);
  run(game, 3.7);
  assert.equal(a.state, 'wilted');
  run(game, 0.6);
  assert.equal(a.state, 'alive');
  assert.equal(a.hp, DEFAULT_CONFIG.plantHp);
  assert.equal(a.x, SPAWN.x);
  assert.equal(a.z, SPAWN.z);
  assert.equal(a.tier, 2);
  assert.equal(a.weapon, 'pea_blaster');
});

test('plant bot that wilts is removed', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'zombie', mode: 'coop' });
  const bot = game.spawnBot('plant', 0, 0);
  applyDamage(game, bot, 1000, null);
  assert.equal(game.entities.has(bot.id), false);
  assert.ok(game.drainEvents().some((e) => e.type === 'wilt' && e.id === bot.id));
});

test('fire rate respected: holding fire 1 s with pea_blaster spawns 4 +/- 1 projectiles', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  game.handleInput('a', { fire: true, yaw: 0, pitch: 0 });
  run(game, 1);
  const n = entitiesOfKind(game, 'projectile').length;
  assert.ok(n >= 3 && n <= 5, `projectiles: ${n}`);
});

test('fire rate scales with weapon (auto-shot rifle ~12/s)', () => {
  const game = makeGame({ projectileLife: 5 });
  const z = game.addPlayer('z', { team: 'zombie', mode: 'versus' });
  z.weapon = 'auto_shot_rifle';
  game.handleInput('z', { fire: true, yaw: 0, pitch: 1.2 }); // aim up so shots stay alive
  let shots = 0;
  const before = new Set();
  for (let i = 0; i < 30; i++) {
    game.tick(1 / 30);
    for (const e of entitiesOfKind(game, 'projectile')) if (!before.has(e.id)) { before.add(e.id); shots++; }
  }
  assert.ok(shots >= 11 && shots <= 13, `rifle shots/s: ${shots}`);
});

test('shotgun fires all pellets in a cone', () => {
  const game = makeGame();
  const z = game.addPlayer('z', { team: 'zombie', mode: 'versus' });
  z.weapon = 'zombie_shotgun';
  const n = fireWeapon(game, z);
  assert.equal(n, 8);
  const ps = entitiesOfKind(game, 'projectile');
  assert.equal(ps.length, 8);
  assert.ok(ps.every((p) => p.projKind === 'bullet' && p.team === 'zombie'));
  const yaws = new Set(ps.map((p) => p.yaw.toFixed(4)));
  assert.ok(yaws.size > 1, 'pellets spread');
});

test('no friendly fire', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'versus' });
  game.addPlayer('z', { team: 'zombie' });
  const friend = game.spawnBot('plant', SPAWN.x, SPAWN.z - 8);
  const zfriend = game.spawnBot('zombie', SPAWN.x + 30, SPAWN.z - 8); // out of the way
  const zp = game.entities.get('z');
  zp.x = SPAWN.x + 10;
  zp.z = SPAWN.z - 8;
  zfriend.x = SPAWN.x + 10;
  zfriend.z = SPAWN.z - 4;
  // plant shoots through a plant bot
  game.handleInput('a', { fire: true, yaw: 0, pitch: 0 });
  // zombie player shoots toward a zombie bot standing in front of them (-z)
  game.handleInput('z', { fire: true, yaw: 0, pitch: 0 });
  zfriend.x = zp.x;
  zfriend.z = zp.z - 4;
  run(game, 2);
  assert.equal(friend.hp, DEFAULT_CONFIG.plantHp);
  assert.equal(friend.team, 'plant');
  assert.equal(zfriend.hp, DEFAULT_CONFIG.zombieHp);
  assert.equal(zfriend.team, 'zombie');
  assert.equal(game.entities.get('a').hp, DEFAULT_CONFIG.plantHp);
});

test('fast projectiles do not tunnel through thin targets', () => {
  const game = makeGame({ projectileStep: 0.4 });
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const zombie = game.spawnBot('zombie', SPAWN.x, SPAWN.z - 20);
  // 70 m/s => 2.3 m per tick, at body height
  spawnProjectile(game, { team: 'plant', owner: 'a', projKind: 'pea', damage: 1, speed: 70, x: SPAWN.x, y: 0.9, z: SPAWN.z - 1, dir: { x: 0, y: 0, z: -1 } });
  for (let i = 0; i < 30 && zombie.hp === DEFAULT_CONFIG.zombieHp; i++) stepProjectiles(game, 1 / 30);
  assert.equal(zombie.hp, DEFAULT_CONFIG.zombieHp - 1);
});

test('projectiles die on walls, ground and after their lifetime', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  // toward the house wall (+z): yaw = PI, away from the door
  a.x = -4;
  a.yaw = Math.PI;
  fireWeapon(game, a);
  run(game, 0.2);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0, 'stopped by house');
  a.yaw = 0;
  a.pitch = -1;
  fireWeapon(game, a);
  run(game, 0.2);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0, 'stopped by ground');
  a.pitch = 1.2;
  fireWeapon(game, a);
  run(game, 1.9);
  assert.equal(entitiesOfKind(game, 'projectile').length, 1);
  run(game, 0.3);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0, 'expired');
});

test('hit events and snapshot projectile shape', () => {
  const { game, a } = setup(6);
  a.weapon = 'pea_blaster';
  a.pitch = -0.1;
  fireWeapon(game, a);
  const s = game.snapshot();
  const proj = s.entities.find((e) => e.kind === 'projectile');
  assert.ok(proj);
  assert.equal(proj.projKind, 'pea');
  assert.equal(proj.team, 'plant');
  for (const k of ['x', 'y', 'z', 'yaw', 'pitch']) assert.equal(typeof proj[k], 'number');
  assert.ok(!('vx' in proj));
  run(game, 0.3);
  const hit = game.drainEvents().find((e) => e.type === 'hit');
  assert.ok(hit && hit.by === 'a' && hit.dmg === 1);
});
