import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL_IDS } from '../scripts/balance-lib.mjs';
import { playMany, summarize } from '../scripts/balance-pool.mjs';

// Coarse balance guard-rails (the real tuning tool is scripts/balance.mjs). Whole seeded rounds with scripted kids, the same
// scenarios as the command-line harness, run on a pool of worker threads. Loose on purpose: a handful of seeds per cell, so the
// checks are about direction and large gaps, never exact rates.
const SEEDS = 12;

// Every round every test needs, played once up front on the worker pool (the sim is deterministic: the same seeds give the same rounds).
const KINDS = ['afk', 'decent', 'good', 'zraid', 'zsolo', 'versus'];
const ROUNDS = (async () => {
  const jobs = [];
  for (const kind of KINDS) {
    const levels = kind === 'afk' ? LEVEL_IDS : LEVEL_IDS;
    for (const level of levels) for (let seed = 1; seed <= (kind === 'afk' ? 6 : SEEDS); seed++) jobs.push({ kind, level, seed });
  }
  for (let seed = 1; seed <= 8; seed++) jobs.push({ name: 'decent-normal', seed });
  for (let seed = 1; seed <= 6; seed++) jobs.push({ name: 'clumsy-normal', seed });
  return playMany(jobs);
})();

async function table(kinds, levels = LEVEL_IDS) {
  const done = await ROUNDS;
  const out = {};
  for (const kind of kinds) {
    out[kind] = {};
    for (const level of levels) out[kind][level] = summarize(done.filter((x) => x.job.kind === kind && x.job.level === level));
  }
  return out;
}

const pct = (s) => `${Math.round(s.zombieRate * 100)}% ${Math.round(s.meanT)}s`;
const line = (t, kind) => LEVEL_IDS.map((l) => `${l} ${pct(t[kind][l])}`).join(' | ');

test('a plant kid who never plants loses the fridge within a couple of minutes at every level: the fridge win is reachable', async () => {
  const t = await table(['afk']);
  for (const level of LEVEL_IDS) {
    assert.equal(t.afk[level].zombieWins, 6, `afk ${level}: zombies won ${t.afk[level].zombieWins}/6`);
    assert.ok(t.afk[level].meanT < 150, `afk ${level}: round lasted ${t.afk[level].meanT.toFixed(0)} s`);
  }
});

test('Easy and Normal keep their old feel: a decent plant kid wins Easy most rounds and has a real fight on Normal', async () => {
  const t = await table(['decent'], ['easy', 'normal']);
  assert.ok(t.decent.easy.zombieWins <= 4, `Easy: zombies won ${t.decent.easy.zombieWins}/${SEEDS}`);
  assert.ok(t.decent.normal.zombieWins >= 2 && t.decent.normal.zombieWins <= 9, `Normal: zombies won ${t.decent.normal.zombieWins}/${SEEDS}`);
  assert.ok(t.decent.easy.zombieWins <= t.decent.normal.zombieWins + 1, 'Easy is no harder than Normal');
});

test('the ladder for plant kids rises with the level: the zombies win more and sooner, level after level (a good kid and a decent kid)', async () => {
  const t = await table(['decent', 'good']);
  for (const kind of ['decent', 'good']) {
    for (let i = 1; i < LEVEL_IDS.length; i++) {
      const a = t[kind][LEVEL_IDS[i - 1]];
      const b = t[kind][LEVEL_IDS[i]];
      assert.ok(b.zombieWins >= a.zombieWins - 3, `${kind}: ${LEVEL_IDS[i]} (${pct(b)}) is not much easier than ${LEVEL_IDS[i - 1]} (${pct(a)})\n${line(t, kind)}`);
      assert.ok(b.meanT <= a.meanT + 40, `${kind}: rounds last no longer at ${LEVEL_IDS[i]} (${pct(b)}) than at ${LEVEL_IDS[i - 1]} (${pct(a)})\n${line(t, kind)}`);
    }
    const easy = t[kind].easy;
    const insane = t[kind].insane;
    assert.ok(insane.zombieRate >= easy.zombieRate + 0.5, `${kind}: Insane (${pct(insane)}) is far harder than Easy (${pct(easy)})`);
    assert.ok(insane.meanT < easy.meanT - 120, `${kind}: Insane rounds are much shorter`);
  }
  // the good kid (planner) shows a spread: it beats Easy and Normal, fights Hard / Very Hard, and is crushed by Insane
  assert.ok(t.good.easy.zombieWins <= 2 && t.good.hard.zombieWins >= 1 && t.good.hard.zombieWins <= 8 && t.good.insane.zombieWins >= 10, line(t, 'good'));
});

