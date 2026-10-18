import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD, gardenSlots } from '../server/sim/world.js';
import { plantAt } from '../server/sim/garden.js';
import { applyDamage } from '../server/sim/combat.js';
import { makeGame, run, keys, entitiesOfKind } from './helpers.js';

const HOME = WORLD.mowerHome;

/** Zombie human `z` standing next to the mower, plus the mower entity. */
function setup(overrides = {}) {
  const game = makeGame(overrides);
  const z = game.addPlayer('z', { name: 'Zed', team: 'zombie', mode: 'coop' });
  z.x = HOME.x;
  z.z = HOME.z - 1.5;
  z.yaw = 0;
  return { game, z, mower: game.mower };
}

test('the mower waits idle in the garage at round start', () => {
  const { game, mower } = setup();
  assert.ok(mower);
  assert.equal(mower.kind, 'mower');
  assert.equal(mower.state, 'idle');
  assert.deepEqual([mower.x, mower.y, mower.z], [HOME.x, HOME.y, HOME.z]);
  const snap = game.snapshot().entities.find((e) => e.kind === 'mower');
  assert.equal(snap.state, 'idle');
  assert.equal(snap.id, 'mower');
  assert.equal(typeof snap.team, 'string');
  assert.equal(typeof snap.hp, 'number');
});

test('mower start takes 3 s of a zombie near it holding use', () => {
  const { game, z, mower } = setup();
  run(game, 0.5);
  assert.equal(mower.state, 'idle', 'nobody pressed use');
  game.handleInput('z', { use: true });
  game.tick(1 / 30);
  assert.equal(mower.state, 'starting');
  game.handleInput('z', { use: false }); // a tap is enough
  run(game, 2.7);
  assert.equal(mower.state, 'starting');
  const p = game.snapshot().entities.find((e) => e.kind === 'mower').progress;
  assert.ok(p > 0.8 && p < 1, `progress ${p}`);
  run(game, 0.5);
  assert.equal(mower.state, 'driving');
  assert.equal(mower.driver, 'z');
  assert.equal(DEFAULT_CONFIG.mowerStartTime, 3);
  assert.ok(z);
});

test('mower use needs to be within 2.5 m', () => {
  const { game, z, mower } = setup();
  z.z = HOME.z - 3;
  game.handleInput('z', { use: true });
  run(game, 0.3);
  assert.equal(mower.state, 'idle');
});

test('starting is cancelled if the zombie wanders off', () => {
  const { game, z, mower } = setup();
  game.handleInput('z', { use: true });
  run(game, 1);
  assert.equal(mower.state, 'starting');
  game.handleInput('z', { use: false });
  z.z = HOME.z - 6;
  game.tick(1 / 30);
  assert.equal(mower.state, 'idle');
  assert.equal(mower.driver, null);
  assert.equal(mower.progress, 0);
  run(game, 4);
  assert.equal(mower.state, 'idle', 'does not secretly keep starting');
});

test('starting is cancelled if the zombie is converted', () => {
  const { game, z, mower } = setup();
  game.handleInput('z', { use: true });
  run(game, 1);
  applyDamage(game, z, 99, null);
  assert.equal(z.state, 'sprout');
  game.tick(1 / 30);
  assert.equal(mower.state, 'idle');
  assert.equal(mower.driver, null);
});

test('plants (and humans on the plant team) cannot start the mower', () => {
  const game = makeGame();
  const p = game.addPlayer('p', { team: 'plant', mode: 'coop' });
  p.x = HOME.x;
  p.z = HOME.z - 1;
  game.handleInput('p', { use: true });
  run(game, 4);
  assert.equal(game.mower.state, 'idle');
});

function startDriving(game, z, mower) {
  game.handleInput('z', { use: true });
  run(game, 3.3);
  game.handleInput('z', { use: false });
  assert.equal(mower.state, 'driving');
}

test('the driver is carried at mower speed and the mower follows them', () => {
  const { game, z, mower } = setup();
  startDriving(game, z, mower);
  const z0 = z.z;
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0 }); // toward the garage door, -z
  run(game, 1);
  assert.ok(Math.abs(z0 - z.z - DEFAULT_CONFIG.mowerSpeed) < 0.6, `moved ${z0 - z.z}`);
  assert.ok(Math.hypot(mower.x - z.x, mower.z - z.z) < 0.01, 'mower sits under the driver');
  assert.ok(mower.z < HOME.z - 5);
  assert.equal(game.snapshot().entities.find((e) => e.id === 'mower').state, 'driving');
});

test('a driver cannot shoot', () => {
  const { game, z, mower } = setup();
  startDriving(game, z, mower);
  game.handleInput('z', { fire: true });
  run(game, 1);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0);
});

