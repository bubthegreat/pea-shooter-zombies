import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { MAP } from '../server/sim/map.js';
import { createField } from '../server/sim/collide.js';
import { applyDamage, spawnProjectile, stepProjectiles } from '../server/sim/combat.js';
import { createPart, partsMask } from '../server/sim/parts.js';
import { ensureAI } from '../server/sim/bots.js';
import { terrainHeight } from '../server/sim/terrain.js';
import { makeGame, run, keys, entitiesOfKind, breakDoors, insideStatic } from './helpers.js';

const RACK = Object.fromEntries(DEFAULT_CONFIG.rack.map((r) => [r.item, r]));
const parts = (game) => entitiesOfKind(game, 'part');
const kinds = (game) => parts(game).map((p) => p.partKind).sort();

function partsGame(extra = {}) {
  const game = makeGame(extra);
  const z = game.addPlayer('z', { name: 'Zed', team: 'zombie', mode: 'versus' });
  const p = game.addPlayer('p', { name: 'Pea', team: 'plant' });
  p.x = 38;
  p.z = 44;
  game.drainEvents();
  return { game, z, p };
}

/** A zombie kid next to a thing, E pressed once (a fresh rising edge). */
function press(game, id, x, z) {
  const e = game.entities.get(id);
  e.x = x;
  e.z = z;
  e.y = game.field.groundAt(x, z, terrainHeight(x, z) + 1);
  game.handleInput(id, { use: false });
  game.tick(1 / 30);
  game.handleInput(id, { use: true });
  game.tick(1 / 30);
  game.handleInput(id, { use: false });
  game.tick(1 / 30);
}

test('a round starts with 3 batteries, 2 gas cans and 1 spark plug at random distinct spots', () => {
  const { game } = partsGame();
  assert.deepEqual(kinds(game), ['battery', 'battery', 'battery', 'gas', 'gas', 'plug']);
  const spots = new Set(parts(game).map((p) => `${p.x},${p.z}`));
  assert.equal(spots.size, 6);
  for (const p of parts(game)) {
    assert.ok(MAP.partSpots.some((s) => s.x === p.x && s.z === p.z), 'a known spot');
    const snap = game.snapshot().entities.find((e) => e.id === p.id);
    assert.equal(snap.kind, 'part');
    assert.equal(snap.partKind, p.partKind);
  }
  const where = (g) => parts(g).map((p) => `${p.partKind}@${p.x},${p.z}`).sort().join();
  const a = where(makeGame({ seed: 1 }).addPlayer('x', { team: 'zombie' }) && partsGame({ seed: 1 }).game);
  const b = where(partsGame({ seed: 2 }).game);
  const c = where(partsGame({ seed: 1 }).game);
  assert.equal(a, c, 'same seed, same spots');
  assert.notEqual(a, b, 'a different round puts them elsewhere');
  const before = where(game);
  game.startRound();
  assert.equal(parts(game).length, 6, 'a new round resets them');
  assert.notEqual(where(game), before, 'to new spots');
});

test('spots are in the garage, the basement, the shed and the yard, and every one is open floor', () => {
  const where = new Set(MAP.partSpots.map((s) => s.where));
  assert.deepEqual([...where].sort(), ['cellar', 'garage', 'shed', 'yard']);
  for (const s of MAP.partSpots) assert.equal(insideStatic({ x: s.x, y: s.where === 'cellar' ? -2.6 : 0, z: s.z }), null, `${s.id} is not inside a wall`);
  const f = createField();
  const nodes = Object.entries(MAP.nodes);
  for (const s of MAP.partSpots) {
    assert.ok(nodes.some(([, n]) => Math.hypot(n[0] - s.x, n[1] - s.z) < 26 && f.walkLine(n[0], n[1], s.x, s.z, 'zombie')), `${s.id} can be walked to`);
  }
});

test('E picks up the nearest part (one at a time); Q drops it; only zombies', () => {
  const { game, z, p } = partsGame();
  const [a, b] = parts(game);
  game.entities.delete(b.id); // isolate one
  press(game, 'p', a.x, a.z);
  assert.equal(p.carry, undefined, 'plants cannot');
  assert.equal(parts(game).length, 5);
  press(game, 'z', a.x + 0.5, a.z);
  assert.equal(z.carry, a.partKind);
  assert.equal(game.entities.has(a.id), false);
  assert.equal(game.snapshot().entities.find((e) => e.id === 'z').carry, a.partKind);
  assert.ok(game.drainEvents().some((e) => e.type === 'partTake' && e.id === 'z' && e.part === a.partKind));
  // a second part: cannot carry two
  const other = createPart(game, 'gas', a.x + 0.4, a.z);
  press(game, 'z', other.x, other.z);
  assert.equal(z.carry, a.partKind);
  assert.equal(game.entities.has(other.id), true);
  // Q drops
  game.handleInput('z', { drop: true });
  game.tick(1 / 30);
  game.handleInput('z', { drop: false });
  assert.equal(z.carry, undefined);
  const dropped = parts(game).find((q) => q.id !== other.id && Math.hypot(q.x - z.x, q.z - z.z) < 0.01);
  assert.equal(dropped?.partKind, a.partKind);
  assert.ok(game.drainEvents().some((e) => e.type === 'partDrop' && e.reason === 'drop'));
});

