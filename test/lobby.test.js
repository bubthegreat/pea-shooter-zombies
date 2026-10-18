import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { LobbyManager, MAX_LOBBIES, MAX_PLAYERS_PER_LOBBY } from '../server/lobby.js';
import { mulberry32, NO_FEATURES } from './helpers.js';

const STEP = 1 / DEFAULT_CONFIG.tickRate;

/** A stand-in for a connected client: records what the manager sends it. */
function member(id, name = id, cid = `cid-${id}`) {
  return {
    id, cid, name, team: 'plant', lobby: null, lastInputAt: 0, inputActive: false,
    sent: [], raws: [],
    send(o) { this.sent.push(o); },
    raw(s) { this.raws.push(s); },
    last(type) { return [...this.sent].reverse().find((m) => m.t === type); },
    snaps() { return this.raws.map((r) => JSON.parse(r)).filter((m) => m.t === 'snap'); },
  };
}

function setup(opts = {}) {
  const clock = { t: 1000 };
  const mgr = new LobbyManager({
    config: { ...DEFAULT_CONFIG, features: { ...NO_FEATURES, ...(opts.features ?? {}) } },
    rng: mulberry32(7),
    now: () => clock.t,
    stateIntervalMs: 0, // lobbyState synchronously, so these tests can read it right after each action (coalescing: lobby-hardening.test.js)
    ...opts.manager,
  });
  /** Advance wall time by `sec` seconds in tick-sized slices, stepping the manager. */
  const advance = (sec) => {
    const n = Math.round(sec / STEP);
    for (let i = 0; i < n; i++) {
      clock.t += STEP * 1000;
      mgr.step(clock.t);
    }
  };
  return { mgr, clock, advance };
}

test('limits are 50 players per lobby and 20 lobbies', () => {
  assert.equal(MAX_PLAYERS_PER_LOBBY, 50);
  assert.equal(MAX_LOBBIES, 20);
});

test('create: default name, mode and difficulty; creator is host in a waiting room', () => {
  const { mgr } = setup();
  const a = member('p1', 'Jacob');
  const r = mgr.create(a, {});
  assert.ok(!r.error);
  const st = a.last('lobbyState');
  assert.equal(st.you, 'p1');
  assert.equal(st.lobby.name, "Jacob's Backyard");
  assert.equal(st.lobby.status, 'waiting');
  assert.equal(st.lobby.mode, DEFAULT_CONFIG.defaultMode);
  assert.equal(st.lobby.difficulty, DEFAULT_CONFIG.defaultDifficulty);
  assert.equal(st.lobby.host, 'p1');
  assert.equal(st.lobby.hostName, 'Jacob');
  assert.deepEqual(st.lobby.players, [{ id: 'p1', name: 'Jacob', team: 'plant', host: true }]);
  assert.equal(a.last('welcome'), undefined, 'no game yet');
  const [row] = mgr.list();
  assert.deepEqual(
    { name: row.name, host: row.host, players: row.players, mode: row.mode, difficulty: row.difficulty, status: row.status },
    { name: "Jacob's Backyard", host: 'Jacob', players: 1, mode: 'coop', difficulty: 'normal', status: 'waiting' },
  );
  assert.ok(typeof row.id === 'string');
});

test('create sanitizes lobby name, mode, difficulty, team and name', () => {
  const { mgr } = setup();
  const a = member('p1', 'x');
  const ctl = String.fromCharCode(0, 7);
  mgr.create(a, { name: `  Zed${ctl}  `, lobbyName: `${ctl}${'L'.repeat(80)}`, mode: 'chaos', difficulty: 'impossible', team: 'banana' });
  const st = a.last('lobbyState').lobby;
  assert.equal(st.name, 'L'.repeat(32));
  assert.equal(st.mode, DEFAULT_CONFIG.defaultMode);
  assert.equal(st.difficulty, DEFAULT_CONFIG.defaultDifficulty);
  assert.equal(a.name, 'Zed');
  assert.equal(a.team, 'plant');
  const b = member('p2', 'y');
  mgr.create(b, { lobbyName: '   ', name: 'Bea', mode: 'versus', difficulty: 'easy', team: 'zombie' });
  const sb = b.last('lobbyState').lobby;
  assert.equal(sb.name, "Bea's Backyard");
  assert.equal(sb.mode, 'versus');
  assert.equal(sb.difficulty, 'easy');
  assert.equal(b.team, 'zombie');
});

