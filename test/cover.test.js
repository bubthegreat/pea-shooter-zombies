import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD, PLOTS } from '../server/sim/world.js';
import { MAP } from '../server/sim/map.js';
import { spawnProjectile, stepProjectiles } from '../server/sim/combat.js';
import { makeGame, run, keys, forceRoute, breakDoors, insideStatic } from './helpers.js';

const coverGame = (extra = {}) => {
  const game = makeGame({ features: { cover: true, ...extra.features }, ...extra.config });
  const p = game.addPlayer('p', { team: 'plant', mode: 'versus' });
  p.x = 38;
  p.z = 44;
  const z = game.addPlayer('z', { team: 'zombie' });
  z.x = -38;
  z.z = -30;
  return { game, p, z };
};
const ofKind = (kind) => MAP.cover.filter((c) => c.kind === kind);
const centre = (c) => (c.s === 'box' ? { x: (c.minX + c.maxX) / 2, z: (c.minZ + c.maxZ) / 2 } : { x: c.x, z: c.z });
const gap = (c, x, z) => (c.s === 'box' ? Math.hypot(Math.max(c.minX - x, 0, x - c.maxX), Math.max(c.minZ - z, 0, z - c.maxZ)) : Math.max(0, Math.hypot(x - c.x, z - c.z) - c.r));
/** Take every other piece within 6 m out of the way, so a test can shoot or walk at one piece. */
function isolate(game, piece) {
  const m = centre(piece);
  for (const o of MAP.cover) if (o !== piece && gap(o, m.x, m.z) < 6) game.cover.destroy(game.cover.get(o.id));
  game.drainEvents();
}

test('the layout: lots of gravestones, rocks, trees, hedges, cans, a picnic table, a kiddie pool and a shed', () => {
  const count = (k) => ofKind(k).length;
  assert.ok(count('gravestone') >= 40, `gravestones ${count('gravestone')}`);
  assert.ok(count('rock') >= 10 && count('tree') >= 15 && count('hedge') >= 12, `${count('rock')} rocks ${count('tree')} trees ${count('hedge')} hedges`);
  assert.ok(count('trashcan') >= 6, `cans ${count('trashcan')}`);
  assert.equal(count('picnic'), 1);
  assert.equal(count('pool'), 1);
  assert.ok(count('shedwall') >= 4);
  assert.equal(new Set(MAP.cover.map((c) => c.id)).size, MAP.cover.length, 'unique ids');
  for (const k of Object.keys(DEFAULT_CONFIG.cover)) assert.ok(count(k) > 0, `${k} exists`);
  assert.ok(DEFAULT_CONFIG.cover.rock.hp >= 5 * DEFAULT_CONFIG.cover.gravestone.hp / 2, 'rocks are tough');
  assert.ok(MAP.cover.length < 160, `cover count stays small (${MAP.cover.length})`);
});

test('gravestones live on the zombie side', () => {
  const graves = ofKind('gravestone');
  assert.ok(graves.filter((g) => g.z < 0).length / graves.length > 0.9);
});

test('cover never sits in doorways, plots, the house, the pen or on the waypoint paths', () => {
  const nodes = Object.values(MAP.nodes);
  for (const c of MAP.cover) {
    const m = centre(c);
    const r = c.s === 'cyl' ? c.r : 0;
    if (c.kind !== 'shedwall') {
      for (const rect of MAP.noBuild) assert.ok(!(m.x > rect.minX - r && m.x < rect.maxX + r && m.z > rect.minZ - r && m.z < rect.maxZ + r) || c.kind === 'trashcan' || c.kind === 'picnic' || c.kind === 'pool', `${c.id} ${c.kind} at ${m.x},${m.z} is in a no-build zone`);
      for (const n of nodes) assert.ok(gap(c, n[0], n[1]) > 1.2, `${c.id} ${c.kind} sits on a waypoint`);
    }
    for (const p of PLOTS) for (const s of p.slots) assert.ok(Math.hypot(m.x - s.x, m.z - s.z) > 1.5 + r, `${c.id} is in a garden slot`);
    assert.ok(m.x > WORLD.bounds.minX && m.x < WORLD.bounds.maxX && m.z > WORLD.bounds.minZ && m.z < WORLD.bounds.maxZ);
  }
});

test('feature off: no cover (doors only)', () => {
  const { game } = coverGame({ features: { cover: false } });
  assert.equal([...game.cover.pieces.keys()].filter((k) => !k.startsWith('door:')).length, 0);
  const { game: g2 } = coverGame();
  assert.equal(g2.cover.pieces.size, MAP.cover.length + 4);
});

test('cover blocks walking (a metre-high stone can be hopped, a tree cannot)', () => {
  const { game, z } = coverGame();
  const tree = ofKind('tree')[0];
  isolate(game, tree);
  z.x = tree.x + 4;
  z.z = tree.z;
  z.y = 0;
  game.handleInput('z', { keys: keys({ f: true }), yaw: -Math.PI / 2 * -1, pitch: 0 }); // yaw PI/2: forward is -x, toward the tree
  run(game, 2);
  assert.ok(z.x >= tree.x + tree.r + z.radius - 0.05, `stopped by the trunk at x=${z.x}`);
  const stone = ofKind('gravestone')[0];
  isolate(game, stone);
  z.x = stone.x + 2.4;
  z.z = stone.z;
  z.y = game.field.groundAt(z.x, z.z, 5);
  game.handleInput('z', { keys: keys({ f: true, jump: true }), yaw: Math.PI / 2, pitch: 0 });
  run(game, 1 / 30);
  game.handleInput('z', { keys: keys({ f: true }), yaw: Math.PI / 2, pitch: 0 });
  run(game, 0.6);
  assert.ok(z.x < stone.x - 0.3, `hopped over the stone: x=${z.x} stone at ${stone.x}`);
});