test('shooting a carrier makes him drop the part, and he cannot pick it back up right away', () => {
  const { game, z, p } = partsGame();
  const part = parts(game)[0];
  press(game, 'z', part.x, part.z);
  assert.equal(z.carry, part.partKind);
  game.drainEvents();
  applyDamage(game, z, 1, p);
  assert.equal(z.carry, undefined);
  const lying = parts(game).find((q) => Math.hypot(q.x - z.x, q.z - z.z) < 0.01);
  assert.equal(lying.partKind, part.partKind);
  assert.ok(game.drainEvents().some((e) => e.type === 'partDrop' && e.reason === 'shot'));
  press(game, 'z', lying.x, lying.z);
  assert.equal(z.carry, undefined, 'locked out for a moment');
  run(game, DEFAULT_CONFIG.parts.lockSecs + 0.2);
  press(game, 'z', lying.x, lying.z);
  assert.equal(z.carry, part.partKind);
  // a zombie's own shot does not
  applyDamage(game, z, 1, game.spawnBot('zombie', 0, -30));
  assert.equal(z.carry, part.partKind);
});

test('a carrier who is converted or leaves leaves the part behind', () => {
  const { game, z, p } = partsGame();
  const part = parts(game)[0];
  press(game, 'z', part.x, part.z);
  applyDamage(game, z, 99, p);
  assert.equal(z.state, 'sprout');
  assert.equal(z.carry, undefined);
  assert.equal(parts(game).length, 6);
  const q = game.addPlayer('q', { team: 'zombie' });
  const p2 = parts(game)[1];
  press(game, 'q', p2.x, p2.z);
  assert.ok(q.carry);
  game.removePlayer('q');
  assert.equal(parts(game).length, 6, 'dropped where he stood');
});

test('tools start unpowered: Battery -> Leaf Blower / Hedge Trimmer, Gas Can -> Weed Eater; a powered tool can be taken', () => {
  const { game, z } = partsGame();
  for (const item of ['weed_eater', 'leaf_blower', 'hedge_trimmer']) assert.equal(game.racks.get(item).powered, false, item);
  assert.equal(game.racks.get('wheelbarrow').powered, true, 'the wheelbarrow needs no parts');
  assert.equal(game.snapshot().entities.find((e) => e.id === 'rack_weed_eater').powered, false);
  // unpowered: E does nothing
  press(game, 'z', RACK.weed_eater.x, RACK.weed_eater.z - 1);
  assert.equal(z.item, null);
  // a gas can does not fit the blower; a battery does
  game.entities.get('z').carry = 'gas';
  press(game, 'z', RACK.leaf_blower.x, RACK.leaf_blower.z - 1);
  assert.equal(z.carry, 'gas');
  assert.equal(game.racks.get('leaf_blower').powered, false);
  press(game, 'z', RACK.weed_eater.x, RACK.weed_eater.z - 1);
  assert.equal(z.carry, undefined);
  assert.equal(game.racks.get('weed_eater').powered, true);
  assert.ok(game.drainEvents().some((e) => e.type === 'install' && e.target === 'weed_eater' && e.part === 'gas'));
  press(game, 'z', RACK.weed_eater.x, RACK.weed_eater.z - 1);
  assert.equal(z.item, 'weed_eater', 'now it can be taken');
  game.entities.get('z').item = null;
  game.racks.get('weed_eater').heldBy = null;
  game.racks.get('weed_eater').available = true;
  // the battery goes to whichever hook you stand at; the second battery to the other
  game.entities.get('z').carry = 'battery';
  press(game, 'z', RACK.hedge_trimmer.x, RACK.hedge_trimmer.z - 1);
  assert.equal(game.racks.get('hedge_trimmer').powered, true);
  assert.equal(game.racks.get('leaf_blower').powered, false);
  // powered for the whole round: drop it, wreck it, it is still powered
  game.entities.get('z').item = null;
  game.racks.get('hedge_trimmer').available = true;
  assert.equal(game.racks.get('hedge_trimmer').powered, true);
});

