import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, runRound } from '../scripts/balance-lib.mjs';

// Coarse balance guard-rails (the real tuning tool is scripts/balance.mjs). Whole seeded rounds with scripted kids: the same
// scenarios as the command-line harness, with a handful of seeds each.
const SEEDS = 12;

function play(name, seeds = SEEDS) {
  const rs = [];
  for (let s = 1; s <= seeds; s++) rs.push(runRound(s, SCENARIOS[name]));
  const zombieWins = rs.filter((r) => r.winner === 'zombie').length;
  const sum = (f) => rs.reduce((a, r) => a + f(r), 0);
  return { rs, zombieWins, plantWins: rs.filter((r) => r.winner === 'plant').length, avg: (f) => sum(f) / rs.length, sum };
}

test('a plant kid who never plants loses the fridge within a couple of minutes: the fridge win is reachable', () => {
  for (const name of ['afk-easy', 'afk-normal']) {
    const r = play(name, 6);
    assert.equal(r.zombieWins, 6, `${name}: zombies won ${r.zombieWins}/6`);
    assert.ok(r.avg((x) => x.t) < 150, `${name}: round lasted ${r.avg((x) => x.t).toFixed(0)} s`);
  }
});

test('a decent plant kid wins Easy most rounds and has a real fight on Normal', () => {
  const easy = play('decent-easy');
  const normal = play('decent-normal');
  assert.ok(easy.plantWins >= 9, `Easy: plants won ${easy.plantWins}/${SEEDS}`);
  assert.ok(normal.zombieWins >= 1 && normal.zombieWins <= 8, `Normal: zombies won ${normal.zombieWins}/${SEEDS}`);
  assert.ok(easy.zombieWins <= normal.zombieWins + 1, 'Easy is no harder than Normal');
});

test('zombies come by all three routes and reach the doors; a lazy plant kid (front lawn only) loses to the back routes', () => {
  const r = play('decent-normal', 8);
  for (const route of ['front', 'left', 'right']) {
    assert.ok(r.sum((x) => x.spawned[route]) > 20, `${route}: bots sent`);
    assert.ok(r.sum((x) => x.reached[route]) > 0, `${route}: some bots got to the door`);
  }
  const lazy = play('clumsy-normal', 6);
  assert.ok(lazy.zombieWins >= 5, `front-only defence: zombies won ${lazy.zombieWins}/6`);
  assert.ok(lazy.avg((x) => x.doorsBroken) >= 1, 'they broke in through the other doors');
});

test('versus (a decent plant kid against a zombie kid, bots on both sides) is roughly even on Normal', () => {
  const v = play('versus-normal');
  assert.ok(v.zombieWins >= 3 && v.zombieWins <= 9, `zombies won ${v.zombieWins}/${SEEDS}`);
  assert.ok(v.rs.every((r) => r.winner === 'plant' || r.winner === 'zombie'), 'every round ends with a winner');
});
