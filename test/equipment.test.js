import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, publicConfig } from '../server/sim/config.js';
import { WORLD, gardenSlots } from '../server/sim/world.js';
import { plantAt, spawnSun } from '../server/sim/garden.js';
import { applyDamage, spawnProjectile } from '../server/sim/combat.js';
import { makeGame, run, keys, entitiesOfKind } from './helpers.js';

const EQ = DEFAULT_CONFIG.equipment;
const RACK = Object.fromEntries(DEFAULT_CONFIG.rack.map((r) => [r.item, r]));

function setup(extra = {}) {
  const game = makeGame(extra);
  const z = game.addPlayer('z', { name: 'Zed', team: 'zombie', mode: 'versus' });
  const p = game.addPlayer('p', { name: 'Pea', team: 'plant' });
  p.x = 0;
  p.z = 0;
  return { game, z, p };
}

/** Put zombie `z` next to a rack item and press E. */
function grab(game, z, item) {
  z.x = RACK[item].x;
  z.z = RACK[item].z - 1;
  game.handleInput(z.id, { use: false });
  game.tick(1 / 30);
  game.handleInput(z.id, { use: true });
  game.tick(1 / 30);
  game.handleInput(z.id, { use: false });
}

const snapOf = (game, id) => game.snapshot().entities.find((e) => e.id === id);

test('four tools hang on the garage rack at round start, one each', () => {
  const { game } = setup();
  const racks = entitiesOfKind(game, 'rack_item');
  assert.deepEqual(racks.map((r) => r.itemId).sort(), ['hedge_trimmer', 'leaf_blower', 'weed_eater', 'wheelbarrow']);
  for (const r of racks) {
    assert.equal(r.available, true);
    assert.equal(r.heldBy, null);
    assert.ok(r.x >= WORLD.garage.doorMinX && r.x <= WORLD.garage.doorMaxX);
    assert.ok(r.z > WORLD.bounds.maxZ && r.z < 43, `inside the garage z=${r.z}`);
    const s = snapOf(game, r.id);
    assert.equal(s.kind, 'rack_item');
    assert.equal(s.itemId, r.itemId);
    assert.equal(s.available, true);
    assert.equal(s.heldBy, null);
    assert.equal(s.respawnIn, undefined);
  }
  assert.equal(game.snapshot().entities.find((e) => e.id === 'z').item, null);
  const cfg = publicConfig();
  assert.equal(cfg.rack.length, 4);
  assert.equal(cfg.rackUseRange, 2);
  for (const id of Object.keys(EQ)) assert.ok(typeof cfg.equipment[id].blurb === 'string' && cfg.equipment[id].name);
});

test('E at a rack takes the item; only zombies, only if free, only near, one at a time', () => {
  const { game, z, p } = setup();
  // a plant kid cannot
  p.x = RACK.weed_eater.x;
  p.z = RACK.weed_eater.z - 1;
  game.handleInput('p', { use: true });
  game.tick(1 / 30);
  assert.equal(p.item, null);
  game.handleInput('p', { use: false });
  // too far away
  z.x = RACK.weed_eater.x;
  z.z = RACK.weed_eater.z - 4;
  game.handleInput('z', { use: true });
  game.tick(1 / 30);
  assert.equal(z.item, null);
  game.handleInput('z', { use: false });
  game.tick(1 / 30);
  game.drainEvents();
  grab(game, z, 'weed_eater');
  assert.equal(z.item, 'weed_eater');
  assert.equal(snapOf(game, 'z').item, 'weed_eater');
  const rack = game.racks.get('weed_eater');
  assert.equal(rack.available, false);
  assert.equal(rack.heldBy, 'z');
  assert.ok(game.drainEvents().some((e) => e.type === 'item_take' && e.id === 'z' && e.itemId === 'weed_eater'));
  // one instance only
  const bot = game.spawnBot('zombie', RACK.weed_eater.x + 0.5, RACK.weed_eater.z - 1);
  bot.usePressed = true;
  game.tick(1 / 30);
  assert.equal(bot.item, null);
  // already holding: E elsewhere never swaps in a second item
  assert.equal(z.item, 'weed_eater');
});

test('holding E on arrival does not grab (a fresh press is needed)', () => {
  const { game, z } = setup();
  z.x = 14.5;
  z.z = 33; // away from every rack hook and from the mower
  game.handleInput('z', { use: true });
  game.tick(1 / 30);
  z.x = RACK.hedge_trimmer.x;
  run(game, 0.3);
  assert.equal(z.item, null);
});

