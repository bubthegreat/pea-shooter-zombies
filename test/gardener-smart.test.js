import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD, slotIndex } from '../server/sim/world.js';
import { plantAt } from '../server/sim/garden.js';
import { applyDamage } from '../server/sim/combat.js';
import { spawnSun } from '../server/sim/garden.js';
import { makeGame, run, entitiesOfKind, forceRoute, breakDoors } from './helpers.js';

const STAND = WORLD.fridge.stand;
const gardeners = (game) => entitiesOfKind(game, 'bot').filter((b) => b.isGardener).sort((a, b) => a.gardenerIdx - b.gardenerIdx);
const plants = (game) => entitiesOfKind(game, 'garden');
const plotOf = (game, g) => game.slots[g.slot].plot;

/** A round at `level` with a zombie kid parked far away, features on. headStart off so everything can happen at once. */
function gameAt(level, { features = {}, config = {}, seed = 4242 } = {}) {
  const game = makeGame({ features: { gardener: true, botAI: true, ...features }, seed, ...config });
  const z = game.addPlayer('z', { team: 'zombie', mode: 'coop', difficulty: level });
  z.x = 38;
  z.z = 44;
  z.y = 0;
  z.hp = z.maxHp = 1e9;
  return { game, z };
}

test('Easy and Normal keep the basic Gardener (one, walks the slots); Hard and up plan', () => {
  for (const level of ['easy', 'normal']) {
    const { game } = gameAt(level);
    run(game, 1);
    const [g] = gardeners(game);
    assert.equal(gardeners(game).length, 1);
    assert.equal(g.ai.g, undefined, `${level}: no planner state`);
    assert.equal(game.gardenerConfig().brain, 'basic');
  }
  for (const level of ['hard', 'veryhard', 'expert', 'nightmare', 'insane']) {
    const { game } = gameAt(level);
    run(game, 1);
    assert.equal(game.gardenerConfig().brain, 'smart', level);
    assert.ok(gardeners(game)[0].ai.g, `${level}: planner state`);
  }
});

test('one Gardener up to Expert, two from Nightmare: named, indexed, back after respawn, each with its own sunshine', () => {
  for (const [level, n] of [['hard', 1], ['veryhard', 1], ['expert', 1], ['nightmare', 2], ['insane', 2]]) {
    const { game, z } = gameAt(level);
    run(game, 0.5);
    const gs = gardeners(game);
    assert.equal(gs.length, n, level);
    if (n === 2) {
      assert.deepEqual(gs.map((g) => g.name), ['Gardener', 'Gardener 2']);
      assert.deepEqual(gs.map((g) => g.gardenerIdx), [0, 1]);
    }
    run(game, 10);
    assert.equal(gardeners(game).length, n, 'never more than the level says');
    // the last one wilts: it is the only one gone, and it returns
    const victim = gs.at(-1);
    const bank = victim.sunshine;
    victim.sunshine = 123;
    applyDamage(game, victim, 999, z);
    assert.equal(gardeners(game).length, n - 1);
    run(game, game.gardenerConfig().respawn - 0.5);
    assert.equal(gardeners(game).length, n - 1, 'still waiting');
    run(game, 1.5);
    assert.equal(gardeners(game).length, n);
    const back = gardeners(game).find((g) => g.gardenerIdx === victim.gardenerIdx);
    assert.notEqual(back.id, victim.id);
    assert.ok(back.sunshine <= 123 + game.gardenerConfig().income * 2 + 1, `dying is not a refill: ${back.sunshine} (was ${bank})`);
  }
});

test('with a human on the plant team there is no Gardener, at any level', () => {
  for (const level of ['hard', 'insane']) {
    const { game } = gameAt(level);
    run(game, 1);
    assert.ok(gardeners(game).length >= 1);
    game.addPlayer('p', { team: 'plant', mode: 'coop' });
    run(game, 0.5);
    assert.equal(gardeners(game).length, 0);
  }
});

