import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD } from '../server/sim/world.js';
import { MAP } from '../server/sim/map.js';
import { STEP, createField } from '../server/sim/collide.js';
import { terrainHeight } from '../server/sim/terrain.js';
import { spawnProjectile, stepProjectiles } from '../server/sim/combat.js';
import { makeGame, run, keys, entitiesOfKind, insideStatic, breakDoors } from './helpers.js';

const door = (id) => WORLD.doors.find((d) => d.id === id);

function walker(team = 'plant') {
  const game = makeGame();
  const p = game.addPlayer('a', { team, mode: 'versus' });
  game.addPlayer('keep', { team: team === 'plant' ? 'zombie' : 'plant' });
  return { game, p };
}

test('walls slide you: walking diagonally into the house wall keeps you moving along it', () => {
  const { game, p } = walker();
  p.x = -6;
  p.z = WORLD.house.minZ - 1;
  game.handleInput('a', { keys: keys({ f: true, r: true }), yaw: Math.PI, pitch: 0 }); // yaw PI: forward is +z (into the wall), right is -x
  const x0 = p.x;
  run(game, 0.6);
  assert.ok(p.z <= WORLD.house.minZ - 0.5 + 0.01, `stopped by the wall, z=${p.z}`);
  assert.ok(Math.abs(p.x - x0) > 1.5, `slid along it, x ${x0} -> ${p.x}`);
  assert.equal(insideStatic(p), null);
});

test('plants walk through their own doors; zombies are stopped until the door breaks', () => {
  for (const [team, passes] of [['plant', true], ['zombie', false]]) {
    const { game, p } = walker(team);
    const d = door('front');
    p.x = d.x;
    p.z = d.z - 4;
    game.handleInput('a', { keys: keys({ f: true }), yaw: Math.PI, pitch: 0 }); // +z
    run(game, 2);
    assert.equal(p.z > d.z + 1, passes, `${team} at z=${p.z}`);
  }
  const { game, p } = walker('zombie');
  breakDoors(game, 'front');
  const d = door('front');
  p.x = d.x;
  p.z = d.z - 4;
  game.handleInput('a', { keys: keys({ f: true }), yaw: Math.PI, pitch: 0 });
  run(game, 2);
  assert.ok(p.z > d.z + 1, 'a broken door lets zombies in');
});

test('a ledge of about a metre needs a jump; steps do not', () => {
  const { game, p } = walker();
  const deck = WORLD.deck;
  p.x = 1;
  p.z = deck.maxZ + 3;
  game.handleInput('a', { keys: keys({ f: true }), yaw: 0, pitch: 0 }); // -z, toward the deck edge
  run(game, 2);
  assert.ok(p.z >= deck.maxZ + 0.49, `stopped at the deck edge, z=${p.z}`);
  assert.ok(p.y < 0.1, 'still on the ground');
  game.handleInput('a', { keys: keys({ f: true, jump: true }), yaw: 0, pitch: 0 });
  run(game, 1 / 30);
  game.handleInput('a', { keys: keys({ f: true }), yaw: 0, pitch: 0 });
  run(game, 1.5);
  assert.ok(Math.abs(p.y - deck.top) < 0.01 && p.z < deck.maxZ - 0.3, `up on the deck: y=${p.y} z=${p.z}`);
  // walk off the far side: fall back down
  game.handleInput('a', { keys: keys({ b: true }), yaw: 0, pitch: 0 });
  run(game, 2);
  assert.ok(p.y < 0.1, `back on the grass y=${p.y}`);
  // the steps in the middle can simply be walked
  p.x = 5;
  p.z = deck.maxZ + 3;
  p.y = 0;
  game.handleInput('a', { keys: keys({ f: true }), yaw: 0, pitch: 0 });
  run(game, 1.2);
  assert.ok(p.z < deck.maxZ - 0.3 && Math.abs(p.y - deck.top) < 0.01, `walked up the steps: y=${p.y} z=${p.z}`);
});

test('stone terraces are about a metre high: jump up, jump down', () => {
  const { game, p } = walker();
  const t = MAP.statics.find((c) => c.style === 'terrace' && c.y1 === 1.0);
  p.x = (t.minX + t.maxX) / 2;
  p.z = t.maxZ + 2;
  p.y = terrainHeight(p.x, p.z);
  game.handleInput('a', { keys: keys({ f: true, jump: true }), yaw: 0, pitch: 0 });
  run(game, 1 / 30);
  game.handleInput('a', { keys: keys({ f: true }), yaw: 0, pitch: 0 });
  run(game, 0.45);
  game.handleInput('a', { keys: keys(), yaw: 0, pitch: 0 });
  run(game, 0.3);
  assert.ok(Math.abs(p.y - t.y1) < 0.01, `on the terrace y=${p.y}`);
  game.handleInput('a', { keys: keys({ b: true }), yaw: 0, pitch: 0 });
  run(game, 1.5);
  assert.ok(p.y < t.y1 - 0.5, `back down y=${p.y}`);
});