test('join: everyone in the room is told; unknown lobby is an error', () => {
  const { mgr } = setup();
  const a = member('p1', 'Ann');
  const b = member('p2', 'Bo');
  const lobbyId = mgr.create(a, {}).lobby.id;
  const r = mgr.join(b, lobbyId, { team: 'zombie' });
  assert.ok(!r.error);
  for (const m of [a, b]) {
    const st = m.last('lobbyState').lobby;
    assert.deepEqual(st.players.map((p) => [p.name, p.team, p.host]), [['Ann', 'plant', true], ['Bo', 'zombie', false]]);
  }
  assert.equal(b.last('lobbyState').you, 'p2');
  assert.equal(mgr.list()[0].players, 2);
  const c = member('p3');
  assert.equal(mgr.join(c, 'nope', {}).error, 'gone');
  assert.equal(c.lobby, null);
});

test('setTeam changes the roster entry and tells the room; junk teams are ignored', () => {
  const { mgr } = setup();
  const a = member('p1', 'Ann');
  const b = member('p2', 'Bo');
  const id = mgr.create(a, {}).lobby.id;
  mgr.join(b, id, {});
  mgr.setTeam(b, 'zombie');
  assert.equal(a.last('lobbyState').lobby.players[1].team, 'zombie');
  mgr.setTeam(b, 'banana');
  assert.equal(b.team, 'zombie');
  mgr.setTeam(member('stranger'), 'zombie'); // not in a lobby: harmless
});

test('only the host can start or change options; the host starts and everyone is in the game', () => {
  const { mgr } = setup();
  const a = member('p1', 'Ann');
  const b = member('p2', 'Bo');
  const c = member('p3', 'Cy');
  const lobby = mgr.create(a, { mode: 'coop' }).lobby;
  mgr.join(b, lobby.id, { team: 'zombie' });
  mgr.join(c, lobby.id, { team: 'plant' });
  assert.equal(mgr.start(b).error, 'not_host');
  assert.equal(mgr.setOptions(c, { mode: 'versus' }).error, 'not_host');
  assert.equal(lobby.status, 'waiting');
  assert.equal(lobby.mode, 'coop');
  assert.ok(!mgr.setOptions(a, { mode: 'versus', difficulty: 'easy' }).error);
  assert.equal(b.last('lobbyState').lobby.mode, 'versus');
  assert.equal(b.last('lobbyState').lobby.difficulty, 'easy');
  assert.ok(!mgr.start(a).error);
  assert.equal(lobby.status, 'playing');
  assert.equal(lobby.game.phase, 'playing');
  assert.equal(lobby.game.mode, 'versus');
  assert.deepEqual(lobby.game.humans().map((h) => [h.id, h.name, h.team]), [['p1', 'Ann', 'plant'], ['p2', 'Bo', 'zombie'], ['p3', 'Cy', 'plant']]);
  for (const m of [a, b, c]) {
    const w = m.last('welcome');
    assert.equal(w.id, m.id);
    assert.equal(typeof w.config.eyeHeight, 'number');
    assert.equal(m.last('lobbyState').lobby.status, 'playing');
    const iw = m.sent.findIndex((x) => x.t === 'welcome');
    const ip = m.sent.findIndex((x) => x.t === 'lobbyState' && x.lobby.status === 'playing');
    assert.ok(iw >= 0 && iw < ip, 'welcome comes before the playing state');
  }
  assert.equal(mgr.start(a).error, 'busy', 'cannot start twice');
  assert.equal(mgr.setOptions(a, { mode: 'coop' }).error, 'busy', 'options are locked while playing');
  assert.equal(mgr.list()[0].status, 'playing');
});

