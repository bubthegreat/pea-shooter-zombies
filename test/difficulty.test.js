import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { DIFFICULTIES, normalizeDifficulty } from '../server/sim/game.js';
import { LobbyManager } from '../server/lobby.js';
import { LEVELS, diffLabel, levelIndex, isLevel } from '../client/lobbyview.js';
import { makeGame, run, entitiesOfKind, mulberry32, NO_FEATURES } from './helpers.js';

const D = DEFAULT_CONFIG.difficulties;
const IDS = ['easy', 'normal', 'hard', 'veryhard', 'expert', 'nightmare', 'insane'];

test('seven levels, easiest first, same ids / names / order as the client menus', () => {
  assert.deepEqual(Object.keys(D), IDS);
  assert.deepEqual([...DIFFICULTIES], IDS);
  assert.deepEqual(LEVELS.map((l) => l.id), IDS);
  assert.deepEqual(LEVELS.map((l) => l.name), IDS.map((id) => D[id].name));
  assert.deepEqual(LEVELS.map((l) => l.name), ['Easy', 'Normal', 'Hard', 'Very Hard', 'Expert', 'Nightmare', 'Insane']);
  assert.equal(diffLabel('insane'), 'Insane');
  assert.equal(diffLabel('veryhard'), 'Very Hard');
  assert.equal(diffLabel('banana'), 'Normal');
  assert.equal(levelIndex('nightmare'), 5);
  assert.equal(isLevel('hard'), true);
  assert.equal(isLevel('Hard'), false);
  assert.equal(DEFAULT_CONFIG.defaultDifficulty, 'normal');
});

test('Easy and Normal keep their old numbers', () => {
  const pick = (d) => ({ aimError: d.aimError, fireScale: d.fireScale, reaction: d.reaction, waveBase: d.waveBase });
  assert.deepEqual(pick(D.easy), { aimError: 0.15, fireScale: 0.3, reaction: 0.8, waveBase: 2 });
  assert.deepEqual(pick(D.normal), { aimError: 0.14, fireScale: 0.3, reaction: 0.4, waveBase: 4 });
  for (const id of ['easy', 'normal']) {
    const d = D[id];
    assert.equal(d.waveStep, 1);
    assert.equal(d.speedScale, 1);
    assert.equal(d.smart, 0);
    assert.equal(d.focus, 0);
    assert.deepEqual(d.gardener, {}, 'the basic Gardener, exactly as before');
  }
});

test('every zombie-side knob only ever gets harder from level to level', () => {
  const rising = ['fireScale', 'waveBase', 'waveStep', 'speedScale', 'shootScale', 'lead', 'smart', 'focus', 'errand', 'mower'];
  const falling = ['aimError', 'reaction'];
  for (let i = 1; i < IDS.length; i++) {
    const a = D[IDS[i - 1]];
    const b = D[IDS[i]];
    for (const k of rising) assert.ok(b[k] >= a[k], `${IDS[i]}.${k} ${b[k]} >= ${a[k]}`);
    for (const k of falling) assert.ok(b[k] <= a[k], `${IDS[i]}.${k} ${b[k]} <= ${a[k]}`);
    assert.ok(b.waveBase + 5 * b.waveStep > a.waveBase + 5 * a.waveStep, `${IDS[i]} sends more zombies by wave 5`);
  }
});

test('every Gardener knob only ever gets harder from Hard up, and Expert fields two', () => {
  const g = (id) => ({ ...DEFAULT_CONFIG.gardener, ...D[id].gardener });
  assert.equal(g('easy').brain, 'basic');
  assert.equal(g('normal').brain, 'basic');
  for (let i = 3; i < IDS.length; i++) {
    const a = g(IDS[i - 1]);
    const b = g(IDS[i]);
    assert.equal(b.brain, 'smart');
    for (const k of ['speed', 'maxSunshine', 'fireScale', 'head', 'lead', 'strafe', 'tier', 'forts', 'pots', 'count']) assert.ok(b[k] >= a[k], `${IDS[i]}.${k} ${b[k]} >= ${a[k]}`);
    for (const k of ['aimError', 'reaction', 'upgradeInterval', 'think']) assert.ok(b[k] <= a[k], `${IDS[i]}.${k} ${b[k]} <= ${a[k]}`);
  }
  assert.equal(g('veryhard').count, 1);
  assert.equal(g('expert').count, 2);
  assert.equal(g('insane').count, 2);
  assert.equal(g('insane').tier, Math.max(...Object.values(DEFAULT_CONFIG.plantTypes).map((t) => t.tier)), 'Insane may plant everything');
  assert.equal(g('insane').retreat, true);
  assert.equal(g('hard').retreat, false);
});