test('cover blocks shots, takes damage from either team, and breaks into debris that stays gone', () => {
  const { game } = coverGame();
  const stone = ofKind('gravestone')[3];
  isolate(game, stone);
  const piece = game.cover.get(stone.id);
  assert.equal(piece.hp, DEFAULT_CONFIG.cover.gravestone.hp);
  const shoot = (team, damage) => {
    const q = spawnProjectile(game, { team, owner: 'x', projKind: team === 'plant' ? 'pea' : 'bullet', damage, speed: 40, x: stone.x + 2.5, y: stone.y1 - 0.5, z: stone.z, dir: { x: -1, y: 0, z: 0 } });
    for (let i = 0; i < 12; i++) stepProjectiles(game, 1 / 30);
    return q;
  };
  const pea = shoot('plant', 1);
  assert.equal(game.entities.has(pea.id), false, 'the pea stopped');
  assert.equal(piece.hp, DEFAULT_CONFIG.cover.gravestone.hp - 1);
  shoot('zombie', 8);
  assert.equal(piece.hp, DEFAULT_CONFIG.cover.gravestone.hp - 9);
  game.drainEvents();
  for (let i = 0; i < 7; i++) shoot('zombie', 8);
  assert.equal(piece.state, 'broken');
  const ev = game.drainEvents();
  assert.ok(ev.some((e) => e.type === 'coverBreak' && e.id === stone.id && e.kind === 'gravestone'));
  assert.ok(ev.some((e) => e.type === 'coverHit' && e.id === stone.id));
  assert.ok(game.mapState().gone.includes(stone.id));
  // gone: shots fly on and people walk through
  const after = shoot('plant', 1);
  assert.ok(after.x < stone.x, 'the pea passes where the stone was');
  game.startRound();
  assert.equal(game.cover.get(stone.id).state, 'alive', 'back next round');
  assert.ok(!game.mapState().gone.includes(stone.id));
});

test('rocks and trees are far tougher than gravestones; hedges and cans are soft', () => {
  const hp = DEFAULT_CONFIG.cover;
  assert.ok(hp.rock.hp > hp.tree.hp && hp.tree.hp > hp.gravestone.hp && hp.gravestone.hp > hp.trashcan.hp);
  assert.ok(hp.hedge.hp <= hp.gravestone.hp + 20);
});

test('splash (brain cannon, melons) and melee tools chew cover', () => {
  const { game, z } = coverGame();
  const stone = ofKind('gravestone')[5];
  isolate(game, stone);
  game.cover.splash(stone.x, 1, stone.z, 3.5, 40, null, 'zombie');
  assert.ok(game.cover.get(stone.id).hp < DEFAULT_CONFIG.cover.gravestone.hp);
  // a weed eater in a zombie kid's hands
  const hedge = ofKind('hedge')[0];
  const c = centre(hedge);
  z.x = c.x - 6;
  z.z = (hedge.minZ + hedge.maxZ) / 2;
  game.racks.get('weed_eater').available = false;
  z.item = 'weed_eater';
  game.racks.get('weed_eater').heldBy = 'z';
  z.x = hedge.minX - 1.5;
  z.yaw = -Math.PI / 2; // +x
  game.handleInput('z', { fire: true, yaw: -Math.PI / 2, pitch: 0 });
  run(game, 4);
  assert.equal(game.cover.get(hedge.id).state, 'broken', 'the weed eater shredded the hedge');
});

test('whole rounds with cover: every route still reaches the fridge (doors already broken)', () => {
  for (const [route, door] of [['front', 'front'], ['front', 'side'], ['left', 'back'], ['left', 'side'], ['right', 'garage']]) {
    for (const sx of [-14, -4, 6, 14]) {
      const game = makeGame({ features: { cover: true, botAI: true }, botItemChance: {}, mowerBotChance: 0 });
      const a = game.addPlayer('a', { team: 'plant', mode: 'coop' });
      a.x = 38;
      a.z = 44;
      breakDoors(game);
      const bot = forceRoute(game, game.spawnBot('zombie', sx, WORLD.gate.z), route, door);
      bot.hp = bot.maxHp = 1e6;
      const F = WORLD.fridge.stand;
      let t = 0;
      while (Math.hypot(bot.x - F.x, bot.z - F.z) > 1.3 && t < 170) {
        game.tick(1 / 30);
        t += 1 / 30;
      }
      assert.ok(Math.hypot(bot.x - F.x, bot.z - F.z) <= 1.3, `${route}/${door} from x=${sx}: stuck at ${bot.x.toFixed(1)}, ${bot.z.toFixed(1)} after ${t.toFixed(0)} s`);
      assert.equal(insideStatic(bot), null);
    }
  }
});