test('driving mower destroys plant in path (mow event counts as a kill)', () => {
  const { game, z, mower } = setup();
  const slot = gardenSlots().findIndex((s) => s.kind === 'peashooter' && s.x === 0 && s.z === 12);
  const plant = plantAt(game, slot);
  const other = plantAt(game, gardenSlots().findIndex((s) => s.x === 4 && s.z === 12));
  // drive straight through (0, 12) from the +z side
  mower.state = 'driving';
  mower.driver = 'z';
  mower.progress = 1;
  z.x = 0;
  z.z = 17;
  z.yaw = 0;
  mower.x = z.x;
  mower.z = z.z;
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0 });
  game.drainEvents();
  run(game, 1.2);
  assert.equal(plant.state, 'dead');
  assert.equal(game.entities.has(plant.id), false);
  assert.equal(game.entities.has(other.id), true, 'plant 4 m off the path survives');
  const ev = game.drainEvents().filter((e) => e.type === 'mow');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].id, plant.id);
  assert.equal(ev[0].by, 'z');
  assert.equal(ev[0].plantKind, 'peashooter');
  assert.equal(z.progress, 1, 'counts as a kill');
  // slot is free again
  assert.equal(game.slots[slot].plantId, null);
});

test('a mower pass can clear a whole row', () => {
  const { game, z, mower } = setup();
  gardenSlots().forEach((s, i) => { if (s.z === 12) plantAt(game, i); });
  assert.equal(game.gardenCount(), 9);
  mower.state = 'driving';
  mower.driver = 'z';
  z.hp = z.maxHp = 1e6; // the row's own turrets would otherwise convert the driver
  z.x = -18;
  z.z = 12;
  mower.x = z.x;
  mower.z = z.z;
  game.handleInput('z', { keys: keys({ r: true }), yaw: 0 });
  run(game, 6);
  assert.equal(game.gardenCount(), 0);
  assert.equal(z.progress, 9);
  assert.equal(z.tier, 2, "mowing earns upgrades (9 kills)");
});

test('plants are only mowed while driving', () => {
  const { game, z, mower } = setup();
  const plant = plantAt(game, gardenSlots().findIndex((s) => s.x === 0 && s.z === 12));
  z.x = 0;
  z.z = 12;
  mower.x = 0;
  mower.z = 12;
  run(game, 0.5);
  assert.equal(game.entities.has(plant.id), true, 'idle mower does nothing');
});

test('driver converted -> mower idle at current spot, free for another zombie', () => {
  const { game, z, mower } = setup();
  startDriving(game, z, mower);
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0 });
  run(game, 1);
  game.handleInput('z', { keys: keys() });
  const spot = { x: z.x, z: z.z };
  applyDamage(game, z, 99, null);
  assert.equal(z.state, 'sprout');
  game.tick(1 / 30);
  assert.equal(mower.state, 'idle');
  assert.equal(mower.driver, null);
  assert.ok(Math.hypot(mower.x - spot.x, mower.z - spot.z) < 0.5, 'mower stays where it was');
  const parked = { x: mower.x, z: mower.z };
  run(game, 5.5); // the sprout digs up at the gate, far away
  assert.equal(z.state, 'alive');
  assert.equal(mower.state, 'idle');
  assert.equal(mower.x, parked.x);
  assert.equal(mower.z, parked.z);
  // another zombie can take it
  const bot = game.spawnBot('zombie', parked.x, parked.z - 1);
  bot.input.use = true;
  run(game, 0.1);
  assert.equal(mower.state, 'starting');
  assert.equal(mower.driver, bot.id);
  bot.input.use = false;
  run(game, 3.2);
  assert.equal(mower.state, 'driving');
});

test('driver disconnecting leaves the mower idle where it was', () => {
  const { game, z, mower } = setup();
  game.addPlayer('p', { team: 'plant' });
  startDriving(game, z, mower);
  const at = { x: mower.x, z: mower.z };
  game.removePlayer('z');
  game.tick(1 / 30);
  assert.equal(mower.state, 'idle');
  assert.equal(mower.driver, null);
  assert.equal(mower.x, at.x);
  assert.equal(mower.z, at.z);
});

test('mower resets to the garage on a new round', () => {
  const { game, z, mower } = setup();
  startDriving(game, z, mower);
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0 });
  run(game, 1);
  game.startRound();
  assert.equal(game.mower.state, 'idle');
  assert.equal(game.mower.x, HOME.x);
  assert.equal(game.mower.z, HOME.z);
  assert.equal(entitiesOfKind(game, 'mower').length, 1);
});