test('normalizeDifficulty accepts the ids and friendly spellings, nothing else', () => {
  for (const id of IDS) assert.equal(normalizeDifficulty(id), id);
  assert.equal(normalizeDifficulty('Very Hard'), 'veryhard');
  assert.equal(normalizeDifficulty('INSANE'), 'insane');
  assert.equal(normalizeDifficulty('very_hard'), 'veryhard');
  for (const bad of ['', 'impossible', 'hardest', 5, null, undefined, {}, [], 'x'.repeat(500), 'hard hard']) assert.equal(normalizeDifficulty(bad), null, String(bad));
});

test('a game keeps the level it was started with; junk falls back to the default', () => {
  for (const id of IDS) {
    const g = makeGame();
    g.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: id });
    assert.equal(g.difficulty, id);
    assert.equal(g.difficultyConfig(), D[id]);
  }
  const g = makeGame();
  g.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: 'ultra' });
  assert.equal(g.difficulty, 'normal');
  const m = makeGame();
  m.startMatch({ mode: 'coop', difficulty: 'Nightmare', players: [{ id: 'a', name: 'A', team: 'plant' }] });
  assert.equal(m.difficulty, 'nightmare');
});

test('the gardener config of a level is the base config with the level on top', () => {
  const g = makeGame();
  g.addPlayer('a', { team: 'zombie', mode: 'coop', difficulty: 'normal' });
  assert.deepEqual(g.gardenerConfig(), DEFAULT_CONFIG.gardener);
  const h = makeGame();
  h.addPlayer('a', { team: 'zombie', mode: 'coop', difficulty: 'insane' });
  assert.equal(h.gardenerConfig().brain, 'smart');
  assert.equal(h.gardenerConfig().name, 'Gardener', 'untouched keys come from the base');
  assert.equal(h.gardenerConfig().speed, D.insane.gardener.speed);
});

test('waves grow with the level: the same wave brings more zombies on Insane than on Easy', () => {
  const sizes = {};
  for (const id of IDS) {
    const g = makeGame({ features: { waves: true, headStart: false } });
    g.addPlayer('a', { team: 'plant', mode: 'coop', difficulty: id });
    run(g, 6); // wave 1 at 5 s
    sizes[id] = entitiesOfKind(g, 'bot').filter((b) => b.team === 'zombie').length;
  }
  assert.equal(sizes.easy, 3, 'Easy: 2 + 1');
  assert.equal(sizes.normal, 5, 'Normal: 4 + 1');
  for (let i = 1; i < IDS.length; i++) assert.ok(sizes[IDS[i]] >= sizes[IDS[i - 1]], `${IDS[i]} ${sizes[IDS[i]]} >= ${sizes[IDS[i - 1]]}`);
  assert.ok(sizes.insane >= sizes.easy + 8, JSON.stringify(sizes));
});

function member(id, name = id) {
  return { id, cid: `cid-${id}`, name, team: 'plant', lobby: null, lastInputAt: 0, inputActive: false, sent: [], raws: [], send(o) { this.sent.push(o); }, raw(s) { this.raws.push(s); } };
}

test('lobbies take every level, in the list and the waiting room, and the host can change it', () => {
  const mgr = new LobbyManager({ config: { ...DEFAULT_CONFIG, features: { ...NO_FEATURES } }, rng: mulberry32(3), now: () => 1000, stateIntervalMs: 0 });
  const host = member('h1', 'Host');
  for (const id of IDS) {
    const res = mgr.create(host, { lobbyName: 'L', mode: 'coop', difficulty: id, team: 'plant', name: 'Host' });
    assert.equal(res.lobby.difficulty, id, id);
    assert.equal(mgr.list().find((l) => l.id === res.lobby.id).difficulty, id);
    mgr.leave(host);
  }
  const res = mgr.create(host, { lobbyName: 'L', mode: 'coop', difficulty: 'Very Hard', team: 'plant', name: 'Host' });
  assert.equal(res.lobby.difficulty, 'veryhard');
  assert.ok(!mgr.setOptions(host, { difficulty: 'insane' }).error);
  assert.equal(host.lobby.difficulty, 'insane');
  mgr.setOptions(host, { difficulty: 'nope' });
  assert.equal(host.lobby.difficulty, 'insane', 'junk is ignored');
  mgr.setOptions(host, { difficulty: 'easy' });
  assert.equal(host.lobby.difficulty, 'easy', 'old ids still work');
});
