import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { applyDamage } from '../server/sim/combat.js';
import { planWaves } from '../server/sim/rules.js';
import { makeGame, run, entitiesOfKind } from './helpers.js';

const zombieBots = (game) => entitiesOfKind(game, 'bot').filter((b) => b.team === 'zombie');
const garden = (game) => entitiesOfKind(game, 'garden');

function wavesGame(difficulty = 'normal', extra = {}) {
  const game = makeGame({ features: { waves: true, ...extra.features }, ...extra.config });
  game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty });
  return game;
}

test('wave 1 spawns 4 zombies at the gate at t=5', () => {
  const game = wavesGame('normal');
  run(game, 4.9);
  assert.equal(zombieBots(game).length, 0);
  assert.equal(game.wave, 0);
  run(game, 0.2);
  const bots = zombieBots(game);
  assert.equal(bots.length, 4);
  for (const b of bots) {
    assert.ok(Math.abs(b.z - WORLD.gate.z) < 1, `bot z=${b.z}`);
    assert.ok(b.x >= WORLD.gate.minX && b.x <= WORLD.gate.maxX);
    assert.equal(b.hp, DEFAULT_CONFIG.zombieHp);
    assert.equal(b.state, 'alive');
  }
  assert.equal(game.wave, 1);
  const ev = game.drainEvents().filter((e) => e.type === 'wave');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].wave, 1);
  assert.equal(ev[0].size, 4);
  assert.equal(game.snapshot().wave, 1);
});

test('easy waves are 2 + wave, later waves come every 45 s and grow', () => {
  const easy = wavesGame('easy');
  run(easy, 5.2);
  assert.equal(zombieBots(easy).length, 3);

  const game = wavesGame('normal');
  run(game, 50.5);
  assert.equal(game.wave, 2);
  assert.equal(zombieBots(game).length, 4 + 5);
});

test('waves are planned from t=5 every 45 s, with the last wave 60 s before sunrise', () => {
  const t = planWaves(DEFAULT_CONFIG);
  assert.equal(t[0], 5);
  assert.equal(t[1], 50);
  assert.equal(t.at(-1), DEFAULT_CONFIG.roundLength - 60);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1] + 20, 'waves are not bunched up');
  assert.ok(t.length >= 8);
});

test('the final wave is flagged and no wave follows it', () => {
  const game = wavesGame('normal');
  game.roundTime = DEFAULT_CONFIG.roundLength - 61;
  game.waveIndex = game.waveTimes.length - 1;
  game.tick(1 / 30);
  assert.equal(game.finalWaveSpawned, false);
  run(game, 1.1);
  assert.equal(game.finalWaveSpawned, true);
  const ev = game.drainEvents().filter((e) => e.type === 'wave').at(-1);
  assert.equal(ev.final, true);
  const n = zombieBots(game).length;
  run(game, 10);
  assert.equal(zombieBots(game).length, n);
});

test('zombie bot count is capped', () => {
  const game = wavesGame('normal', { config: { maxZombieBots: 6 } });
  run(game, 5.2);
  assert.equal(zombieBots(game).length, 4);
  game.roundTime = 50;
  run(game, 0.2);
  assert.equal(zombieBots(game).length, 6);
});

const winGame = (extra = {}) => {
  const game = makeGame({ features: { winRules: true, initialGarden: true, ...extra.features }, ...extra.config });
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'normal' });
  return { game, a };
};

test('garden count 0 -> zombie win', () => {
  const { game } = winGame();
  run(game, 1);
  assert.equal(game.phase, 'playing');
  for (const g of garden(game)) applyDamage(game, g, 1000, null);
  assert.equal(game.gardenCount(), 0);
  game.tick(1 / 30);
  assert.equal(game.phase, 'ended');
  assert.equal(game.winner, 'zombie');
  const win = game.drainEvents().find((e) => e.type === 'win');
  assert.ok(win);
  assert.equal(win.winner, 'zombie');
  const snap = game.snapshot();
  assert.equal(snap.phase, 'ended');
  assert.equal(snap.winner, 'zombie');
});

test('sunrise with garden -> plant win', () => {
  const { game } = winGame();
  game.roundTime = DEFAULT_CONFIG.roundLength - 0.05;
  game.tick(1 / 30);
  assert.equal(game.phase, 'playing');
  game.tick(1 / 30);
  game.tick(1 / 30);
  assert.equal(game.phase, 'ended');
  assert.equal(game.winner, 'plant');
  assert.equal(game.drainEvents().find((e) => e.type === 'win').winner, 'plant');
});