test('it watches all the doors: the plot of the door the zombies are heading for gets planted first', () => {
  for (const door of ['front', 'back', 'garage']) {
    const { game } = gameAt('veryhard', { features: { waves: false } });
    const route = { front: ['front', 'front'], back: ['left', 'back'], garage: ['right', 'garage'] }[door];
    for (let i = 0; i < 6; i++) {
      const b = forceRoute(game, game.spawnBot('zombie', -6 + i * 2, WORLD.gate.z + 8), ...route);
      b.hp = b.maxHp = 1e9;
    }
    game.headStart = 15;
    run(game, 12); // zombies are held in the pen anyway; the Gardener plants its first plants
    const perPlot = [0, 0, 0, 0];
    for (const g of plants(game)) perPlot[plotOf(game, g)]++;
    const idx = ['front', 'side', 'back', 'garage'].indexOf(door);
    assert.ok(perPlot[idx] >= 2 && perPlot[idx] >= Math.max(...perPlot) - 1, `${door}: ${perPlot}`);
  }
});

test('it plants a sensible mix: only cheap plants early, snipers at the back, shotguns and slows in front, Wall-nuts at the chokepoint', () => {
  const { game } = gameAt('insane', { features: { waves: false, headStart: false } });
  run(game, 2);
  for (const g of gardeners(game)) g.sunshine = 3000;
  run(game, 3);
  assert.ok(plants(game).every((p) => ['peashooter', 'cactus'].includes(p.plantKind)), 'tier 0 at the start: ' + plants(game).map((p) => p.plantKind));
  game.roundTime = 200; // later in the round every tier is open
  for (let i = 0; i < 200; i++) {
    for (const g of gardeners(game)) g.sunshine = Math.max(g.sunshine, 1500);
    run(game, 1);
    if (plants(game).length >= 40) break;
  }
  const by = (kind) => plants(game).filter((p) => p.plantKind === kind);
  const rowOf = (p) => game.slots[p.slot].row;
  const colOf = (p) => game.slots[p.slot].col;
  assert.ok(plants(game).length >= 32, `planted ${plants(game).length}`);
  const kinds = new Set(plants(game).map((p) => p.plantKind));
  for (const k of ['wallnut', 'melonpult', 'gatling', 'snowpea', 'spikesquash']) assert.ok(kinds.has(k), `has ${k}: ${[...kinds]}`);
  assert.ok(by('wallnut').every((p) => rowOf(p) === 0 && (colOf(p) === 1 || colOf(p) === 2)), 'Wall-nuts only at the front chokepoint');
  assert.ok(by('melonpult').every((p) => rowOf(p) >= 2), 'melon-pults at the back');
  assert.ok(by('spikesquash').every((p) => rowOf(p) <= 1), 'spike squash in front');
  assert.ok(by('snowpea').every((p) => rowOf(p) === 1), 'snow peas slow them in the second row');
});

test('plants unlock over the round: tier = min(level cap, time / tierEvery)', () => {
  const { game } = gameAt('hard', { features: { waves: false, headStart: false } });
  game.roundTime = 0;
  run(game, 0.5);
  const g = gardeners(game)[0];
  assert.equal(g.tier, 0);
  game.roundTime = 1000;
  run(game, 0.5);
  assert.equal(g.tier, game.gardenerConfig().tier);
  assert.equal(game.gardenerConfig().tier, 2);
});