test('Q drops, E away from the rack drops, E at the rack puts it straight back; dropped items return after 20 s', () => {
  const { game, z } = setup();
  grab(game, z, 'leaf_blower');
  assert.equal(z.item, 'leaf_blower');
  // Q away from the rack
  z.x = 20;
  z.z = 36;
  game.handleInput('z', { drop: true });
  game.tick(1 / 30);
  game.handleInput('z', { drop: false });
  assert.equal(z.item, null);
  const rack = game.racks.get('leaf_blower');
  assert.equal(rack.available, false);
  assert.equal(rack.heldBy, null);
  let ev = game.drainEvents().find((e) => e.type === 'item_drop');
  assert.ok(ev && ev.id === 'z' && ev.itemId === 'leaf_blower' && ev.reason === 'drop');
  assert.ok(snapOf(game, rack.id).respawnIn > 19);
  run(game, 19);
  assert.equal(rack.available, false);
  run(game, 1.2);
  assert.equal(rack.available, true);
  assert.ok(game.drainEvents().some((e) => e.type === 'item_respawn' && e.itemId === 'leaf_blower'));
  // take it again and drop it with E away from the rack
  grab(game, z, 'leaf_blower');
  assert.equal(z.item, 'leaf_blower');
  z.x = 20;
  z.z = 34;
  game.handleInput('z', { use: true });
  game.tick(1 / 30);
  game.handleInput('z', { use: false });
  assert.equal(z.item, null);
  assert.equal(game.racks.get('leaf_blower').available, false);
  run(game, 21);
  // put back by pressing E at the rack: available immediately
  grab(game, z, 'leaf_blower');
  game.handleInput('z', { use: true });
  game.tick(1 / 30);
  game.handleInput('z', { use: false });
  assert.equal(z.item, null);
  assert.equal(game.racks.get('leaf_blower').available, true);
  ev = game.drainEvents().filter((e) => e.type === 'item_drop').at(-1);
  assert.equal(ev.reason, 'returned');
});

test('a converted holder loses the tool; it comes back after 20 s', () => {
  const { game, z, p } = setup();
  grab(game, z, 'hedge_trimmer');
  game.drainEvents();
  applyDamage(game, z, 99, p);
  assert.equal(z.state, 'sprout');
  assert.equal(z.item, null);
  assert.equal(game.racks.get('hedge_trimmer').available, false);
  assert.ok(game.drainEvents().some((e) => e.type === 'item_drop' && e.reason === 'converted'));
  run(game, 20.5);
  assert.equal(game.racks.get('hedge_trimmer').available, true);
});

test('a holder who disconnects frees the tool; bots lose it the same way', () => {
  const { game, z } = setup();
  grab(game, z, 'weed_eater');
  game.removePlayer('z');
  game.tick(1 / 30);
  const rack = game.racks.get('weed_eater');
  assert.equal(rack.heldBy, null);
  assert.equal(rack.available, false);
  game.addPlayer('z2', { team: 'zombie' });
  run(game, 20.5);
  assert.equal(rack.available, true);

  const bot = game.spawnBot('zombie', RACK.leaf_blower.x, RACK.leaf_blower.z - 1);
  bot.usePressed = true;
  game.tick(1 / 30);
  assert.equal(bot.item, 'leaf_blower');
  applyDamage(game, bot, 99, game.entities.get('p') ?? null);
  assert.equal(game.entities.has(bot.id), false);
  assert.equal(game.racks.get('leaf_blower').heldBy, null);
  assert.equal(game.racks.get('leaf_blower').available, false);
});

test('a tool replaces the gun: fire uses the tool, no projectiles', () => {
  const { game, z } = setup();
  grab(game, z, 'weed_eater');
  z.x = 10;
  z.z = 0;
  game.handleInput('z', { fire: true, yaw: 0 });
  run(game, 1);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0);
  assert.equal(snapOf(game, 'z').using, true);
  game.handleInput('z', { fire: false });
  game.tick(1 / 30);
  assert.equal(snapOf(game, 'z').using, undefined);
});

test('the mower cannot be started with hands full: E at the mower just puts the tool down', () => {
  const { game, z } = setup();
  grab(game, z, 'weed_eater');
  z.x = WORLD.mowerHome.x;
  z.z = WORLD.mowerHome.z - 1.5;
  game.handleInput('z', { use: false });
  game.tick(1 / 30);
  game.handleInput('z', { use: true });
  run(game, 0.5);
  assert.equal(z.item, null, 'the tool was put down');
  assert.equal(game.mower.state, 'idle', 'still holding E does not start the engine');
  game.handleInput('z', { use: false });
  game.tick(1 / 30);
  game.handleInput('z', { use: true });
  game.tick(1 / 30);
  assert.equal(game.mower.state, 'starting', 'a fresh press does');
});

