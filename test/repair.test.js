import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, publicConfig } from '../server/sim/config.js';
import { WORLD, inRect } from '../server/sim/world.js';
import { MAP } from '../server/sim/map.js';
import { pileNear } from '../server/sim/repair.js';
import { applyDamage } from '../server/sim/combat.js';
import { makeGame, run, keys, insideStatic } from './helpers.js';

const R = DEFAULT_CONFIG.repair;
const pile = (door) => WORLD.repair.find((r) => r.door === door);

/** A plant kid standing at a door's pile, holding E, and a far-away zombie kid. */
function repairGame(door = 'front', extra = {}) {
  const game = makeGame({ features: { cover: false, ...extra.features }, ...extra.config });
  const p = game.addPlayer('p', { name: 'Pea', team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { name: 'Zed', team: 'zombie' });
  const at = pile(door);
  p.x = at.x;
  p.z = at.z;
  p.y = 0;
  z.x = 30;
  z.z = -30;
  game.drainEvents();
  return { game, p, z, door: game.cover.get(`door:${door}`) };
}
const hold = (game, over = {}) => game.handleInput('p', { use: true, keys: keys(), fire: false, ...over });

test('config: free repair of 9 HP/s, a pile just inside every door, and it is public', () => {
  assert.equal(R.rate, 9);
  assert.equal(R.rebuildTime, 3);
  assert.equal(R.rebuildHp, 0.25);
  assert.deepEqual(publicConfig().repair, R);
  assert.deepEqual(publicConfig().map.repairPiles, WORLD.repair);
  assert.deepEqual(publicConfig().doorHp, DEFAULT_CONFIG.doorHp);
  assert.deepEqual(WORLD.repair.map((r) => r.door).sort(), ['back', 'front', 'garage', 'side']);
});

test('every pile is inside, beside its door, in the open and off the waypoint edges', () => {
  for (const r of WORLD.repair) {
    const d = WORLD.doors.find((x) => x.id === r.door);
    const inside = inRect(WORLD.house, r.x, r.z) || inRect(WORLD.garage, r.x, r.z);
    assert.ok(inside, `${r.door} pile is indoors`);
    assert.ok(Math.hypot(r.x - d.x, r.z - d.z) < 4.5, `${r.door} pile is by the door`);
    assert.equal(insideStatic({ x: r.x, z: r.z, y: 0 }), null, `${r.door} pile is not inside furniture`);
    for (const c of MAP.statics) {
      if (c.blocks === false || c.y1 <= 0.5 || c.y0 >= 1.8) continue;
      if (c.s === 'box') assert.ok(!(r.x > c.minX - 0.5 && r.x < c.maxX + 0.5 && r.z > c.minZ - 0.5 && r.z < c.maxZ + 0.5), `${r.door} pile has room around it (${c.style})`);
    }
  }
});

test('hold E at the pile: the door heals 9 HP/s, free, up to its maximum', () => {
  const { game, p, door } = repairGame('front');
  p.sunshine = 100;
  door.hp = 100;
  hold(game);
  run(game, 3);
  assert.ok(Math.abs(door.hp - (100 + 3 * R.rate)) < 1.5, `hp ${door.hp}`);
  assert.equal(p.sunshine, 100, 'free');
  assert.equal(game.entities.get('p').repairing, 'front');
  assert.ok(game.drainEvents().some((e) => e.type === 'repair' && e.id === 'p' && e.door === 'front'));
  run(game, 20);
  assert.equal(door.hp, door.maxHp);
  assert.equal(p.repairing, undefined, 'nothing left to mend: no longer repairing');
  assert.deepEqual(game.snapshot().doors, [220, 220, 220, 360]);
});

test('repair rearms the hit steps and shows in the snapshot', () => {
  const { game, door } = repairGame('back');
  door.hp = 60;
  door.step = 3;
  hold(game);
  run(game, 1);
  const snap = game.snapshot();
  assert.equal(snap.doors[2], Math.ceil(door.hp));
  assert.ok(snap.doors[2] > 60);
  assert.equal(snap.entities.find((e) => e.id === 'p').repairing, 'back');
  run(game, 25);
  assert.equal(door.step, 0);
  game.drainEvents();
  game.cover.damage(door, 70, game.entities.get('z'), 'zombie'); // 220 -> 150 = 68%
  assert.ok(game.drainEvents().some((e) => e.type === 'coverHit' && e.id === 'door:back'), 'the 75 % step fires again');
});

test('moving, jumping, shooting, releasing E or standing away from the pile all stop the work', () => {
  const { game, p, door } = repairGame('side');
  door.hp = 50;
  const hpAfter = (over, secs = 1) => {
    const before = door.hp;
    hold(game, over);
    run(game, secs);
    return door.hp - before;
  };
  assert.ok(hpAfter({}) > 5, 'still: works');
  assert.equal(hpAfter({ keys: keys({ f: true }) }, 0.3) < 1, true, 'walking');
  p.x = pile('side').x;
  p.z = pile('side').z;
  assert.ok(hpAfter({ keys: keys({ jump: true }) }, 0.1) < 1, 'jumping');
  p.x = pile('side').x;
  p.z = pile('side').z;
  p.y = 0;
  p.vy = 0;
  p.grounded = true;
  run(game, 1);
  assert.ok(hpAfter({ fire: true }) < 1, 'shooting');
  assert.ok(hpAfter({ use: false }) < 1, 'not holding E');
  p.x += 4;
  assert.ok(hpAfter({}) < 1, 'standing away from the pile');
  assert.equal(pileNear(DEFAULT_CONFIG, p.x, p.z), null);
});

test('a zombie kid cannot repair; zombies near the pile change nothing; a hit on the repairer pauses the work', () => {
  const { game, p, z, door } = repairGame('front');
  door.hp = 100;
  z.x = pile('front').x + 0.5;
  z.z = pile('front').z;
  z.y = 0;
  game.handleInput('z', { use: true });
  run(game, 2);
  assert.equal(door.hp, 100, 'zombies do nothing');
  hold(game);
  run(game, 1);
  const hp1 = door.hp;
  assert.ok(hp1 > 100);
  applyDamage(game, p, 1, z);
  run(game, 0.5);
  assert.ok(Math.abs(door.hp - hp1) < 0.01, 'hit: work paused');
  run(game, R.hurtPause + 0.5);
  assert.ok(door.hp > hp1 + 3, 'back to work');
});

test('two repairers work twice as fast', () => {
  const { game, door } = repairGame('garage');
  const q = game.addPlayer('q', { team: 'plant', mode: 'versus' });
  q.x = pile('garage').x + 0.5;
  q.z = pile('garage').z;
  q.y = 0;
  door.hp = 100;
  hold(game);
  game.handleInput('q', { use: true });
  run(game, 3);
  assert.ok(Math.abs(door.hp - (100 + 2 * 3 * R.rate)) < 3, `hp ${door.hp}`);
});

test('a fully broken door is rebuilt after 3 s of work with 25 % HP, walls zombies again, and repair carries on', () => {
  const { game, p, z, door } = repairGame('front');
  game.cover.destroy(door);
  assert.equal(door.state, 'broken');
  assert.deepEqual(game.snapshot().doors[0], 0);
  assert.ok(game.mapState().gone.includes('door:front'));
  // zombies walk through the open doorway
  z.x = 5;
  z.z = 3;
  z.y = 0;
  game.handleInput('z', { keys: keys({ f: true }), yaw: Math.PI, pitch: 0 }); // +z, into the house
  run(game, 1);
  assert.ok(z.z > 8, `walked in, z=${z.z}`);
  z.x = 30;
  z.z = -30;
  game.handleInput('z', { keys: keys() });
  game.drainEvents();
  hold(game);
  run(game, 1.5);
  assert.equal(door.state, 'broken', 'not yet');
  assert.ok(p.rebuild > 0.4 && p.rebuild < 0.6, `rebuild progress ${p.rebuild}`);
  run(game, 1.6);
  assert.equal(door.state, 'alive');
  const up = game.drainEvents().find((e) => e.type === 'doorUp');
  assert.ok(up && up.id === 'door:front');
  assert.ok(door.hp >= door.maxHp * R.rebuildHp - 0.1 && door.hp < door.maxHp * R.rebuildHp + 3 * R.rate, `hp ${door.hp}`);
  assert.ok(!game.mapState().gone.includes('door:front'));
  assert.equal(game.cover.canHurt(door, 'zombie'), true);
  run(game, 30);
  assert.equal(door.hp, door.maxHp);
  // zombies are stopped again, plants still walk through
  z.x = 5;
  z.z = 3;
  z.y = 0;
  game.handleInput('z', { keys: keys({ f: true }), yaw: Math.PI, pitch: 0 });
  run(game, 1.5);
  assert.ok(z.z < 6.2 - z.radius + 0.05, `blocked outside the door, z=${z.z}`);
  p.x = 5;
  p.z = 8;
  game.handleInput('p', { use: false, keys: keys({ b: true }), yaw: Math.PI, pitch: 0 }); // backwards = -z, out through the door
  run(game, 1.5);
  assert.ok(p.z < 4.5, `the plant walked out through its own door, z=${p.z}`);
});

test('a rebuild waits while a zombie stands in the doorway and starts over if the work is interrupted', () => {
  const { game, p, z, door } = repairGame('front');
  game.cover.destroy(door);
  z.x = 5;
  z.z = 6.2;
  z.y = 0;
  hold(game);
  run(game, 6);
  assert.equal(door.state, 'broken', 'a zombie in the doorway: no rebuild');
  z.x = 30;
  z.z = -30;
  run(game, 0.3);
  assert.equal(door.state, 'alive', 'done as soon as the doorway is clear');
  game.cover.destroy(door);
  hold(game);
  run(game, 2);
  hold(game, { use: false });
  run(game, 0.2);
  assert.equal(door.rebuildT, 0, 'interrupted: start over');
  hold(game);
  run(game, 2);
  assert.equal(door.state, 'broken');
  void p;
});

test('doors are full again every round', () => {
  const { game, door } = repairGame('front');
  game.cover.destroy(door);
  game.startRound();
  assert.equal(game.cover.get('door:front').state, 'alive');
  assert.deepEqual(game.snapshot().doors, [220, 220, 220, 360]);
});