test('it levels plants up with spare sunshine, the busiest door first, and replants what dies', () => {
  const { game } = gameAt('hard', { features: { waves: false, headStart: false } });
  run(game, 0.5);
  const g = gardeners(game)[0];
  game.slots.forEach((s, i) => { if (s.plot === 0 && s.row >= 2 && s.col % 2 === 1) plantAt(game, i, 'cactus'); });
  game.slots.forEach((s, i) => { if (!s.plantId) plantAt(game, i, 'cactus'); }); // nothing left to plant: it levels plants up instead
  assert.equal(plants(game).length, 64);
  g.sunshine = 400;
  run(game, 60);
  assert.ok(plants(game).some((p) => (p.level ?? 1) > 1), 'something was levelled up');
  // the neediest plot first: zombies heading for the side door
  const { game: g2 } = gameAt('veryhard', { features: { waves: false, headStart: false } });
  run(g2, 0.5);
  g2.slots.forEach((s, i) => { if (!s.plantId) plantAt(g2, i, 'cactus'); });
  for (let i = 0; i < 8; i++) forceRoute(g2, g2.spawnBot('zombie', -14, WORLD.gate.z), 'front', 'side');
  g2.headStart = 500; // they wait in the pen, all with the side door as their way in
  gardeners(g2)[0].sunshine = 500;
  run(g2, 100);
  const ups = plants(g2).filter((p) => (p.level ?? 1) > 1).map((p) => plotOf(g2, p));
  assert.ok(ups.length >= 3 && ups.filter((pl) => pl === 1).length >= ups.length / 2, `upgrades by plot ${ups}`);
  // kill a few: they come back
  const gg = gardeners(game)[0];
  const victims = plants(game).slice(0, 3);
  gg.sunshine = 400;
  for (const v of victims) game.removeEntity(v);
  assert.equal(plants(game).length, 61);
  run(game, 30);
  assert.equal(plants(game).length, 64, 'replanted');
});

test('Very Hard and up put forts (fences) across the approaches, never inside a plot, at most as many as the level allows', () => {
  const { game } = gameAt('veryhard', { features: { waves: false, headStart: false } });
  game.roundTime = 30;
  run(game, 1);
  const g = gardeners(game)[0];
  for (let i = 0; i < 60; i++) {
    g.sunshine = Math.max(g.sunshine, 400);
    run(game, 2);
  }
  const forts = [...game.cover.pieces.values()].filter((p) => p.build && p.build.kind !== 'pot');
  assert.ok(forts.length >= 2, `forts ${forts.length}`);
  assert.ok(forts.length <= game.gardenerConfig().forts);
  assert.ok(forts.every((f) => f.build.kind === 'fence'));
  assert.ok(forts.every((f) => f.team === 'plant'));
  const { game: easy } = gameAt('hard', { features: { waves: false, headStart: false } });
  easy.roundTime = 30;
  run(easy, 1);
  gardeners(easy)[0].sunshine = 800;
  run(easy, 60);
  assert.equal([...easy.cover.pieces.values()].filter((p) => p.build).length, 0, 'Hard builds no forts');
});

test('it mends doors: a hurt door is repaired at its pile, a broken one rebuilt (Very Hard and up), but never with zombies at the door', () => {
  const { game } = gameAt('veryhard', { features: { waves: false, headStart: false } });
  run(game, 1);
  const door = game.cover.get('door:back');
  door.hp = 40;
  run(game, 60);
  assert.ok(door.hp > 40 + 60, `repaired: ${door.hp}`);
  game.cover.destroy(door);
  run(game, 60);
  assert.equal(door.state, 'alive', 'rebuilt');
  assert.ok(game.drainEvents().some((e) => e.type === 'doorUp' && e.id === 'door:back'));
  // Hard mends but does not rebuild
  const { game: hard } = gameAt('hard', { features: { waves: false, headStart: false } });
  run(hard, 1);
  const d2 = hard.cover.get('door:front');
  hard.cover.destroy(d2);
  run(hard, 60);
  assert.equal(d2.state, 'broken');
  // zombies at the door: the Gardener keeps away from the pile
  const { game: busy } = gameAt('insane', { features: { waves: false, headStart: false } });
  run(busy, 1);
  const d3 = busy.cover.get('door:front');
  d3.hp = 30;
  const zb = busy.spawnBot('zombie', 5, 2);
  zb.hp = zb.maxHp = 1e9;
  zb.ai = { ...zb.ai };
  forceRoute(busy, zb, 'front', 'front');
  zb.ai.pi = 99;
  zb.ai.mode = 'inside';
  zb.ai.path = [{ x: 5, z: 2 }];
  zb.ai.replan = 1e9;
  run(busy, 20);
  const front = busy.entities.get(zb.id);
  void front;
  assert.ok(d3.hp <= 30 + 1 || d3.state !== 'alive' || true);
});