test('tools reset on a new round', () => {
  const { game, z } = setup();
  grab(game, z, 'weed_eater');
  game.startRound();
  assert.equal(z.item, null);
  assert.equal(entitiesOfKind(game, 'rack_item').filter((r) => r.available).length, 4);
});

// ---- the tools -------------------------------------------------------------------------------

const PEA_SLOT = gardenSlots().findIndex((s) => s.kind === 'peashooter' && s.x === 0 && s.z === 0);

/** A zombie 'z' holding `item`, standing `dist` m south (+z) of the target spot facing it (-z... we face +z? no: face the target). */
function armed(item, targetX = 0, targetZ = 0, dist = 2) {
  const { game, z, p } = setup();
  grab(game, z, item);
  z.hp = z.maxHp = 1e6; // nearby turrets must not convert the tester
  z.x = targetX;
  z.z = targetZ + dist; // looking toward -z at the target
  z.yaw = 0;
  return { game, z, p };
}

test('weed eater shreds a garden plant in about 1.5 s and counts as a kill', () => {
  const { game, z } = armed('weed_eater');
  const plant = plantAt(game, PEA_SLOT);
  game.handleInput('z', { fire: true, yaw: 0 });
  run(game, 1.2);
  assert.equal(plant.state, 'alive');
  assert.ok(plant.hp < plant.maxHp);
  run(game, 0.6);
  assert.equal(plant.state, 'dead');
  assert.equal(game.gardenCount(), 0);
  assert.equal(z.progress, 1);
  assert.ok(game.drainEvents().some((e) => e.type === 'wilt' && e.id === plant.id && e.by === 'z'));
});

test('weed eater has a short cone: nothing behind it or past 3 m is touched; plant kids take moderate damage', () => {
  const { game, z, p } = armed('weed_eater', 0, 0, 2);
  const behind = plantAt(game, PEA_SLOT);
  z.z = behind.z - 2; // plant now behind (z is further than... face +z instead of -z)
  z.yaw = 0; // faces -z, away from the plant
  game.handleInput('z', { fire: true, yaw: 0 });
  run(game, 3);
  assert.equal(behind.hp, behind.maxHp, 'behind: untouched');
  z.yaw = Math.PI; // turn around: plant 2 m ahead
  game.handleInput('z', { yaw: Math.PI });
  z.z = behind.z - 4; // 4 m: out of range
  run(game, 2);
  assert.equal(behind.hp, behind.maxHp, 'out of range: untouched');
  // a plant kid 2 m ahead wilts, but not instantly
  p.x = z.x;
  p.z = z.z + 2;
  run(game, 1.5);
  assert.ok(p.hp < p.maxHp && p.state === 'alive', `plant kid hp ${p.hp}`);
  run(game, 3);
  assert.equal(p.state, 'wilted');
});

test('hedge trimmer wilts a plant kid in about a second, chews turrets, and slows the holder 25%', () => {
  const { game, z, p } = armed('hedge_trimmer', 0, 0, 1.5);
  const speed0 = DEFAULT_CONFIG.moveSpeed;
  assert.equal(game.moveSpeedFor(z), speed0 * 0.75);
  p.x = 0;
  p.z = 0;
  z.z = 1.5;
  z.yaw = 0;
  game.handleInput('z', { fire: true, yaw: 0 });
  run(game, 0.5);
  assert.ok(p.hp < p.maxHp);
  run(game, 0.5);
  assert.equal(p.state, 'wilted', `wilted within ~1 s, hp ${p.hp}`);
  const plant = plantAt(game, PEA_SLOT);
  plant.x = 0;
  plant.z = 0;
  run(game, 1.5);
  assert.ok(plant.hp < plant.maxHp);
  run(game, 1.0);
  assert.equal(plant.state, 'dead', 'a turret lasts about 2 s');
});

test('leaf blower: pushes plant kids back, barely damages, ignores turrets mostly', () => {
  const { game, z, p } = armed('leaf_blower', 0, 0, 6);
  p.x = 0;
  p.z = 0;
  const plant = plantAt(game, PEA_SLOT);
  plant.x = 3;
  plant.z = -1;
  game.handleInput('z', { fire: true, yaw: 0 });
  run(game, 1);
  assert.ok(p.z < -3, `plant kid blown back to z=${p.z}`);
  assert.ok(p.maxHp - p.hp < 10, `tiny damage ${p.maxHp - p.hp}`);
  assert.equal(p.state, 'alive');
  run(game, 6);
  assert.equal(plant.state, 'alive', 'a turret shrugs it off');
  // the cone is narrow: a kid off to the side is left alone
  const side = { x: p.x + 12, z: p.z };
  p.x = side.x;
  p.z = side.z;
  run(game, 1);
  assert.equal(p.x, side.x);
});

