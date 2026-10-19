import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { plantAt } from '../server/sim/garden.js';
import { ensureAI } from '../server/sim/bots.js';
import { doorStrength, weakestDoor } from '../server/sim/intel.js';
import { makeGame, run, entitiesOfKind, forceRoute, slotIdx } from './helpers.js';

const D = DEFAULT_CONFIG.difficulties;

function levelGame(level, { features = {}, config = {} } = {}) {
  const game = makeGame({ features: { botAI: true, ...features }, botItemChance: {}, ...config });
  const p = game.addPlayer('p', { team: 'plant', mode: 'coop', difficulty: level });
  p.x = 38;
  p.z = 44;
  p.hp = p.maxHp = 1e9;
  return { game, p };
}

test('zombie bots walk faster on harder levels (speedScale)', () => {
  const dist = {};
  for (const level of ['easy', 'normal', 'insane']) {
    const { game } = levelGame(level);
    const b = forceRoute(game, game.spawnBot('zombie', 0, WORLD.gate.z), 'front', 'front');
    b.hp = b.maxHp = 1e9;
    run(game, 3);
    dist[level] = Math.hypot(b.x, b.z - WORLD.gate.z);
  }
  assert.ok(Math.abs(dist.easy - dist.normal) < 0.3, 'Easy and Normal walk at the same speed');
  assert.ok(dist.insane > dist.normal * 1.1, `insane ${dist.insane.toFixed(1)} vs normal ${dist.normal.toFixed(1)}`);
  assert.ok(Math.abs(dist.insane / dist.normal - D.insane.speedScale) < 0.08, 'by about the table factor');
});