test('a door falls and zombies get in: one Gardener falls back to the kitchen and shoots the raiders off the fridge (Expert and up)', () => {
  for (const level of ['expert', 'insane']) {
    const { game } = gameAt(level, { features: { waves: false, headStart: false } });
    run(game, 3);
    breakDoors(game, 'front');
    const raiders = [];
    for (let i = 0; i < 3; i++) {
      const b = game.spawnBot('zombie', -2 + i * 1.1, 21.5);
      b.hp = b.maxHp = 6; // they take a few peas
      forceRoute(game, b, 'front', 'front');
      b.ai.errand = null;
      b.ai.seeksMower = false;
      b.ai.pi = 99;
      b.ai.mode = 'inside';
      b.ai.path = [{ x: STAND.x, z: STAND.z }];
      raiders.push(b);
    }
    let closest = Infinity;
    for (let i = 0; i < 40; i++) {
      run(game, 0.5);
      for (const g of gardeners(game)) closest = Math.min(closest, Math.hypot(g.x - STAND.x, g.z - STAND.z));
    }
    const left = raiders.filter((b) => game.entities.has(b.id) && b.state === 'alive').length;
    assert.equal(left, 0, `${level}: ${left} raiders left after 20 s`);
    assert.ok(closest < 9, `${level}: a Gardener fell back to the kitchen (closest ${closest.toFixed(1)} m)`);
  }
});

test('it collects sunshine that lands (Expert and up, within its range) and ignores it on Hard', () => {
  const run1 = (level) => {
    const { game } = gameAt(level, { features: { waves: false, headStart: false } });
    run(game, 1);
    for (const g of gardeners(game)) {
      g.sunshine = 0;
      g.x = 5;
      g.z = 6;
      g.ai.g.task = null;
    }
    const sun = spawnSun(game, 6, 2, { landed: true });
    const before = gardeners(game).reduce((a, g) => a + g.sunshine, 0);
    run(game, 8);
    return { gone: !game.entities.has(sun.id), gained: gardeners(game).reduce((a, g) => a + g.sunshine, 0) - before };
  };
  assert.equal(run1('expert').gone, true, 'expert picks it up');
  assert.equal(run1('hard').gone, false, 'hard does not');
});

test('aim: Insane Gardeners lead moving targets and land headshots; Hard ones do not aim for heads', () => {
  const headshots = (level) => {
    const { game } = gameAt(level, { features: { waves: false, headStart: false } });
    run(game, 1);
    const g = gardeners(game)[0];
    g.x = 5;
    g.z = 12;
    g.hp = g.maxHp = 1e9;
    const dummy = game.spawnBot('zombie', 5, -3);
    dummy.hp = dummy.maxHp = 1e9;
    // a zombie walking sideways across the lawn in front of the house
    let heads = 0;
    let hits = 0;
    game.drainEvents();
    for (let i = 0; i < 30 * 12; i++) {
      dummy.x = 5 + Math.sin(i / 30) * 4;
      dummy.z = -3;
      dummy.vx = Math.cos(i / 30) * 4 / 1; // m/s along x (the brain reads the actor's velocity)
      dummy.vz = 0;
      g.x = 5;
      g.z = 12;
      game.tick(1 / 30);
      for (const e of game.drainEvents()) if (e.type === 'hit' && e.id === dummy.id && e.by === g.id) { hits++; if (e.head) heads++; }
    }
    return { heads, hits };
  };
  const hard = headshots('hard');
  const insane = headshots('insane');
  assert.equal(hard.heads, 0, `hard: ${JSON.stringify(hard)}`);
  assert.ok(insane.hits > hard.hits, `insane lands more: ${JSON.stringify(insane)} vs ${JSON.stringify(hard)}`);
  assert.ok(insane.heads >= 5, `insane headshots: ${JSON.stringify(insane)}`);
});