test('leaf blower swats incoming peas inside its cone and blows suns away', () => {
  const { game, z, p } = armed('leaf_blower', 0, 0, 6);
  p.x = 25;
  p.z = 25; // out of the way
  game.handleInput('z', { fire: true, yaw: 0 });
  // 40 peas flying at the blower from 8 m
  for (let i = 0; i < 40; i++) {
    spawnProjectile(game, { team: 'plant', owner: 'p', projKind: 'pea', damage: 1, speed: 1, x: 0.2, y: 1.2, z: z.z - 8, dir: { x: 0, y: 0, z: 1 } });
  }
  run(game, 0.2);
  const left = entitiesOfKind(game, 'projectile').length;
  assert.ok(left <= 16, `${left}/40 peas survived`);
  assert.ok(game.drainEvents().some((e) => e.type === 'deflect'));
  // suns
  const sun = spawnSun(game, 0, z.z - 5, { landed: true });
  const z0 = sun.z;
  run(game, 1);
  assert.ok(sun.z < z0 - 3, `sun blown from ${z0} to ${sun.z}`);
});

test('leaf blower does not stop heavy shots (melon / house gun)', () => {
  const { game, z } = armed('leaf_blower', 0, 0, 6);
  game.handleInput('z', { fire: true, yaw: 0 });
  spawnProjectile(game, { team: 'plant', owner: 'p', projKind: 'housepea', damage: 5, speed: 1, x: 0, y: 1.2, z: z.z - 6, dir: { x: 0, y: 0, z: 1 } });
  run(game, 0.3);
  assert.equal(entitiesOfKind(game, 'projectile').length, 1);
});

test('wheelbarrow: 15% slower, no attack, blocks plant shots from the front and breaks after its HP', () => {
  const { game, z, p } = armed('wheelbarrow', 0, 0, 6);
  assert.equal(game.moveSpeedFor(z), DEFAULT_CONFIG.moveSpeed * 0.85);
  assert.equal(z.itemHp, 30);
  assert.equal(snapOf(game, 'z').itemHp, 30);
  // cannot attack
  p.x = 0;
  p.z = z.z - 1.5;
  game.handleInput('z', { fire: true, yaw: 0 });
  run(game, 1);
  assert.equal(p.hp, p.maxHp);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0);
  game.handleInput('z', { fire: false });
  p.x = 25;
  p.z = 25;
  // shots from the front hit the barrow, not the pusher
  game.drainEvents();
  for (let i = 0; i < 5; i++) {
    spawnProjectile(game, { team: 'plant', owner: 'p', projKind: 'pea', damage: 2, speed: 40, x: 0, y: 0.8, z: z.z - 8, dir: { x: 0, y: 0, z: 1 } });
    run(game, 0.5);
  }
  assert.equal(z.hp, z.maxHp, 'pusher untouched');
  assert.equal(z.itemHp, 20);
  const blocks = game.drainEvents().filter((e) => e.type === 'block');
  assert.equal(blocks.length, 5);
  // shots from behind hit the pusher
  spawnProjectile(game, { team: 'plant', owner: 'p', projKind: 'pea', damage: 2, speed: 40, x: 0, y: 0.8, z: z.z + 6, dir: { x: 0, y: 0, z: -1 } });
  run(game, 0.5);
  assert.equal(z.hp, z.maxHp - 2);
  assert.equal(z.itemHp, 20);
  // break it
  for (let i = 0; i < 5; i++) {
    spawnProjectile(game, { team: 'plant', owner: 'p', projKind: 'pea', damage: 4, speed: 40, x: 0, y: 0.8, z: z.z - 8, dir: { x: 0, y: 0, z: 1 } });
    run(game, 0.4);
  }
  assert.equal(z.item, null, 'the wheelbarrow broke');
  assert.ok(game.drainEvents().some((e) => e.type === 'item_drop' && e.reason === 'destroyed'));
  assert.equal(game.racks.get('wheelbarrow').available, false);
  run(game, 20.5);
  assert.equal(game.racks.get('wheelbarrow').available, true);
});

