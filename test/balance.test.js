import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { mulberry32 } from './helpers.js';

// Coarse balance guard-rails (the real tuning tool is scripts/balance.mjs). Whole seeded rounds with an AFK
// plant kid: Easy should usually be won by the plants but not always, Normal should be a real fight, and the
// mower should be a regular part of the zombies' plan.
function afkRound(difficulty, seed) {
  const game = new Game(DEFAULT_CONFIG, mulberry32(seed * 7919 + 13));
  game.addPlayer('h', { team: 'plant', mode: 'coop', difficulty });
  let mowerUsed = false;
  while (game.phase === 'playing' && game.roundTime < 600) {
    game.tick(1 / 30);
    game.drainEvents();
    if (game.mower.state === 'driving') mowerUsed = true;
  }
  return { winner: game.winner, mowerUsed };
}

test('an AFK plant kid usually wins on Easy; on Normal it is a coin flip-ish fight; the mower gets used', () => {
  const easy = [];
  const normal = [];
  for (let seed = 1; seed <= 12; seed++) {
    easy.push(afkRound('easy', seed));
    normal.push(afkRound('normal', seed));
  }
  const plantWins = (rs) => rs.filter((r) => r.winner === 'plant').length;
  assert.ok(plantWins(easy) >= 9, `Easy: plants won ${plantWins(easy)}/12`);
  assert.ok(plantWins(normal) >= 2 && plantWins(normal) <= 10, `Normal: plants won ${plantWins(normal)}/12`);
  assert.ok(plantWins(easy) >= plantWins(normal), 'Easy is no harder than Normal');
  const mowerRounds = [...easy, ...normal].filter((r) => r.mowerUsed).length;
  assert.ok(mowerRounds >= 6, `mower driven in ${mowerRounds}/24 rounds`);
});
