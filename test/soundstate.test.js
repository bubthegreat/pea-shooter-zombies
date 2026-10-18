import test from 'node:test';
import assert from 'node:assert/strict';
import { loopsAllowed, alarmTarget, LoopMixer, LOOPS } from '../client/soundstate.js';
import { Game } from '../server/sim/game.js';
import { makeGame, run } from './helpers.js';
import { endRound } from '../server/sim/rules.js';

/** A stand-in for client/audio.js Sound that records what the loops are told. */
function fakeSound() {
  const s = { level: { engine: 0 }, calls: [], stops: 0 };
  for (const k of LOOPS) s.level[k] = 0;
  s.loopLevel = (name, v) => { s.level[name] = v; s.calls.push([name, v]); };
  s.engineLevel = (v) => { s.level.engine = v; s.calls.push(['engine', v]); };
  s.stopAll = () => { s.stops++; for (const k of Object.keys(s.level)) s.level[k] = 0; };
  return s;
}
const loud = (s) => Object.entries(s.level).filter(([, v]) => v > 0).map(([k]) => k);

test('loops may only sound in a running round while we are in the game', () => {
  assert.equal(loopsAllowed({ joined: true, hasSelf: true, phase: 'playing' }), true);
  for (const phase of ['ended', 'lobby', null, undefined, 'weird']) assert.equal(loopsAllowed({ joined: true, hasSelf: true, phase }), false, String(phase));
  assert.equal(loopsAllowed({ joined: false, hasSelf: true, phase: 'playing' }), false);
  assert.equal(loopsAllowed({ joined: true, hasSelf: false, phase: 'playing' }), false);
  assert.equal(loopsAllowed(null), false);
});

test('alarm target: only with zombies at the fridge, louder when close, never below 0.2 while it rings', () => {
  assert.equal(alarmTarget({ allowed: true, n: 0, dist: 3 }), 0);
  assert.equal(alarmTarget({ allowed: false, n: 2, dist: 3 }), 0, 'not allowed: silent even though the sim says zombies are there');
  assert.equal(alarmTarget({ allowed: true, n: 1, dist: 0 }), 1);
  assert.ok(alarmTarget({ allowed: true, n: 1, dist: 30 }) < alarmTarget({ allowed: true, n: 1, dist: 10 }));
  assert.equal(alarmTarget({ allowed: true, n: 1, dist: 500 }), 0.2);
  assert.equal(alarmTarget({ allowed: true, n: NaN, dist: 3 }), 0);
});

test('the alarm fades in while playing and is cut dead the moment the round ends, even though the fridge still says n > 0', () => {
  const s = fakeSound();
  const m = new LoopMixer(s);
  for (let i = 0; i < 60; i++) m.update({ allowed: true, alarm: 1, levels: {} }, 1 / 60);
  assert.ok(s.level.alarm > 0.9, `alarm ${s.level.alarm}`);
  s.calls.length = 0;
  // the result screen: the server's snapshot still has fridge.n = 2 but phase is 'ended'
  m.update({ allowed: false, alarm: 1, levels: { weed: 1, engine: 1 } }, 1 / 60);
  assert.deepEqual(loud(s), [], 'everything is silent at once');
  assert.ok(s.stops >= 1, 'stopAll');
  assert.equal(m.alarm, 0, 'the smoothed level is reset too, so it does not resume');
  // many more result-screen frames never start anything again
  for (let i = 0; i < 120; i++) m.update({ allowed: false, alarm: 1, levels: { weed: 1, blower: 1, trimmer: 1, squeak: 1, engine: 1 } }, 1 / 60);
  assert.deepEqual(s.calls.filter(([, v]) => v > 0), [], 'no loop was told to sound');
});

test('after a stop the alarm restarts from zero when the next round plays and zombies are at the fridge', () => {
  const s = fakeSound();
  const m = new LoopMixer(s);
  for (let i = 0; i < 90; i++) m.update({ allowed: true, alarm: 1, levels: {} }, 1 / 60);
  m.update({ allowed: false, alarm: 1, levels: {} }, 1 / 60);
  m.update({ allowed: true, alarm: 0, levels: {} }, 1 / 60); // new round, nobody at the fridge
  assert.equal(s.level.alarm, 0);
  m.update({ allowed: true, alarm: 1, levels: {} }, 1 / 60);
  assert.ok(s.level.alarm > 0 && s.level.alarm < 0.5, `fades in from 0: ${s.level.alarm}`);
});

test('tool, engine and squeak loops follow their levels while playing and obey the same gate', () => {
  const s = fakeSound();
  const m = new LoopMixer(s);
  m.update({ allowed: true, alarm: 0, levels: { engine: 0.5, weed: 1, blower: 0.3, trimmer: 0, squeak: 0.7 } }, 1 / 60);
  assert.equal(s.level.engine, 0.5);
  assert.equal(s.level.weed, 1);
  assert.equal(s.level.blower, 0.3);
  assert.equal(s.level.squeak, 0.7);
  m.update({ allowed: false, alarm: 0, levels: { engine: 0.5, weed: 1 } }, 1 / 60);
  assert.deepEqual(loud(s), []);
});

test('silence() (leaving the lobby, a dropped connection) stops everything and is safe to call repeatedly', () => {
  const s = fakeSound();
  const m = new LoopMixer(s);
  for (let i = 0; i < 30; i++) m.update({ allowed: true, alarm: 1, levels: { weed: 1 } }, 1 / 60);
  assert.ok(loud(s).includes('alarm'));
  m.silence();
  assert.deepEqual(loud(s), []);
  assert.equal(m.alarm, 0);
  m.silence();
  m.silence();
  assert.deepEqual(loud(s), []);
});

test('a missing sound engine (no audio context) is harmless', () => {
  const m = new LoopMixer(null);
  m.update({ allowed: true, alarm: 1, levels: { weed: 1 } }, 0.016);
  m.silence();
  assert.equal(m.alarm, 0);
});

test('server: a finished round reports no zombies at the fridge and nobody using a tool', () => {
  const game = makeGame({ features: { fridge: true, winRules: true, botAI: false } });
  const z = game.addPlayer('z', { team: 'zombie', mode: 'versus' });
  game.addPlayer('p', { team: 'plant', mode: 'versus' });
  game.headStart = 0;
  z.x = -2; z.z = 22; z.y = 0;
  run(game, 0.5);
  assert.ok(game.fridge.n >= 1, 'a zombie at the fridge');
  z.using = true;
  endRound(game, 'zombie');
  assert.equal(game.fridge.n, 0);
  assert.equal(z.using, false);
  assert.equal(game.snapshot().fridge.n, 0);
  assert.equal(game.snapshot().phase, 'ended');
});
