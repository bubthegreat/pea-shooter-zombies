import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { ZOMBIE_LADDER, PLANT_LADDER } from '../server/sim/weapons.js';
import { recordKill, recordHurt } from '../server/sim/upgrades.js';
import { applyDamage } from '../server/sim/combat.js';
import { makeGame, run } from './helpers.js';

function plantGame(overrides) {
  const game = makeGame(overrides);
  const p = game.addPlayer('a', { name: 'A', team: 'plant', mode: 'coop' });
  return { game, p };
}

function killsWithoutBonus(game, p, n) {
  for (let i = 0; i < n; i++) {
    recordKill(game, p);
    recordHurt(p); // keep the streak from triggering the bonus
  }
}

test('2 kills -> tier 1 Double Pea, upgrade event', () => {
  const { game, p } = plantGame();
  assert.equal(p.weapon, 'pea_blaster');
  killsWithoutBonus(game, p, 1);
  assert.equal(p.tier, 0);
  assert.deepEqual(game.drainEvents().filter((e) => e.type === 'upgrade'), []);
  killsWithoutBonus(game, p, 1);
  assert.equal(p.tier, 1);
  assert.equal(p.weapon, 'double_pea');
  assert.equal(p.progress, 2);
  const ev = game.drainEvents().filter((e) => e.type === 'upgrade');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].id, 'a');
  assert.equal(ev[0].tier, 1);
  assert.equal(ev[0].weapon, 'double_pea');
  assert.equal(ev[0].name, 'Double Pea');
  assert.equal(ev[0].bonus, false);
});

test('every threshold gives the next weapon, and the top tier (23 kills) is the House Gun', () => {
  const { game, p } = plantGame();
  const th = DEFAULT_CONFIG.tierThresholds;
  for (let t = 1; t < th.length; t++) {
    killsWithoutBonus(game, p, th[t] - p.progress);
    assert.equal(p.tier, t, `tier at ${th[t]} kills`);
    assert.equal(p.weapon, PLANT_LADDER[t].id);
  }
  assert.equal(p.weapon, 'house_gun');
  killsWithoutBonus(game, p, 10);
  assert.equal(p.tier, 7, 'top tier is capped');
  assert.equal(p.weapon, 'house_gun');
});

test('10 kills without being hurt -> extra tier jump and streak resets', () => {
  const { game, p } = plantGame();
  for (let i = 0; i < 9; i++) recordKill(game, p);
  assert.equal(p.tier, 3, '9 kills = tier 3 by threshold');
  assert.equal(p.streak, 9);
  game.drainEvents();
  recordKill(game, p); // 10th: threshold tier is 4, bonus jumps to 5
  assert.equal(p.tier, 5);
  assert.equal(p.weapon, PLANT_LADDER[5].id);
  assert.equal(p.streak, 0);
  const ev = game.drainEvents().filter((e) => e.type === 'upgrade');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].bonus, true);
  assert.ok(p.progress >= DEFAULT_CONFIG.tierThresholds[5], 'progress follows the jump');
});

test('streak bonus skips ahead one tier (tier = min(top, thresholdTier + 1))', () => {
  const { game, p } = plantGame({ streakBonus: 3 });
  recordKill(game, p);
  assert.equal(p.tier, 0);
  recordKill(game, p); // 2 kills => threshold tier 1
  assert.equal(p.tier, 1);
  recordKill(game, p); // streak 3: threshold tier 1, bonus => tier 2
  assert.equal(p.tier, 2);
  assert.equal(p.weapon, 'pea_rifle');
  assert.equal(p.streak, 0);
  // tiers never go down and normal thresholds keep working
  assert.equal(p.progress, 4, 'the kill meter follows the jump');
  for (let i = 0; i < 2; i++) { recordKill(game, p); recordHurt(p); }
  assert.equal(p.tier, 2);
  recordKill(game, p); // 7 kills
  assert.equal(p.tier, 3);
});

