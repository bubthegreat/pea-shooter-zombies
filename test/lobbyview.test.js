import test from 'node:test';
import assert from 'node:assert/strict';
import { statusText, detailText, playersText, fmtClock, waitText, modeLabel, diffLabel } from '../client/lobbyview.js';

test('statusText: Waiting / Playing with the time left / Round over', () => {
  assert.deepEqual(statusText({ status: 'waiting' }), { text: 'Waiting', kind: 'waiting' });
  assert.deepEqual(statusText({ status: 'playing', roundTime: 60, roundLength: 480 }), { text: 'Playing · 7:00 left', kind: 'playing' });
  assert.deepEqual(statusText({ status: 'playing', roundTime: 479.2, roundLength: 480 }), { text: 'Playing · 0:01 left', kind: 'playing' });
  assert.equal(statusText({ status: 'playing', over: true, roundTime: 480, roundLength: 480 }).kind, 'over');
  assert.equal(statusText(null).kind, 'waiting');
});

test('detailText and labels', () => {
  assert.equal(detailText({ host: 'Ann', players: 3, mode: 'versus', difficulty: 'easy' }), 'Host Ann · 3 players · Versus · Easy');
  assert.equal(detailText({ host: '', players: 1, mode: 'coop', difficulty: 'normal' }), 'Host ? · 1 player · Co-op · Normal');
  assert.equal(modeLabel('x'), 'Co-op');
  assert.equal(diffLabel('x'), 'Normal');
  assert.equal(playersText(0), '0 players');
  assert.equal(playersText(NaN), '0 players');
});

test('fmtClock', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(65.1), '1:06');
  assert.equal(fmtClock(-5), '0:00');
  assert.equal(fmtClock(undefined), '0:00');
});

test('waitText: host sees a go message, everyone else waits for the host by name', () => {
  const room = { status: 'waiting', host: 'p1', hostName: 'Ann' };
  assert.match(waitText(room, 'p1'), /Press Start/);
  assert.equal(waitText(room, 'p2'), 'Waiting for Ann to start…');
  assert.equal(waitText({ ...room, status: 'playing' }, 'p2'), 'Joining the game…');
  assert.equal(waitText(null, 'p1'), '');
});

import { ruleText, RULES } from '../client/lobbyview.js';

test('the one-sentence rules for each team', () => {
  assert.equal(ruleText('zombie'), 'Break into the house and raid the fridge!');
  assert.equal(ruleText('plant'), 'Plant your garden, guard every door, and hold on until sunrise!');
  assert.equal(ruleText('banana'), RULES.plant);
});
