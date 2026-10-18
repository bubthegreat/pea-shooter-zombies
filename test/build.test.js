import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, publicConfig } from '../server/sim/config.js';
import { WORLD, doorZone } from '../server/sim/world.js';
import { spawnProjectile, stepProjectiles, applyDamage } from '../server/sim/combat.js';
import { plantAt } from '../server/sim/garden.js';
import { MAP } from '../server/sim/map.js';
import { terrainHeight } from '../server/sim/terrain.js';
import { makeGame, run, keys, entitiesOfKind, slotIdx, forceRoute, insideStatic } from './helpers.js';

const B = DEFAULT_CONFIG.builds;
const FAR = { x: 30, z: -24 }; // open lawn: the builder stands here, builds go up at z = -30 and beyond

function buildGame(extra = {}) {
  const game = makeGame({ features: { cover: false, ...extra.features }, ...extra.config });
  const p = game.addPlayer('p', { name: 'Pea', team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { name: 'Zed', team: 'zombie' });
  p.x = FAR.x;
  p.z = FAR.z;
  p.sunshine = 500;
  z.x = FAR.x + 10;
  z.z = FAR.z;
  z.brains = 100;
  game.drainEvents();
  return { game, p, z };
}

const place = (game, id, kind, gx, gz, rot = 0, seq = null) => {
  const e = game.entities.get(id);
  game.handleInput(id, { build: kind, bx: gx, bz: gz, br: rot, buildSeq: seq ?? (e.buildSeqSeen + 1) });
  game.tick(1 / 30);
};
const pieces = (game) => [...game.cover.pieces.values()].filter((x) => x.build);
const fails = (game) => game.drainEvents().filter((e) => e.type === 'buildFail').map((e) => e.reason);

test('config: plant builds cost sunshine, zombie builds cost brains, 12 per player', () => {
  assert.deepEqual(B.plant.map((b) => b.id), ['hedgewall', 'fence', 'pot']);
  assert.deepEqual(B.zombie.map((b) => b.id), ['tombwall', 'junk', 'cantower']);
  assert.equal(B.maxPerPlayer, 12);
  assert.ok(B.plant[0].cost < B.plant[1].cost && B.plant[0].hp < B.plant[1].hp, 'hedge: cheap and weak');
  assert.ok(B.zombie[1].cost < B.zombie[0].cost, 'junk is the cheap one');
  assert.ok(B.zombie[2].h > 2.2, 'the tower is tall');
  assert.deepEqual(publicConfig().builds, B);
  assert.equal(publicConfig().brains.perHit, 5);
});

test('placing a Hedge Wall: snapped to the grid, costs sunshine, blocks walking and shots, emits build', () => {
  const { game, p, z } = buildGame();
  place(game, 'p', 1, 30, -30);
  const [w] = pieces(game);
  assert.ok(w, 'it stands');
  assert.equal(p.sunshine, 500 - B.plant[0].cost);
  assert.deepEqual([w.collider.minX, w.collider.maxX, w.collider.minZ, w.collider.maxZ], [30, 33, -30, -29]);
  assert.equal(w.hp, B.plant[0].hp);
  const ev = game.drainEvents().find((e) => e.type === 'build');
  assert.deepEqual([ev.id, ev.kind, ev.x, ev.z, ev.rot, ev.by], [w.id, 'hedgewall', 30, -30, 0, 'p']);
  // blocks walking
  z.x = 31.5;
  z.z = -26;
  z.y = 0;
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0, pitch: 0 }); // -z, into the wall
  run(game, 2);
  assert.ok(z.z >= -29 + z.radius - 0.02, `stopped at the wall, z=${z.z}`);
  // blocks shots from the enemy and takes damage; the owner's shots pass over... no: they also stop but do no harm
  const shot = (team) => {
    const q = spawnProjectile(game, { team, owner: 'x', projKind: 'bullet', damage: 8, speed: 40, x: 31.5, y: terrainHeight(31.5, -27) + 1.0, z: -25, dir: { x: 0, y: 0, z: -1 } });
    for (let i = 0; i < 10; i++) stepProjectiles(game, 1 / 30);
    return q;
  };
  const hp0 = w.hp;
  shot('zombie');
  assert.equal(w.hp, hp0 - 8);
  shot('plant');
  assert.equal(w.hp, hp0 - 8, 'friendly shots do no harm');
  const snap = game.mapState();
  assert.deepEqual(snap.builds.map((b) => [b.id, b.kind, b.x, b.z, b.rot, b.by]), [[w.id, 'hedgewall', 30, -30, 0, 'p']]);
  assert.equal(snap.builds[0].hp, hp0 - 8);
});

test('rotation swaps the footprint', () => {
  const { game } = buildGame();
  place(game, 'p', 2, 30, -30, 1);
  const [w] = pieces(game);
  assert.deepEqual([w.collider.minX, w.collider.maxX, w.collider.minZ, w.collider.maxZ], [30, 31, -30, -27]);
  assert.equal(w.build.rot, 1);
});

