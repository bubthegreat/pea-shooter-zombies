import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { plantAt } from '../server/sim/garden.js';
import { applyDamage } from '../server/sim/combat.js';
import { makeGame, run, keys, entitiesOfKind, S, slotIdx, powerAll } from './helpers.js';

const HOME = WORLD.mowerHome;

/** Zombie human `z` standing next to the mower, plus the mower entity. */
function setup(overrides = {}) {
  const game = makeGame(overrides);
  const z = game.addPlayer('z', { name: 'Zed', team: 'zombie', mode: 'coop' });
  powerAll(game);
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
  // the garage is cramped: take the party out into the open yard
  z.x = 30;
  z.z = -30;
  mower.x = 30;
  mower.z = -30;
}

test('the driver is carried at mower speed and the mower follows them', () => {
  const { game, z, mower } = setup();
  startDriving(game, z, mower);
  const z0 = z.z;
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0 }); // toward the garage door, -z
  run(game, 1);
  assert.ok(Math.abs(z0 - z.z - DEFAULT_CONFIG.mowerSpeed) < 0.6, `moved ${z0 - z.z}`);
  assert.ok(Math.hypot(mower.x - z.x, mower.z - z.z) < 0.01, 'mower sits under the driver');
  assert.ok(mower.z < -30 - 5);
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
  const slot = slotIdx(0, 3, 1);
  const plant = plantAt(game, slot);
  const other = plantAt(game, slotIdx(0, 3, 2));
  // drive straight through the first plant from the +z side
  mower.state = 'driving';
  mower.driver = 'z';
  mower.progress = 1;
  z.x = plant.x;
  z.z = plant.z + 3.8;
  z.yaw = 0;
  mower.x = z.x;
  mower.z = z.z;
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0 });
  game.drainEvents();
  run(game, 1.2);
  assert.equal(plant.state, 'dead');
  assert.equal(game.entities.has(plant.id), false);
  assert.equal(game.entities.has(other.id), true, 'plant 3.5 m off the path survives');
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
  for (let c = 0; c < 4; c++) plantAt(game, slotIdx(0, 3, c));
  assert.equal(game.gardenCount(), 4);
  mower.state = 'driving';
  mower.driver = 'z';
  z.hp = z.maxHp = 1e6; // the row's own turrets would otherwise convert the driver
  z.x = S(3, 0).x - 4;
  z.z = S(3, 0).z;
  mower.x = z.x;
  mower.z = z.z;
  game.handleInput('z', { keys: keys({ r: true }), yaw: 0 });
  run(game, 6);
  assert.equal(game.gardenCount(), 0);
  assert.equal(z.progress, 4);
  assert.equal(z.tier, 2, 'mowing earns upgrades (4 kills)');
});

test('plants are only mowed while driving', () => {
  const { game, z, mower } = setup();
  const plant = plantAt(game, slotIdx(0, 3, 1));
  z.x = plant.x;
  z.z = plant.z;
  mower.x = plant.x;
  mower.z = plant.z;
  run(game, 0.5);
  assert.equal(game.entities.has(plant.id), true, 'idle mower does nothing');
});

test('driver out of action -> mower idle at current spot, free for another zombie', () => {
  const { game, z, mower } = setup();
  startDriving(game, z, mower);
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0 });
  run(game, 1);
  game.handleInput('z', { keys: keys() });
  const spot = { x: z.x, z: z.z };
  assert.equal(applyDamage(game, z, 99, null), false, 'a driver cannot be converted...');
  z.state = 'sprout'; // ...but if the driver is out for any other reason the mower is freed
  z.timer = 5;
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

test('pressing use again while driving dismounts: mower idles where it is', () => {
  const { game, z, mower } = setup();
  startDriving(game, z, mower); // use is released after starting
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0 });
  run(game, 1);
  game.handleInput('z', { keys: keys() });
  const spot = { x: mower.x, z: mower.z };
  game.handleInput('z', { use: true }); // fresh press
  game.tick(1 / 30);
  assert.equal(mower.state, 'idle');
  assert.equal(mower.driver, null);
  assert.ok(Math.hypot(mower.x - spot.x, mower.z - spot.z) < 0.5, 'mower stays at the dismount spot');
  assert.equal(game.isDriving(z), false);
  // still holding use right next to it must not instantly re-mount
  run(game, 1);
  assert.equal(mower.state, 'idle', 'held key does not restart the mower');
  // releasing and pressing again can start it once more
  game.handleInput('z', { use: false });
  game.tick(1 / 30);
  game.handleInput('z', { use: true });
  game.tick(1 / 30);
  assert.equal(mower.state, 'starting');
});

test('holding use through the whole start does not dismount', () => {
  const { game, z, mower } = setup();
  game.handleInput('z', { use: true });
  run(game, 3.5);
  assert.equal(mower.state, 'driving');
  run(game, 1);
  assert.equal(mower.state, 'driving', 'only a new press dismounts');
  assert.equal(mower.driver, 'z');
  assert.ok(z);
});

test('mashing use while the engine starts does not dismount either', () => {
  const { game, mower } = setup();
  for (let i = 0; i < 80; i++) {
    game.handleInput('z', { use: i % 2 === 0 });
    game.tick(1 / 30);
  }
  assert.equal(mower.state, 'starting');
  game.handleInput('z', { use: false });
  run(game, 0.6);
  assert.equal(mower.state, 'driving');
  run(game, 0.5);
  assert.equal(mower.state, 'driving');
});

