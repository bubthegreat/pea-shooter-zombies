import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, publicConfig } from '../server/sim/config.js';
import { makeGame, run, entitiesOfKind } from './helpers.js';

const players = () => [
  { id: 'a', name: 'Ann', team: 'plant' },
  { id: 'b', name: 'Bo', team: 'zombie' },
  { id: 'c', name: 'Cy', team: 'zombie' },
];

test('maxPlayers is gone from the config and from publicConfig', () => {
  assert.ok(!('maxPlayers' in DEFAULT_CONFIG));
  assert.ok(!('maxPlayers' in publicConfig()));
});

test('startMatch seats everyone on their team and begins the round', () => {
  const game = makeGame({ features: { initialGarden: true } });
  game.startMatch({ mode: 'versus', difficulty: 'normal', players: players() });
  assert.equal(game.phase, 'playing');
  assert.equal(game.mode, 'versus');
  assert.equal(game.difficulty, 'normal');
  assert.equal(game.humans().length, 3);
  assert.equal(game.entities.get('a').team, 'plant');
  assert.equal(game.entities.get('b').team, 'zombie');
  assert.equal(game.entities.get('b').name, 'Bo');
  assert.equal(game.gardenCount(), 20);
  for (const p of game.humans()) assert.equal(p.state, 'alive');
  run(game, 1);
  assert.equal(game.phase, 'playing');
});

test('startMatch sanitizes mode, difficulty, names and teams', () => {
  const game = makeGame();
  game.startMatch({ mode: 'chaos', difficulty: 'nightmare', players: [{ id: 'a', name: 42, team: 'banana' }] });
  assert.equal(game.mode, DEFAULT_CONFIG.defaultMode);
  assert.equal(game.difficulty, DEFAULT_CONFIG.defaultDifficulty);
  assert.equal(game.entities.get('a').name, DEFAULT_CONFIG.defaultName);
  assert.equal(game.entities.get('a').team, 'plant');
});

test('a player can drop in mid-game after startMatch without restarting the round', () => {
  const game = makeGame();
  game.startMatch({ mode: 'coop', difficulty: 'easy', players: players() });
  run(game, 2);
  const t = game.time;
  const p = game.addPlayer('d', { name: 'Di', team: 'zombie' });
  assert.ok(p);
  assert.equal(game.humans().length, 4);
  assert.ok(game.roundTime > 1.5, 'round kept running');
  assert.equal(game.time, t);
});

test('autoRestart defaults to true: the result screen restarts the round by itself', () => {
  const game = makeGame({ features: { winRules: true, initialGarden: true } });
  game.addPlayer('a', { team: 'plant', mode: 'coop' });
  game.roundTime = DEFAULT_CONFIG.roundLength;
  game.tick(1 / 30);
  assert.equal(game.phase, 'ended');
  run(game, DEFAULT_CONFIG.endedTime + 0.5);
  assert.equal(game.phase, 'playing');
});

test('autoRestart:false: after the result screen the game returns to the lobby phase and clears everything', () => {
  const game = makeGame({ autoRestart: false, features: { winRules: true, initialGarden: true } });
  game.startMatch({ mode: 'coop', difficulty: 'easy', players: players() });
  game.roundTime = DEFAULT_CONFIG.roundLength;
  game.tick(1 / 30);
  assert.equal(game.phase, 'ended');
  run(game, DEFAULT_CONFIG.endedTime - 0.5);
  assert.equal(game.phase, 'ended');
  run(game, 1);
  assert.equal(game.phase, 'lobby');
  assert.equal(game.entities.size, 0);
  assert.equal(game.humans().length, 0);
  assert.equal(entitiesOfKind(game, 'garden').length, 0);
  assert.doesNotThrow(() => run(game, 5));
  assert.equal(game.phase, 'lobby');
  // the same game can run another round
  game.startMatch({ mode: 'versus', difficulty: 'normal', players: players() });
  assert.equal(game.phase, 'playing');
  assert.equal(game.gardenCount(), 20);
  assert.equal(game.mower.state, 'idle');
});

test('renamePlayer changes the entity name (sanitized) and ignores unknown ids and bots', () => {
  const game = makeGame();
  game.startMatch({ mode: 'coop', difficulty: 'easy', players: players() });
  assert.equal(game.renamePlayer('a', '  Annie  '), 'Annie');
  assert.equal(game.entities.get('a').name, 'Annie');
  assert.equal(game.renamePlayer('a', ''), DEFAULT_CONFIG.defaultName);
  assert.equal(game.renamePlayer('nobody', 'x'), null);
  const bot = game.spawnBot('zombie', 0, 0);
  assert.equal(game.renamePlayer(bot.id, 'Hacked'), null);
  assert.equal(bot.name, undefined);
});