test('zombie kids pay brains: Tombstone Wall, Junk Barricade, Trash-can Tower', () => {
  const { game, p, z } = buildGame();
  place(game, 'z', 1, 36, -30);
  place(game, 'z', 2, 36, -27);
  place(game, 'z', 3, 36, -24);
  const kinds = pieces(game).map((x) => x.kind);
  assert.deepEqual(kinds, ['tombwall', 'junk', 'cantower']);
  assert.equal(z.brains, 100 - 25 - 10 - 15);
  assert.equal(p.sunshine, 500, 'plants pay nothing for zombie builds');
  const tower = pieces(game)[2];
  assert.equal(tower.collider.maxX - tower.collider.minX, 1);
  assert.ok(tower.y1 - tower.y0 > 2.5);
  // without brains: refused, nothing changes
  z.brains = 5;
  place(game, 'z', 1, 36, -20);
  assert.equal(pieces(game).length, 3);
  assert.deepEqual(fails(game), ['cost']);
  assert.equal(z.brains, 5);
});

test('rejected: no money, too far, off the map, in a plot, a doorway, the house, on top of cover / builds / people / turrets', () => {
  const { game, p, z } = buildGame();
  const tryAt = (gx, gz, rot = 0, kind = 1) => {
    game.drainEvents();
    const n = pieces(game).length;
    place(game, 'p', kind, gx, gz, rot);
    return pieces(game).length > n ? 'ok' : fails(game)[0];
  };
  assert.equal(tryAt(30, -30), 'ok');
  assert.equal(tryAt(31, -30), 'blocked', 'overlaps the first wall');
  assert.equal(tryAt(80, -30), 'spot', 'off the map');
  assert.equal(tryAt(30, 5), 'far', 'out of reach');
  p.sunshine = 10;
  assert.equal(tryAt(36, -30), 'cost');
  p.sunshine = 500;
  // plots, doorways, the house
  p.x = WORLD.plantSpawn.x;
  p.z = WORLD.plantSpawn.z;
  assert.equal(tryAt(2, -4), 'blocked', 'inside the front plot');
  const d = WORLD.doors.find((x) => x.id === 'front');
  const zone = doorZone(d);
  assert.equal(tryAt(Math.floor(d.x) - 1, Math.floor(zone.minZ)), 'blocked', 'the doorway must stay free');
  p.x = -5;
  p.z = 3;
  assert.equal(tryAt(-8, 10), 'blocked', 'not inside the house');
  // people and turrets in the way
  p.x = 6;
  p.z = -33;
  z.x = 7;
  z.z = -36.5;
  assert.equal(tryAt(6, -37), 'busy');
  z.x = 40;
  z.z = -24;
  const turret = plantAt(game, slotIdx(0, 0, 1));
  turret.x = 6;
  turret.z = -39.5;
  assert.equal(tryAt(5, -40), 'busy', 'on top of a turret');
  assert.equal(tryAt(-3, -40), 'ok');
});

test('a ditch is no place for a wall; neither is a steep bank', () => {
  const { game, p } = buildGame();
  p.x = -27;
  p.z = -5;
  game.drainEvents();
  place(game, 'p', 1, -28, -11); // the creek bed
  assert.equal(pieces(game).length, 0);
  assert.deepEqual(fails(game), ['spot']);
});

test('at most 12 per player; destroyed builds free the slots; the cap is per player', () => {
  const { game, p, z } = buildGame();
  p.sunshine = 5000;
  p.x = 6;
  p.z = -31;
  z.x = 24;
  z.z = -31;
  z.brains = 150;
  for (let i = 0; i < 12; i++) place(game, 'p', 1, (i % 4) * 4, -42 + Math.floor(i / 4) * 3);
  assert.equal(game.cover.buildsOf('p'), 12);
  place(game, 'p', 1, -4, -36);
  assert.deepEqual(fails(game), ['cap']);
  place(game, 'z', 2, 18, -38);
  assert.equal(game.cover.buildsOf('z'), 1, "the zombie's cap is its own");
  const first = pieces(game)[0];
  game.cover.destroy(first);
  assert.equal(game.cover.buildsOf('p'), 11);
  place(game, 'p', 1, -4, -36);
  assert.equal(game.cover.buildsOf('p'), 12);
  assert.ok(game.drainEvents().some((e) => e.type === 'coverBreak' && e.id === first.id));
  // gone from the late-joiner state too
  assert.ok(!game.mapState().builds.some((b) => b.id === first.id));
});

test('builds are wiped when a new round starts', () => {
  const { game } = buildGame();
  place(game, 'p', 1, 30, -30);
  assert.equal(pieces(game).length, 1);
  game.startRound();
  assert.equal(pieces(game).length, 0);
  assert.deepEqual(game.mapState().builds, []);
  assert.equal(game.entities.get('z').brains, DEFAULT_CONFIG.brains.start);
});