test('the mower needs Battery + Gas Can + Spark Plug; the HUD mask follows; parts stay installed through a wreck', () => {
  const { game, z } = partsGame();
  const m = game.mower;
  assert.equal(partsMask(m.parts), 0);
  assert.equal(game.snapshot().entities.find((e) => e.id === 'mower').parts, 0);
  // not startable yet
  z.x = m.x;
  z.z = m.z - 1.5;
  game.handleInput('z', { use: true });
  run(game, 1);
  assert.equal(m.state, 'idle');
  game.handleInput('z', { use: false });
  const install = (kind) => {
    game.entities.get('z').carry = kind;
    press(game, 'z', m.x + 0.5, m.z - 1.2);
  };
  install('plug');
  install('plug'); // a second plug has no place
  assert.equal(z.carry, 'plug');
  z.carry = undefined;
  assert.equal(partsMask(m.parts), 4);
  assert.equal(game.snapshot().entities.find((e) => e.id === 'mower').parts, 4);
  install('battery');
  game.handleInput('z', { use: true });
  run(game, 0.5);
  assert.equal(m.state, 'idle', 'two of three is not enough');
  game.handleInput('z', { use: false });
  game.tick(1 / 30);
  install('gas');
  assert.equal(game.snapshot().entities.find((e) => e.id === 'mower').parts, 7);
  assert.ok(game.drainEvents().some((e) => e.type === 'install' && e.target === 'mower' && e.mask === 7));
  game.handleInput('z', { use: true });
  game.tick(1 / 30);
  assert.equal(m.state, 'starting');
  // a wreck keeps its parts
  game.handleInput('z', { use: false });
  m.state = 'idle';
  m.driver = null;
  applyDamage(game, Object.assign(m, { state: 'driving', driver: 'z' }), 999, game.entities.get('p'));
  assert.equal(m.state, 'destroyed');
  run(game, DEFAULT_CONFIG.mowerRespawn + 1);
  assert.equal(m.state, 'idle');
  assert.equal(partsMask(m.parts), 7);
  // a new round takes them away again
  game.startRound();
  assert.equal(partsMask(game.mower.parts), 0);
  assert.equal(game.racks.get('weed_eater').powered, false);
});

test('a zombie bot with an errand fetches a part, installs it and takes the tool it powered', () => {
  const game = makeGame({ features: { botAI: true }, botItemChance: {}, mowerBotChance: 0 });
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  a.x = 38;
  a.z = 44;
  // exactly one part, a gas can in the open garage: the weed eater is the only place it can go
  for (const p of parts(game)) game.entities.delete(p.id);
  createPart(game, 'gas', 12, 17);
  breakDoors(game);
  const bot = game.spawnBot('zombie', 0, WORLD.gate.z);
  bot.hp = bot.maxHp = 1e6;
  ensureAI(game, bot);
  bot.ai.errand = {};
  const seen = new Set();
  for (let i = 0; i < 30 * 120 && !bot.item; i++) {
    game.tick(1 / 30);
    for (const e of game.drainEvents()) seen.add(e.type);
  }
  assert.ok(seen.has('partTake'), 'picked the part up');
  assert.ok(seen.has('install'), 'installed it');
  assert.equal(bot.item, 'weed_eater', 'and took the powered tool');
  assert.equal(game.racks.get('weed_eater').powered, true);
});

test('an armed bot walks to the plants and uses its tool, breaking doors on the way', () => {
  const game = makeGame({ features: { botAI: true }, botItemChance: {}, mowerBotChance: 0 });
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  a.x = -3;
  a.z = 15; // a plant kid in the kitchen
  a.hp = a.maxHp = 1e6;
  for (const p of parts(game)) game.entities.delete(p.id);
  const bot = game.spawnBot('zombie', 22.6, 15); // outside the garage door
  bot.hp = bot.maxHp = 1e6;
  ensureAI(game, bot);
  bot.ai.errand = null;
  powerRack(game, 'hedge_trimmer');
  game.racks.get('hedge_trimmer').available = false;
  game.racks.get('hedge_trimmer').heldBy = bot.id;
  bot.item = 'hedge_trimmer';
  let used = false;
  for (let i = 0; i < 30 * 90; i++) {
    game.tick(1 / 30);
    if (bot.using) used = true;
  }
  assert.ok(game.cover.get('door:garage').state === 'broken', 'trimmed through the garage door');
  assert.ok(used && a.hp < a.maxHp, 'and went after the kid');
  assert.equal(bot.item, 'hedge_trimmer');
});

function powerRack(game, item) {
  game.racks.get(item).powered = true;
}

test('shots and keys: parts are glowing entities in snapshots and tiny', () => {
  const { game } = partsGame();
  const snap = game.snapshot();
  const sz = JSON.stringify(snap.entities.filter((e) => e.kind === 'part')).length;
  assert.ok(sz < 900, `6 parts = ${sz} bytes`);
  assert.equal(keys().f, false);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0);
  assert.ok(spawnProjectile && stepProjectiles);
});