test('independent games: each lobby ticks on its own and snapshots go only to its own sockets', () => {
  const { mgr, advance } = setup();
  const a1 = member('a1');
  const a2 = member('a2');
  const b1 = member('b1');
  const idA = mgr.create(a1, { lobbyName: 'A' }).lobby.id;
  mgr.join(a2, idA, {});
  const lobbyB = mgr.create(b1, { lobbyName: 'B' }).lobby;
  mgr.start(a1);
  advance(0.5);
  assert.ok(a1.snaps().length > 3, 'A members get snapshots');
  assert.ok(a2.snaps().length > 3);
  assert.equal(b1.snaps().length, 0, 'a waiting lobby gets no snapshots');
  assert.equal(lobbyB.game.time, 0, 'a waiting lobby is not ticked');
  mgr.start(b1);
  advance(0.5);
  const ids = (m) => new Set(m.snaps().flatMap((s) => s.entities.filter((e) => e.kind === 'player').map((e) => e.id)));
  assert.deepEqual([...ids(a1)].sort(), ['a1', 'a2']);
  assert.deepEqual([...ids(b1)], ['b1']);
  assert.notEqual(mgr.lobbies.get(idA).game, lobbyB.game);
  // input from one lobby affects only that lobby's game
  mgr.input(b1, { keys: { f: true }, yaw: 0, pitch: 0 });
  assert.equal(lobbyB.game.entities.get('b1').input.keys.f, true);
  assert.equal(mgr.lobbies.get(idA).game.entities.get('a1').input.keys.f, false);
});

test('joining a game in progress drops you straight in on the team you pick', () => {
  const { mgr, advance } = setup();
  const a = member('p1', 'Ann');
  const lobby = mgr.create(a, {}).lobby;
  mgr.start(a);
  advance(1);
  const rt = lobby.game.roundTime;
  const z = member('p2', 'Zed');
  const r = mgr.join(z, lobby.id, { team: 'zombie' });
  assert.ok(!r.error);
  assert.equal(lobby.game.entities.get('p2').team, 'zombie');
  assert.equal(lobby.game.entities.get('p2').name, 'Zed');
  assert.equal(z.last('welcome').id, 'p2');
  assert.equal(z.last('lobbyState').lobby.status, 'playing');
  assert.ok(lobby.game.roundTime >= rt, 'round was not restarted');
  advance(0.3);
  assert.ok(z.snaps().some((s) => s.entities.some((e) => e.id === 'p2')));
  assert.equal(a.last('lobbyState').lobby.players.length, 2);
});

test('host leaves: the longest-present player becomes host; the last one out closes the lobby at once', () => {
  const { mgr } = setup();
  const a = member('p1', 'Ann');
  const b = member('p2', 'Bo');
  const c = member('p3', 'Cy');
  const lobby = mgr.create(a, {}).lobby;
  mgr.join(b, lobby.id, {});
  mgr.join(c, lobby.id, {});
  mgr.leave(a);
  assert.equal(a.lobby, null);
  assert.equal(a.last('lobbyState').lobby, null, 'the leaver is told they are out');
  assert.equal(lobby.hostId, 'p2');
  assert.equal(c.last('lobbyState').lobby.host, 'p2');
  assert.equal(c.last('lobbyState').lobby.hostName, 'Bo');
  assert.equal(mgr.list()[0].host, 'Bo');
  assert.ok(!mgr.start(b).error, 'the new host can start');
  mgr.leave(b);
  assert.equal(lobby.hostId, 'p3');
  assert.equal(lobby.game.entities.has('p2'), false, 'left the running game too');
  mgr.leave(c);
  assert.equal(mgr.lobbies.size, 0);
  assert.deepEqual(mgr.list(), []);
});

test('a player who joined a bit later does not jump the host queue', () => {
  const { mgr } = setup();
  const [a, b, c, d] = ['p1', 'p2', 'p3', 'p4'].map((id) => member(id));
  const lobby = mgr.create(a, {}).lobby;
  for (const m of [b, c, d]) mgr.join(m, lobby.id, {});
  mgr.setTeam(c, 'zombie');
  mgr.leave(b); // not the host
  assert.equal(lobby.hostId, 'p1');
  mgr.leave(a);
  assert.equal(lobby.hostId, 'p3', 'c was present before d');
});