test('hills are walked over: the player rides the ground height', () => {
  const { game, p } = walker();
  p.x = -18;
  p.z = -50 + 10; // north slope of the big mound
  const ys = [];
  game.handleInput('a', { keys: keys({ f: false, b: true }), yaw: 0, pitch: 0 }); // walk +z up the mound
  for (let i = 0; i < 30 * 5; i++) {
    game.tick(1 / 30);
    ys.push(p.y);
    assert.ok(Math.abs(p.y - terrainHeight(p.x, p.z)) < 0.05, `feet on the ground at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}: ${p.y}`);
  }
  assert.ok(Math.max(...ys) > 1.0, `climbed ${Math.max(...ys)}`);
});

test('the basement: walk down the stairs into it, ceiling above, walls around', () => {
  const { game, p } = walker();
  p.x = -21;
  p.z = 22.4;
  game.handleInput('a', { keys: keys({ f: true }), yaw: -Math.PI / 2, pitch: 0 }); // +x, down the ramp
  run(game, 4);
  assert.ok(p.x > -13 && p.y < -2.4, `in the basement x=${p.x} y=${p.y}`);
  assert.equal(insideStatic(p), null);
  // you cannot climb out through the steep margin
  game.handleInput('a', { keys: keys({ f: true }), yaw: 0, pitch: 0 }); // -z
  run(game, 3);
  assert.ok(p.y < -2.4, 'walls hold');
  // shots do not leave through the floor above
  const field = game.field;
  assert.ok(field.segment(-10, p.y + 1.6, 21, -10, 3, 21), 'the ceiling is solid');
});

test('shots: walls and closed doors stop zombie fire, plant fire goes through plant doors; hills block sight', () => {
  const game = makeGame();
  const keep = game.addPlayer('keep', { team: 'plant' });
  keep.x = 38;
  keep.z = 44; // out of the line of fire
  const d = door('front');
  const zStart = d.z - 3;
  const shoot = (team) => {
    const q = spawnProjectile(game, { team, owner: 'x', projKind: team === 'plant' ? 'pea' : 'bullet', damage: 1, speed: 40, x: d.x, y: 1.2, z: zStart, dir: { x: 0, y: 0, z: 1 } });
    return q;
  };
  const pz = shoot('zombie');
  const pp = shoot('plant');
  for (let i = 0; i < 12; i++) stepProjectiles(game, 1 / 30);
  assert.equal(game.entities.has(pz.id), false, 'the zombie shot hit the door');
  assert.ok(game.cover.get('door:front').hp < game.config.doorHp.front);
  assert.equal(game.entities.has(pp.id), true, 'the pea sailed through');
  assert.ok(pp.z > d.z + 1);
  // walls
  const w = spawnProjectile(game, { team: 'plant', owner: 'x', projKind: 'pea', damage: 1, speed: 40, x: -10, y: 1.2, z: WORLD.house.minZ - 3, dir: { x: 0, y: 0, z: 1 } });
  for (let i = 0; i < 12; i++) stepProjectiles(game, 1 / 30);
  assert.equal(game.entities.has(w.id), false, 'stopped by the wall');
  // sight
  assert.equal(game.field.clearLine(-18, 1.6, -45, -18, 1.6, -22, null), false, 'the big mound is in the way');
  assert.equal(game.field.clearLine(3, 1.6, -30, 3, 1.6, -5, null), true, 'open lawn');
});

test('walkLine: nodes on the deck and bridge see each other at the right height', () => {
  const f = createField();
  assert.equal(f.walkLine(5, 26.2, 5, 31.2, 'zombie'), true, 'deck to lawn over the steps');
  assert.equal(f.walkLine(-35, -17, -35, -10.5, 'zombie'), true, 'onto the bridge');
  assert.equal(f.walkLine(5, 15, -2, 22, 'zombie'), false, 'wall of the kitchen in between');
});

test('every doorway has a clear corridor, and the fridge zone is open floor', () => {
  const f = createField();
  for (const dw of WORLD.doorways) {
    for (const dz of [-1.2, 0, 1.2]) assert.equal(f.walkLine(dw.x - 2, dw.z + dz, dw.x + 2, dw.z + dz, 'zombie'), true, `${dw.id} at ${dz}`);
  }
  const st = WORLD.fridge.stand;
  assert.equal(f.walkLine(st.x - 1.5, st.z, st.x + 1.5, st.z, 'zombie'), true);
  assert.ok(STEP >= 0.4 && STEP <= 0.6);
  assert.equal(entitiesOfKind(makeGame(), 'projectile').length, 0);
});
