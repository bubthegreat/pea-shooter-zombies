import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/sim/game.js';
import { tryPlant, tryUpgrade } from '../server/sim/garden.js';
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

// A plant kid who never shoots but spends all the sunshine he gets: plants peashooters into empty slots and levels
// the weakest plant up (alternating). Teleports to the spot, so this checks the economy, not the walking.
function plantingKidRound(difficulty, seed) {
  const game = new Game(DEFAULT_CONFIG, mulberry32(seed * 7919 + 13));
  const kid = game.addPlayer('h', { team: 'plant', mode: 'coop', difficulty });
  let planted = 0;
  let upgraded = 0;
  let turn = false; // alternate planting and upgrading
  let collect = false;
  while (game.phase === 'playing' && game.roundTime < 600) {
    game.tick(1 / 30);
    for (const e of game.drainEvents()) {
      if (e.type === 'plant') planted++;
      if (e.type === 'plantUp') upgraded++;
    }
    if (Math.round(game.roundTime * 30) % 30 !== 0 || kid.state !== 'alive') continue;
    // every other second: stand on a landed sun to scoop it up; in between: spend
    const sun = [...game.entities.values()].find((e) => e.kind === 'sun' && e.y <= DEFAULT_CONFIG.sunRestHeight + 0.01);
    collect = !collect;
    if (collect && sun) {
      kid.x = sun.x;
      kid.z = sun.z;
      continue;
    }
    const empty = game.slots.find((s) => !s.plantId);
    turn = !turn;
    if (turn && empty && kid.sunshine >= DEFAULT_CONFIG.plantTypes.peashooter.cost) {
      kid.x = empty.x;
      kid.z = empty.z + 1.5;
      tryPlant(game, kid, 'peashooter');
      continue;
    }
    const weakest = [...game.entities.values()].filter((e) => e.kind === 'garden' && (e.level ?? 1) < 3).sort((a, b) => (a.level ?? 1) - (b.level ?? 1))[0];
    if (weakest) {
      kid.x = weakest.x;
      kid.z = weakest.z + 1.5;
      tryUpgrade(game, kid, weakest);
    }
  }
  return { winner: game.winner, planted, upgraded };
}

test('a plant kid who plants and upgrades with his sunshine (no shooting) beats Normal bots most of the time', () => {
  const rounds = [];
  for (let seed = 1; seed <= 6; seed++) rounds.push(plantingKidRound('normal', seed));
  const wins = rounds.filter((r) => r.winner === 'plant').length;
  assert.ok(wins >= 5, `plants won ${wins}/6`);
  assert.ok(rounds.every((r) => r.planted >= 8 && r.upgraded >= 10), `planted/upgraded: ${rounds.map((r) => `${r.planted}/${r.upgraded}`)}`);
});