test('getting hit resets streak but not tier', () => {
  const { game, p } = plantGame();
  for (let i = 0; i < 3; i++) recordKill(game, p);
  assert.equal(p.tier, 1);
  assert.equal(p.streak, 3);
  const shooter = game.spawnBot('zombie', WORLD.plantSpawn.x, WORLD.plantSpawn.z - 5);
  applyDamage(game, p, 8, shooter);
  assert.equal(p.streak, 0);
  assert.equal(p.tier, 1);
  assert.equal(p.weapon, 'double_pea');
  assert.equal(p.progress, 3);
});

test('zombie ladder: top is auto_shot_rifle', () => {
  const game = makeGame();
  const z = game.addPlayer('z', { team: 'zombie', mode: 'versus' });
  assert.equal(z.weapon, ZOMBIE_LADDER[0].id);
  killsWithoutBonus(game, z, 23);
  assert.equal(z.tier, 7);
  assert.equal(z.weapon, 'auto_shot_rifle');
  assert.equal(ZOMBIE_LADDER.at(-1).id, 'auto_shot_rifle');
  assert.equal(PLANT_LADDER.at(-1).id, 'house_gun');
});

test('bots do not upgrade', () => {
  const game = makeGame();
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  const bot = game.spawnBot('plant', 0, 0);
  assert.doesNotThrow(() => recordKill(game, bot));
  assert.doesNotThrow(() => recordKill(game, null));
  assert.doesNotThrow(() => recordHurt(null));
  assert.equal(bot.tier, undefined);
  assert.equal(bot.progress, undefined);
});

test('converting zombies through combat counts as kills', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  for (let i = 0; i < 3; i++) {
    const z = game.spawnBot('zombie', WORLD.plantSpawn.x, WORLD.plantSpawn.z - 10);
    applyDamage(game, z, 5, a);
    assert.equal(game.entities.has(z.id), false);
  }
  assert.equal(a.progress, 3);
  assert.equal(a.tier, 1);
  assert.equal(a.weapon, 'double_pea');
});

test('zombie player earns progress by wilting plant bots and players', () => {
  const game = makeGame();
  const z = game.addPlayer('z', { team: 'zombie', mode: 'coop' });
  const bot = game.spawnBot('plant', 0, 0);
  applyDamage(game, bot, 1000, z);
  assert.equal(z.progress, 1);
  const p = game.addPlayer('p', { team: 'plant' });
  applyDamage(game, p, 1000, z);
  assert.equal(p.state, 'wilted');
  assert.equal(z.progress, 2);
  // wilted player does not lose upgrades
  p.tier = 2;
  run(game, 4.5);
  assert.equal(p.tier, 2);
});

test('dying or wilting does not take upgrades away', () => {
  const { game, p } = plantGame();
  killsWithoutBonus(game, p, 8);
  assert.equal(p.tier, 3);
  const shooter = game.spawnBot('zombie', 0, 0);
  applyDamage(game, p, 1000, shooter);
  run(game, 4.5);
  assert.equal(p.state, 'alive');
  assert.equal(p.tier, 3);
  assert.equal(p.weapon, 'snow_pea');
  assert.equal(p.progress, 8);
});

test('tiers reset on new round', () => {
  const { game, p } = plantGame();
  killsWithoutBonus(game, p, 12);
  assert.equal(p.tier, 4);
  game.startRound();
  assert.equal(p.tier, 0);
  assert.equal(p.progress, 0);
  assert.equal(p.streak, 0);
  assert.equal(p.weapon, 'pea_blaster');
});

test('snapshot exposes tier, progress and streak for the HUD', () => {
  const { game, p } = plantGame();
  recordKill(game, p);
  const e = game.snapshot().entities.find((x) => x.id === 'a');
  assert.equal(e.tier, 0);
  assert.equal(e.progress, 1);
  assert.equal(e.streak, 1);
  assert.equal(e.weapon, 'pea_blaster');
});