test('round end returns everyone to the waiting room, keeping teams; the host can start again', () => {
  const { mgr, advance } = setup({ features: { winRules: true, initialGarden: true } });
  const a = member('p1', 'Ann');
  const b = member('p2', 'Bo');
  const lobby = mgr.create(a, { mode: 'versus' }).lobby;
  mgr.join(b, lobby.id, { team: 'zombie' });
  mgr.start(a);
  advance(0.2);
  lobby.game.roundTime = DEFAULT_CONFIG.roundLength;
  advance(0.2);
  assert.equal(lobby.game.phase, 'ended');
  assert.equal(lobby.status, 'playing', 'result screen still counts as playing');
  assert.equal(mgr.list()[0].over, true);
  const snapsBefore = a.snaps().length;
  advance(DEFAULT_CONFIG.endedTime + 0.5);
  assert.equal(lobby.status, 'waiting');
  assert.equal(lobby.game.phase, 'lobby');
  for (const m of [a, b]) {
    const st = m.last('lobbyState').lobby;
    assert.equal(st.status, 'waiting');
    assert.deepEqual(st.players.map((p) => [p.name, p.team]), [['Ann', 'plant'], ['Bo', 'zombie']]);
  }
  const after = a.snaps().length;
  advance(1);
  assert.equal(a.snaps().length, after, 'no snapshots while waiting');
  assert.ok(after > snapsBefore);
  assert.equal(mgr.list()[0].status, 'waiting');
  assert.equal(mgr.start(b).error, 'not_host');
  assert.ok(!mgr.start(a).error);
  assert.equal(lobby.game.humans().length, 2);
  assert.equal(lobby.game.entities.get('p2').team, 'zombie');
  assert.equal(b.sent.filter((m) => m.t === 'welcome').length, 2, 'welcomed again for the second round');
});

test('safety caps: lobbies per server and players per lobby', () => {
  const { mgr } = setup({ manager: { maxLobbies: 2, maxPlayers: 2 } });
  const a = member('p1');
  const b = member('p2');
  const c = member('p3');
  const id1 = mgr.create(a, {}).lobby.id;
  mgr.create(b, {});
  const extra = member('p4');
  assert.equal(mgr.create(extra, {}).error, 'too_many_lobbies');
  assert.equal(extra.lobby, null);
  assert.ok(!mgr.join(c, id1, {}).error);
  const d = member('p5');
  const r = mgr.join(d, id1, {});
  assert.equal(r.error, 'lobby_full');
  assert.equal(d.lobby, null);
  assert.equal(mgr.list().find((l) => l.id === id1).full, true);
});

test('creating or joining while in a lobby leaves the old one first', () => {
  const { mgr } = setup();
  const a = member('p1', 'Ann');
  const b = member('p2', 'Bo');
  const idA = mgr.create(a, {}).lobby.id;
  mgr.join(b, idA, {});
  const second = mgr.create(b, { lobbyName: 'Two' }).lobby;
  assert.equal(mgr.lobbies.get(idA).members.size, 1);
  assert.equal(b.lobby, second);
  assert.equal(mgr.list().length, 2);
  mgr.join(b, idA, {});
  assert.equal(mgr.lobbies.size, 1, 'the empty lobby closed');
  assert.equal(b.lobby.id, idA);
});

test('setName sanitizes and updates roster, running game and lobby list', () => {
  const { mgr } = setup();
  const a = member('p1', 'Ann');
  const lobby = mgr.create(a, {}).lobby;
  mgr.setName(a, '  Annie  ');
  assert.equal(a.name, 'Annie');
  assert.equal(a.last('lobbyState').lobby.players[0].name, 'Annie');
  assert.equal(mgr.list()[0].host, 'Annie');
  mgr.start(a);
  mgr.setName(a, 'x'.repeat(50));
  assert.equal(lobby.game.entities.get('p1').name, 'x'.repeat(16));
  mgr.setName(a, 42);
  assert.equal(a.name, 'Player');
  const loner = member('p9');
  assert.doesNotThrow(() => mgr.setName(loner, 'No Lobby'));
  assert.equal(loner.name, 'No Lobby');
});