test('the ladder for zombie kids falls with the level: a decent zombie kid beats the Gardener less and less (Normal up; the Gardener is the same on Easy and Normal)', async () => {
  const t = await table(['zraid', 'zsolo']);
  const levels = LEVEL_IDS.slice(1); // normal .. insane
  for (let i = 1; i < levels.length; i++) {
    const a = t.zraid[levels[i - 1]];
    const b = t.zraid[levels[i]];
    assert.ok(b.zombieWins <= a.zombieWins + 3, `zraid: ${levels[i]} (${pct(b)}) is not much easier for the zombies than ${levels[i - 1]} (${pct(a)})\n${line(t, 'zraid')}`);
  }
  for (let i = 1; i < LEVEL_IDS.length; i++) {
    const a = t.zsolo[LEVEL_IDS[i - 1]];
    const b = t.zsolo[LEVEL_IDS[i]];
    assert.ok(b.zombieWins <= a.zombieWins + 3, `zsolo: ${LEVEL_IDS[i]} (${pct(b)}) vs ${LEVEL_IDS[i - 1]} (${pct(a)})\n${line(t, 'zsolo')}`);
  }
  assert.ok(t.zraid.normal.zombieWins >= 7, `Normal Gardener is beaten most rounds: ${pct(t.zraid.normal)}`);
  assert.ok(t.zraid.insane.zombieWins <= 2 && t.zsolo.insane.zombieWins <= 1, `Insane Gardeners hold: ${pct(t.zraid.insane)} / ${pct(t.zsolo.insane)}`);
  assert.ok(t.zraid.hard.zombieWins < t.zraid.normal.zombieWins + 1 && t.zraid.veryhard.zombieWins < t.zraid.normal.zombieWins, line(t, 'zraid'));
});

test('zombies come by all three routes and reach the doors; a lazy plant kid (front lawn only) loses to the back routes', async () => {
  const done = await ROUNDS;
  const decent = done.filter((x) => x.job.name === 'decent-normal').map((x) => x.result);
  const lazy = done.filter((x) => x.job.name === 'clumsy-normal').map((x) => x.result);
  const sum = (rs, f) => rs.reduce((a, r) => a + f(r), 0);
  for (const route of ['front', 'left', 'right']) {
    assert.ok(sum(decent, (x) => x.spawned[route]) > 20, `${route}: bots sent`);
    assert.ok(sum(decent, (x) => x.reached[route]) > 0, `${route}: some bots got to the door`);
  }
  assert.ok(lazy.filter((r) => r.winner === 'zombie').length >= 5, 'front-only defence: zombies won most rounds');
  assert.ok(sum(lazy, (x) => x.doorsBroken) / lazy.length >= 1, 'they broke in through the other doors');
});

test('versus (a decent plant kid against a zombie kid, bots on both sides) is roughly even on Normal and every round has a winner', async () => {
  const t = await table(['versus'], ['easy', 'normal', 'insane']);
  assert.ok(t.versus.normal.zombieWins >= 3 && t.versus.normal.zombieWins <= 9, `Normal: zombies won ${t.versus.normal.zombieWins}/${SEEDS}`);
  assert.ok(t.versus.easy.zombieWins <= t.versus.normal.zombieWins + 1 && t.versus.insane.zombieWins >= t.versus.normal.zombieWins, `${pct(t.versus.easy)} | ${pct(t.versus.normal)} | ${pct(t.versus.insane)}`);
  const done = await ROUNDS;
  assert.ok(done.filter((x) => x.job.kind === 'versus').every((x) => x.result.winner === 'plant' || x.result.winner === 'zombie'), 'every round ends with a winner');
});