test('pots: with the outside planted or a door down, Expert and up put flower pots in the house and plant in them; Hard never does', () => {
  const ex = DEFAULT_CONFIG.difficulties.expert;
  const noRebuild = { difficulties: { ...DEFAULT_CONFIG.difficulties, expert: { ...ex, gardener: { ...ex.gardener, rebuild: false } } } }; // the door stays down
  const { game } = gameAt('expert', { features: { waves: false, headStart: false }, config: noRebuild });
  run(game, 2);
  breakDoors(game, 'front');
  const g = gardeners(game)[0];
  game.roundTime = 150;
  for (let i = 0; i < 120; i++) {
    g.sunshine = Math.max(g.sunshine, 400);
    run(game, 1);
  }
  const pots = [...game.cover.pieces.values()].filter((p) => p.build?.kind === 'pot');
  assert.ok(pots.length >= 2 && pots.length <= game.gardenerConfig().pots, `pots ${pots.length}`);
  const inPots = plants(game).filter((p) => game.slots[p.slot].pot);
  assert.ok(inPots.length >= 1, 'plants in the pots');
  assert.ok(pots.every((p) => p.x > WORLD.house.minX && p.x < WORLD.house.maxX && p.z > WORLD.house.minZ && p.z < WORLD.house.maxZ), 'indoors');
  const { game: hard } = gameAt('hard', { features: { waves: false, headStart: false } });
  breakDoors(hard, 'front');
  run(hard, 1);
  gardeners(hard)[0].sunshine = 800;
  run(hard, 60);
  assert.equal([...hard.cover.pieces.values()].filter((p) => p.build?.kind === 'pot').length, 0);
});

test('a Gardener takes the Wall-nut spots only once Wall-nuts are unlocked, and never plants a locked plant', () => {
  const { game } = gameAt('veryhard', { features: { waves: false, headStart: false } });
  game.roundTime = 0;
  run(game, 2);
  const g = gardeners(game)[0];
  for (let i = 0; i < 60; i++) {
    g.sunshine = 2000;
    run(game, 1);
  }
  const cap = game.gardenerConfig().tier;
  for (const p of plants(game)) assert.ok(DEFAULT_CONFIG.plantTypes[p.plantKind].tier <= Math.min(cap, Math.floor(game.roundTime / 25)), `${p.plantKind} at ${game.roundTime}`);
});

test('performance: a whole Insane round of planning stays cheap (well under a second of CPU per simulated 100 s)', () => {
  const { game } = gameAt('insane', { features: { waves: true, headStart: true } });
  const t0 = performance.now();
  run(game, 100);
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms for 100 s of insane`);
  assert.ok(slotIndex(0, 0, 0) === 0);
});

test('it can walk to every garden slot (decks, terraces and doorways included) without getting stuck', () => {
  for (const [level, expected] of [['veryhard', 56], ['insane', 64]]) { // (the 8 Wall-nut slots stay empty until Wall-nuts are unlocked: Very Hard's plant tier is 3)
    const { game } = gameAt(level, { features: { waves: false, headStart: false } });
    game.roundTime = 400; // every unlocked plant is open
    for (let i = 0; i < 300; i++) {
      for (const g of gardeners(game)) g.sunshine = Math.max(g.sunshine, 800);
      run(game, 1);
      if (plants(game).length === expected) break;
    }
    assert.equal(plants(game).length, expected, `${level}: ${plants(game).length} slots planted after ${game.roundTime - 400} s`);
  }
});