test('the mower snapshot names its driver (or null)', () => {
  const { game, z, mower } = setup();
  const snapMower = () => game.snapshot().entities.find((e) => e.kind === 'mower');
  assert.equal(snapMower().driver, null);
  game.handleInput('z', { use: true });
  game.tick(1 / 30);
  assert.equal(snapMower().driver, 'z');
  game.handleInput('z', { use: false });
  run(game, 3.3);
  assert.equal(mower.state, 'driving');
  assert.equal(snapMower().driver, 'z');
  z.state = 'sprout';
  z.timer = 5;
  game.tick(1 / 30);
  assert.equal(snapMower().driver, null);
});

// ---- mower HP (the driver is protected; the mower takes the hits) ----------------

function drivingSetup() {
  const { game, z, mower } = setup();
  startDriving(game, z, mower);
  return { game, z, mower };
}

test('the mower has its own HP in the snapshot', () => {
  const { game, mower } = setup();
  assert.equal(DEFAULT_CONFIG.mowerHp, 40);
  assert.equal(mower.hp, 40);
  const snap = game.snapshot().entities.find((e) => e.kind === 'mower');
  assert.equal(snap.hp, 40);
  assert.equal(snap.maxHp, 40);
  assert.equal(DEFAULT_CONFIG.mowerDamageScale, undefined, 'the old driver damage scaling is gone');
});

test('the driver takes no damage at all while driving', () => {
  const { game, z } = drivingSetup();
  assert.equal(applyDamage(game, z, 50, null), false);
  assert.equal(z.hp, z.maxHp);
  assert.equal(z.state, 'alive');
  assert.equal(game.drainEvents().filter((e) => e.type === 'hit' && e.id === 'z').length, 0);
});

test('plant shots hit the mower, not the driver', () => {
  const { game, z, mower } = drivingSetup();
  const p = game.addPlayer('p', { team: 'plant' });
  p.x = z.x;
  p.z = z.z - 8;
  p.yaw = Math.PI; // facing +z, toward the mower
  p.pitch = -0.05;
  game.handleInput('p', { fire: true, yaw: Math.PI, pitch: -0.05 });
  run(game, 1);
  game.handleInput('p', { fire: false });
  assert.ok(mower.hp < mower.maxHp, `mower hp ${mower.hp}`);
  assert.equal(z.hp, z.maxHp, 'driver untouched');
  const hits = game.drainEvents().filter((e) => e.type === 'hit');
  assert.ok(hits.length > 0 && hits.every((e) => e.id === 'mower'));
});

test('an idle mower is not a target', () => {
  const { game, mower } = setup();
  assert.equal(mower.state, 'idle');
  const p = game.addPlayer('p', { team: 'plant' });
  p.x = mower.x;
  p.z = mower.z - 6;
  game.handleInput('p', { fire: true, yaw: Math.PI, pitch: -0.1 });
  run(game, 1);
  assert.equal(mower.hp, mower.maxHp);
});

test('at 0 HP the mower sputters out: driver ejected unhurt, wreck respawns at the garage after 20 s', () => {
  const { game, z, mower } = drivingSetup();
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0 });
  run(game, 1);
  game.handleInput('z', { keys: keys() });
  const spot = { x: z.x, z: z.z };
  const p = game.addPlayer('p', { team: 'plant' });
  game.drainEvents();
  applyDamage(game, mower, 39, p);
  assert.equal(mower.state, 'driving');
  assert.equal(mower.hp, 1);
  applyDamage(game, mower, 5, p);
  assert.equal(mower.state, 'destroyed');
  assert.equal(mower.driver, null);
  assert.equal(game.isDriving(z), false);
  assert.equal(z.state, 'alive');
  assert.equal(z.hp, z.maxHp);
  assert.ok(Math.hypot(z.x - spot.x, z.z - spot.z) < 0.01, 'driver stays where the mower died');
  const ev = game.drainEvents().find((e) => e.type === 'mower_destroyed');
  assert.ok(ev && Math.hypot(ev.x - spot.x, ev.z - spot.z) < 1 && ev.by === 'p');
  assert.equal(p.progress, 1, 'wrecking it counts as a kill');
  const snap = game.snapshot().entities.find((e) => e.kind === 'mower');
  assert.equal(snap.state, 'destroyed');
  assert.ok(snap.respawnIn > 19 && snap.respawnIn <= 20);
  assert.equal(snap.driver, null);
  // while wrecked: cannot be started, shot, or mow
  z.x = HOME.x;
  z.z = HOME.z - 1.5;
  game.handleInput('z', { use: true });
  run(game, 4);
  assert.equal(mower.state, 'destroyed');
  game.handleInput('z', { use: false });
  run(game, 14);
  assert.equal(mower.state, 'destroyed', 'still broken at ~19 s');
  run(game, 2);
  assert.equal(mower.state, 'idle');
  assert.equal(mower.hp, mower.maxHp);
  assert.equal(mower.x, HOME.x);
  assert.equal(mower.z, HOME.z);
  assert.ok(game.drainEvents().some((e) => e.type === 'mower_respawn'));
  // and it can be started again
  game.handleInput('z', { use: true });
  game.tick(1 / 30);
  assert.equal(mower.state, 'starting');
});

test('a wrecked mower does not shield anyone and the old driver can be hurt again', () => {
  const { game, z, mower } = drivingSetup();
  applyDamage(game, mower, 999, null);
  assert.equal(mower.state, 'destroyed');
  assert.equal(applyDamage(game, z, 1, null), true);
  assert.ok(z.hp < z.maxHp);
});

test('the mower resets to full HP on a new round', () => {
  const { game, mower } = drivingSetup();
  applyDamage(game, mower, 10, null);
  assert.equal(mower.hp, 30);
  game.startRound();
  assert.equal(game.mower.hp, 40);
  assert.equal(game.mower.state, 'idle');
});