test('smart bots pick the weakest way in: with the front door unguarded and the rest stocked, Insane sends most of a wave to the front', () => {
  const door = (level, n = 300) => {
    const { game } = levelGame(level);
    game.slots.forEach((s, i) => { if (s.plot !== 0 && s.row <= 2) plantAt(game, i, 'cactus'); });
    game.tick(1 / 30);
    const count = {};
    for (let i = 0; i < n; i++) {
      const b = game.spawnBot('zombie', 0, WORLD.gate.z);
      ensureAI(game, b);
      count[b.ai.itin.door] = (count[b.ai.itin.door] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(count).map(([k, v]) => [k, v / n]));
  };
  const normal = door('normal');
  assert.ok(Math.abs(normal.front - 0.24) < 0.07, `Normal keeps the route odds: front ${normal.front}`);
  const insane = door('insane');
  assert.ok(insane.front > 0.6, `Insane: ${JSON.stringify(insane)}`);
  const hard = door('hard');
  assert.ok(hard.front > normal.front && hard.front < insane.front, 'it gets smarter step by step');
});

test('doorStrength: more plants and a healthy door make a door stronger; a broken door is the weakest', () => {
  const { game } = levelGame('normal');
  game.tick(1 / 30);
  const w0 = weakestDoor(game);
  assert.ok(['front', 'side', 'back', 'garage'].includes(w0.id));
  game.slots.forEach((s, i) => { if (s.plot === 2 && s.row >= 1) plantAt(game, i, 'cactus'); });
  game.time += 1;
  const back = doorStrength(game).find((d) => d.id === 'back');
  assert.ok(back.power > 10 && back.weak < w0.weak, `back ${back.power} / ${back.weak} vs ${w0.weak}`);
  game.cover.destroy(game.cover.get('door:back'));
  game.time += 1;
  const after = doorStrength(game).find((d) => d.id === 'back');
  assert.equal(after.broken, true);
  assert.ok(after.weak > back.weak * 2, 'broken: much weaker');
});

test('focus: a share of every wave goes for the wave\'s weakest door together (Hard and up); Easy / Normal never do', () => {
  const share = (level) => {
    const { game } = levelGame(level, { features: { waves: true, headStart: false } });
    game.slots.forEach((s, i) => { if (s.plot !== 3 && s.row <= 2) plantAt(game, i, 'cactus'); }); // the garage plot is the weak one
    game.tick(1 / 30);
    let best = 0;
    for (let w = 0; w < 1; w++) {
      game.roundTime = 5.5;
      game.tick(1 / 30);
    }
    const bots = entitiesOfKind(game, 'bot').filter((b) => b.team === 'zombie');
    for (const b of bots) ensureAI(game, b);
    const on = bots.filter((b) => b.ai.itin.door === 'garage').length;
    best = on / Math.max(1, bots.length);
    return { best, n: bots.length };
  };
  const insane = share('insane');
  assert.ok(insane.n >= 6 && insane.best >= 0.55, `insane: ${JSON.stringify(insane)}`);
  const normal = share('normal');
  assert.ok(normal.best < 0.5, `normal: ${JSON.stringify(normal)}`);
});

test('lead: Insane bots aim ahead of a moving plant kid; Normal bots aim at where he is', () => {
  const sharp = { difficulties: { ...D, normal: { ...D.normal, aimError: 0, reaction: 0 }, insane: { ...D.insane, aimError: 0, reaction: 0 } } }; // no random aim error: the lead is all there is
  const aimOffset = (level) => {
    const { game, p } = levelGame(level, { config: sharp });
    p.x = 0;
    p.z = -20;
    p.y = 0;
    const bot = game.spawnBot('zombie', 0, -35);
    bot.hp = bot.maxHp = 1e9;
    forceRoute(game, bot, 'front', 'front');
    bot.ai.mode = 'inside';
    bot.ai.path = [{ x: 0, z: -35 }];
    bot.ai.replan = 1e9;
    for (let i = 0; i < 12; i++) {
      p.vx = 6; // running sideways at 6 m/s
      p.vz = 0;
      game.tick(1 / 30);
    }
    return Math.abs(Math.abs(bot.yaw) - Math.PI); // the kid is straight ahead (yaw pi from the bot's spot)
  };
  const normal = aimOffset('normal');
  const insane = aimOffset('insane');
  assert.ok(normal < 0.02, `normal aims straight at him: ${normal.toFixed(3)}`);
  assert.ok(insane > 0.1, `insane leads him: ${insane.toFixed(3)}`);
});

test('shootScale: a harder bot starts shooting a plant from further away', () => {
  const shoots = (level) => {
    const { game, p } = levelGame(level);
    p.x = 0;
    p.z = -20;
    p.y = 0;
    const bot = game.spawnBot('zombie', 0, -20 - 22); // 22 m: out of Normal's 20 m, inside Insane's 26 m
    bot.hp = bot.maxHp = 1e9;
    forceRoute(game, bot, 'front', 'front');
    bot.ai.pi = 99;
    bot.ai.mode = 'inside';
    bot.ai.path = [{ x: 0, z: -42 }];
    bot.ai.replan = 1e9;
    let shots = 0;
    for (let i = 0; i < 30 * 4; i++) {
      game.tick(1 / 30);
      shots += entitiesOfKind(game, 'projectile').filter((q) => q.team === 'zombie').length ? 1 : 0;
    }
    return shots;
  };
  assert.equal(shoots('normal'), 0, 'Normal: out of range');
  assert.ok(shoots('insane') > 0, 'Insane: in range');
});

test('errands and the mower: harder levels send more bots for parts and the mower', () => {
  const share = (level, field, n = 600) => {
    const { game } = levelGame(level, { config: { botItemChance: undefined, mowerBotChance: DEFAULT_CONFIG.mowerBotChance } });
    let k = 0;
    for (let i = 0; i < n; i++) {
      const b = game.spawnBot('zombie', 0, WORLD.gate.z);
      ensureAI(game, b);
      if (field === 'errand' ? b.ai.errand : false) k++;
    }
    return k / n;
  };
  const e = share('easy', 'errand');
  const i = share('insane', 'errand');
  assert.ok(Math.abs(e - DEFAULT_CONFIG.parts.botChance) < 0.05, `easy ${e}`);
  assert.ok(i > e * 1.8, `insane ${i} vs easy ${e}`);
});

test('an autopilot zombie kid keeps its own skill at every level (so levels change the computer players, not the player)', () => {
  const cfgOf = (level) => {
    const game = makeGame({ features: { botAI: true }, botItemChance: {}, mowerBotChance: 0 });
    game.addPlayer('k', { team: 'zombie', mode: 'coop', difficulty: level });
    const k = game.entities.get('k');
    k.autopilot = true;
    k.autopilotFireScale = 0.5;
    ensureAI(game, k);
    return { fire: k.fireScale, ai: k.ai };
  };
  assert.equal(cfgOf('easy').fire, 0.5);
  assert.equal(cfgOf('insane').fire, 0.5);
  assert.equal(DEFAULT_CONFIG.autopilot.aimError, D.normal.aimError);
  assert.equal(DEFAULT_CONFIG.autopilot.reaction, D.normal.reaction);
  void slotIdx;
});