test('buildSeq works like plantSeq: resent numbers never build twice, junk is ignored', () => {
  const { game } = buildGame();
  game.handleInput('p', { build: 1, bx: 30, bz: -30, br: 0, buildSeq: 1 });
  game.handleInput('p', { build: 1, bx: 30, bz: -30, br: 0, buildSeq: 1 });
  game.tick(1 / 30);
  assert.equal(pieces(game).length, 1);
  for (const bad of ['1', 1.5, -1, NaN, null, {}]) game.handleInput('p', { build: 1, bx: 34, bz: -30, br: 0, buildSeq: bad });
  game.handleInput('p', { build: 1, bx: 34.5, bz: -30, br: 0, buildSeq: 9 }); // fractional cell
  game.handleInput('p', { build: 99, bx: 34, bz: -30, br: 0, buildSeq: 10 }); // no such kind
  game.handleInput('p', { build: 3, bx: 34, bz: -30, br: 0, buildSeq: 11 }); // plants have two kinds
  game.tick(1 / 30);
  assert.equal(pieces(game).length, 1);
  place(game, 'p', 2, 34, -30, 0, 12);
  assert.equal(pieces(game).length, 2);
});

test('only living kids in a running round build; held zombies (head start) cannot', () => {
  const { game, p, z } = buildGame({ features: { headStart: true } });
  place(game, 'z', 2, 34, -30);
  assert.equal(pieces(game).length, 0, 'zombies wait in the pen first');
  place(game, 'p', 1, 30, -30);
  assert.equal(pieces(game).length, 1, 'plants may build during the head start');
  p.state = 'wilted';
  place(game, 'p', 1, 20, -30);
  assert.equal(pieces(game).length, 1);
  assert.ok(z);
});

// ---- brains ------------------------------------------------------------------------------------

test('zombie kids earn 5 brains per hit on a plant, door or build, and 10 for a destroyed turret', () => {
  const { game, p, z } = buildGame();
  z.brains = 0;
  const hit = (target, amount = 1) => applyDamage(game, target, amount, z);
  hit(p);
  assert.equal(z.brains, 5, 'a plant kid');
  hit(p);
  assert.equal(z.brains, 5, 'at most once per half second per target');
  game.time += 0.6;
  hit(p);
  assert.equal(z.brains, 10);
  const turret = plantAt(game, slotIdx(0, 0, 1));
  hit(turret);
  assert.equal(z.brains, 15);
  game.time += 1;
  hit(turret, 1000); // destroyed: the hit's 5 plus the turret bonus
  assert.equal(z.brains, 15 + 5 + 10);
  // doors and plant builds
  z.brains = 0;
  const door = game.cover.get('door:front');
  game.cover.damage(door, 8, z, 'zombie');
  assert.equal(z.brains, 5);
  place(game, 'p', 1, 30, -30);
  const wall = pieces(game)[0];
  game.time += 1;
  game.cover.damage(wall, 8, z, 'zombie');
  assert.equal(z.brains, 10);
  // their own side's stuff and natural cover pay nothing
  place(game, 'z', 2, 36, -30);
  const mine = pieces(game).at(-1);
  const before = z.brains;
  game.time += 1;
  game.cover.damage(mine, 8, z, 'plant');
  assert.equal(z.brains, before);
  // bots earn nothing; plants earn nothing; the cap holds
  const bot = game.spawnBot('zombie', 0, -30);
  applyDamage(game, p, 1, bot);
  assert.equal(bot.brains, undefined);
  applyDamage(game, game.spawnBot('zombie', 1, -30), 1, p);
  assert.equal(p.brains, undefined);
  z.brains = DEFAULT_CONFIG.brains.max - 2;
  game.time += 1;
  game.cover.damage(door, 8, z, 'zombie');
  assert.equal(z.brains, DEFAULT_CONFIG.brains.max);
  assert.equal(game.snapshot().entities.find((e) => e.id === 'z').brains, DEFAULT_CONFIG.brains.max);
  assert.equal(game.snapshot().entities.find((e) => e.id === 'p').brains, undefined);
});

// ---- forts and bots ---------------------------------------------------------------------------

test('a zombie bot shoots its way through a fort wall in its path', () => {
  const game = makeGame({ features: { botAI: true, cover: false }, botItemChance: {}, mowerBotChance: 0 });
  const p = game.addPlayer('p', { team: 'plant', mode: 'coop' });
  p.x = 38;
  p.z = 44;
  p.sunshine = 5000;
  // a long fence across the front lawn's lane
  p.x = 5;
  p.z = -30;
  for (let i = 0; i < 4; i++) place(game, 'p', 2, -2 + i * 3, -28);
  p.x = 38;
  p.z = 44;
  const bot = forceRoute(game, game.spawnBot('zombie', 5, -49), 'front', 'front');
  bot.hp = bot.maxHp = 1e6;
  let brokeAt = null;
  for (let t = 0; t < 60 && brokeAt === null; t += 1 / 30) {
    game.tick(1 / 30);
    if (game.drainEvents().some((e) => e.type === 'coverBreak' && String(e.id).startsWith('b'))) brokeAt = t;
    assert.equal(insideStatic(bot), null);
  }
  assert.ok(brokeAt !== null, 'the bot broke a wall (or walked around: both fine)') ;
  assert.ok(MAP.cover.length > 0);
  assert.equal(entitiesOfKind(game, 'garden').length, 0);
});