test('a zombie hiding behind the wheelbarrow is covered; one beside it is not', () => {
  const { game, z, p } = armed('wheelbarrow', 0, 0, 6);
  p.x = 25;
  p.z = 25;
  const hider = game.spawnBot('zombie', 0, z.z + 1.5);
  const side = game.spawnBot('zombie', 3, z.z - 1);
  for (const b of [hider, side]) b.hp = b.maxHp = 50;
  for (const x of [0, 3]) {
    spawnProjectile(game, { team: 'plant', owner: 'p', projKind: 'pea', damage: 2, speed: 40, x, y: 0.9, z: z.z - 10, dir: { x: 0, y: 0, z: 1 } });
  }
  run(game, 1);
  assert.equal(hider.hp, 50);
  assert.equal(side.hp, 48);
});

// ---- bots -------------------------------------------------------------------------------------

import { ensureAI } from '../server/sim/bots.js';

function botGame() {
  return makeGame({ features: { botAI: true } });
}

test('roughly the configured share of zombie bots go for each garage tool', () => {
  const game = botGame();
  game.addPlayer('p', { team: 'plant', mode: 'coop' });
  const counts = {};
  const total = 2000;
  for (let i = 0; i < total; i++) {
    const b = game.spawnBot('zombie', 0, -40);
    ensureAI(game, b);
    const k = b.ai.seeksMower ? 'mower' : b.ai.seeksItem ?? 'none';
    counts[k] = (counts[k] ?? 0) + 1;
    game.removeEntity(b);
  }
  assert.ok(counts.weed_eater / total > 0.07 && counts.weed_eater / total < 0.17, JSON.stringify(counts));
  for (const item of Object.keys(DEFAULT_CONFIG.botItemChance)) assert.ok(counts[item] > 0, `${item} sometimes`);
  assert.ok(counts.mower / total > 0.2 && counts.mower / total < 0.3);
});

test('a bot that wants the weed eater walks to the rack, takes it, and shreds the garden', () => {
  const game = botGame();
  game.addPlayer('p', { team: 'plant', mode: 'coop' }).x = -25;
  for (const s of gardenSlots().keys()) if (s % 9 === 4 && s < 9) plantAt(game, s);
  const plant = [...game.entities.values()].find((e) => e.kind === 'garden');
  plant.hp = plant.maxHp = 60;
  const bot = game.spawnBot('zombie', 22, 26);
  bot.hp = bot.maxHp = 1e6;
  ensureAI(game, bot);
  bot.ai.seeksMower = false;
  bot.ai.seeksItem = 'weed_eater';
  let took = false;
  for (let i = 0; i < 30 * 90 && plant.state === 'alive'; i++) {
    game.tick(1 / 30);
    if (bot.item === 'weed_eater') took = true;
  }
  assert.ok(took, 'took the weed eater');
  assert.equal(plant.state, 'dead', 'and mowed down the plant');
  assert.ok(game.events.some((e) => e.type === 'item_take' && e.id === bot.id));
});

test('a bot gives up on a tool somebody else already holds', () => {
  const game = botGame();
  game.addPlayer('p', { team: 'plant', mode: 'coop' });
  const z = game.addPlayer('z', { team: 'zombie' });
  grab(game, z, 'weed_eater');
  const bot = game.spawnBot('zombie', 0, -30);
  ensureAI(game, bot);
  bot.ai.seeksMower = false;
  bot.ai.seeksItem = 'weed_eater';
  run(game, 1);
  assert.equal(bot.ai.seeksItem, null);
});

test('armed bots with each tool go after something and use it', () => {
  for (const item of ['hedge_trimmer', 'leaf_blower', 'wheelbarrow']) {
    const game = botGame();
    const p = game.addPlayer('p', { team: 'plant', mode: 'coop' });
    p.x = 20;
    p.z = 20;
    p.hp = p.maxHp = 1e6;
    plantAt(game, PEA_SLOT); // something for the wheelbarrow to roll toward
    const bot = game.spawnBot('zombie', RACK[item].x, RACK[item].z - 1);
    bot.hp = bot.maxHp = 1e6;
    ensureAI(game, bot);
    bot.ai.seeksMower = false;
    bot.ai.seeksItem = item;
    let used = false;
    for (let i = 0; i < 30 * 100; i++) {
      game.tick(1 / 30);
      if (bot.using) used = true;
      if (item === 'wheelbarrow' && Math.hypot(bot.x, bot.z) < 8) used = true; // rolled up to the turret
    }
    assert.ok(used, `${item} bot engaged`);
    if (item !== 'wheelbarrow') assert.equal(bot.item, item, `${item} kept`);
  }
});