test('losing the garden on the last tick still counts for zombies', () => {
  const { game } = winGame();
  game.roundTime = DEFAULT_CONFIG.roundLength - 0.01;
  for (const g of garden(game)) applyDamage(game, g, 1000, null);
  game.tick(1 / 30);
  assert.equal(game.winner, 'zombie');
});

test('final wave cleared -> plant win', () => {
  const { game } = winGame({ features: { waves: true } });
  const last = DEFAULT_CONFIG.roundLength - 60;
  game.roundTime = last - 0.01;
  game.waveIndex = game.waveTimes.length - 1;
  game.tick(1 / 30);
  assert.equal(game.finalWaveSpawned, true);
  assert.equal(game.phase, 'playing', 'zombies just spawned');
  const bots = zombieBots(game);
  assert.ok(bots.length > 0);
  for (const b of bots.slice(1)) applyDamage(game, b, 99, game.entities.get('a'));
  game.tick(1 / 30);
  assert.equal(game.phase, 'playing', 'one zombie remains');
  applyDamage(game, bots[0], 99, game.entities.get('a'));
  game.tick(1 / 30);
  assert.equal(game.phase, 'ended');
  assert.equal(game.winner, 'plant');
});

test('a zombie human blocks the clear-win, including while sprouting', () => {
  const { game } = winGame({ features: { waves: true } });
  const z = game.addPlayer('z', { team: 'zombie' });
  game.roundTime = DEFAULT_CONFIG.roundLength - 60 - 0.01;
  game.waveIndex = game.waveTimes.length - 1;
  game.tick(1 / 30);
  for (const b of zombieBots(game)) applyDamage(game, b, 99, game.entities.get('a'));
  game.tick(1 / 30);
  assert.equal(game.phase, 'playing', 'zombie player is still in the fight');
  applyDamage(game, z, 99, game.entities.get('a'));
  assert.equal(z.state, 'sprout');
  game.tick(1 / 30);
  assert.equal(game.phase, 'playing', 'a sprouting kid is about to dig back up: the wave is not cleared');
  run(game, 6); // sprout time is 5 s: the kid is back
  assert.equal(z.state, 'alive');
  assert.equal(game.phase, 'playing');
});

test('no plant win from an empty field before the final wave', () => {
  const { game } = winGame({ features: { waves: true } });
  run(game, 3);
  assert.equal(zombieBots(game).length, 0);
  assert.equal(game.phase, 'playing');
});

test('ended restarts after 10 s with tiers reset', () => {
  const { game, a } = winGame();
  a.tier = 2;
  a.progress = 8;
  a.streak = 4;
  a.weapon = 'spike_shotgun';
  a.sunshine = 7;
  game.roundTime = DEFAULT_CONFIG.roundLength;
  game.tick(1 / 30);
  assert.equal(game.phase, 'ended');
  const mode = game.mode;
  run(game, 9.8);
  assert.equal(game.phase, 'ended');
  // firing is disabled while the result is shown
  game.handleInput('a', { fire: true });
  run(game, 0.1);
  assert.equal(entitiesOfKind(game, 'projectile').length, 0);
  run(game, 0.3);
  assert.equal(game.phase, 'playing');
  assert.equal(game.winner, null);
  assert.equal(game.mode, mode);
  assert.ok(game.roundTime < 1);
  assert.equal(a.tier, 0);
  assert.equal(a.progress, 0);
  assert.equal(a.streak, 0);
  assert.equal(a.weapon, 'pea_blaster');
  assert.equal(a.sunshine, DEFAULT_CONFIG.startSunshine);
  assert.equal(a.state, 'alive');
  assert.equal(game.gardenCount(), 20);
  assert.equal(game.wave, 0);
});

test('win rules are inert in the lobby and the game survives an empty tick loop', () => {
  const game = makeGame({ features: { winRules: true, waves: true, botAI: true, gardener: true } });
  assert.doesNotThrow(() => run(game, 5));
  assert.equal(game.phase, 'lobby');
});

test('removing everyone during the ended screen goes back to the lobby', () => {
  const { game } = winGame();
  game.roundTime = DEFAULT_CONFIG.roundLength;
  game.tick(1 / 30);
  assert.equal(game.phase, 'ended');
  game.removePlayer('a');
  assert.equal(game.phase, 'lobby');
  assert.doesNotThrow(() => run(game, 12));
  assert.equal(game.phase, 'lobby');
});