test('reconnect: a dropped member rejoins the same lobby by client token; explicit leave does not', () => {
  const { mgr, clock } = setup();
  const a = member('p1', 'Ann', 'tok-a');
  const b = member('p2', 'Bo', 'tok-b');
  const lobby = mgr.create(a, {}).lobby;
  mgr.join(b, lobby.id, { team: 'zombie' });
  mgr.start(a);
  mgr.leave(b, { remember: true }); // socket dropped
  assert.equal(lobby.members.size, 1);
  const b2 = member('p7', 'Bo', 'tok-b');
  assert.equal(mgr.rejoin(b2), lobby);
  assert.equal(b2.lobby, lobby);
  assert.equal(b2.team, 'zombie');
  assert.equal(b2.last('welcome').id, 'p7');
  assert.equal(b2.last('lobbyState').lobby.status, 'playing');
  assert.equal(lobby.game.entities.get('p7').team, 'zombie');
  assert.equal(mgr.rejoin(member('p8', 'x', 'tok-b')), null, 'one-shot: the record was used up');

  mgr.leave(b2); // pressed Leave
  assert.equal(mgr.rejoin(member('p9', 'x', 'tok-b')), null);

  mgr.leave(a, { remember: true }); // last one out, socket dropped: the empty lobby is held for the rejoin window
  assert.equal(mgr.lobbies.size, 1);
  clock.t += 120_000;
  mgr.step(clock.t);
  assert.equal(mgr.lobbies.size, 0, 'nobody came back in time');
  assert.equal(mgr.rejoin(member('p10', 'Ann', 'tok-a')), null, 'lobby is gone');

  const c = member('p11', 'Cy', 'tok-c');
  const l2 = mgr.create(c, {}).lobby;
  mgr.join(member('p12', 'Di', 'tok-d'), l2.id, {});
  mgr.leave(c, { remember: true });
  clock.t += 120_000;
  assert.equal(mgr.rejoin(member('p13', 'Cy', 'tok-c')), null, 'too late');
  assert.equal(mgr.rejoin(member('p14', 'Cy', undefined)), null, 'no token');
});

test('joining or creating somewhere else clears the slip-back-in record', () => {
  const { mgr } = setup();
  const a = member('p1', 'Ann', 'tok-a');
  const b = member('p2', 'Bo', 'tok-b');
  const first = mgr.create(a, {}).lobby;
  mgr.join(b, first.id, {});
  mgr.leave(b, { remember: true });
  const b2 = member('p3', 'Bo', 'tok-b');
  assert.ok(mgr.recent.has('tok-b'));
  const other = mgr.create(b2, { lobbyName: 'Elsewhere' }).lobby;
  assert.ok(!mgr.recent.has('tok-b'), 'seated again: the record is used up');
  assert.ok(other);
});

test('stale input is released so a silent member stops moving', () => {
  const { mgr, advance } = setup();
  const a = member('p1');
  const lobby = mgr.create(a, {}).lobby;
  mgr.start(a);
  mgr.input(a, { keys: { f: true }, yaw: 0, pitch: 0 });
  assert.equal(lobby.game.entities.get('p1').input.keys.f, true);
  advance(1);
  assert.equal(lobby.game.entities.get('p1').input.keys.f, false);
});

test('input from someone not in a running game is ignored', () => {
  const { mgr } = setup();
  const a = member('p1');
  assert.doesNotThrow(() => mgr.input(a, { keys: { f: true } }));
  const lobby = mgr.create(a, {}).lobby;
  assert.doesNotThrow(() => mgr.input(a, { keys: { f: true } }));
  assert.equal(lobby.game.entities.size, 0);
});

test('a tick error in one lobby does not stop the others', () => {
  const logs = [];
  const { mgr, advance } = setup({ manager: { log: (m) => logs.push(m) } });
  const a = member('a1');
  const b = member('b1');
  const la = mgr.create(a, {}).lobby;
  const lb = mgr.create(b, {}).lobby;
  mgr.start(a);
  mgr.start(b);
  la.game.tick = () => { throw new Error('boom'); };
  advance(0.5);
  assert.ok(logs.some((l) => /boom/.test(l)));
  assert.ok(lb.game.time > 0.3, 'B kept ticking');
  assert.ok(b.snaps().length > 3);
});

test('list and lobbyState are plain JSON with no internals', () => {
  const { mgr } = setup();
  const a = member('p1', 'Ann');
  mgr.create(a, {});
  const json = JSON.stringify([mgr.list(), a.last('lobbyState')]);
  assert.ok(!/cid|tok|sent|raws/.test(json), json);
});
