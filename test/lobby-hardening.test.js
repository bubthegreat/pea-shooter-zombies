// Abuse-resistance of the LobbyManager: coalesced lobbyState, idle expiry, per-IP caps, empty-lobby rejoin window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { LobbyManager, REJOIN_WINDOW_MS, IDLE_LOBBY_MS, MAX_LOBBIES_PER_IP } from '../server/lobby.js';
import { mulberry32, NO_FEATURES } from './helpers.js';
import { SnapDecoder } from '../shared/snapcodec.js';

const STEP = 1 / DEFAULT_CONFIG.tickRate;

function member(id, { name = id, cid = `cid-${id}`, ip } = {}) {
  return {
    id, cid, name, ip, team: 'plant', lobby: null, lastInputAt: 0, inputActive: false,
    sent: [], jsons: [], raws: [],
    send(o, json) { this.sent.push(o); this.jsons.push(json); },
    raw(s) { this.raws.push(s); },
    states() { return this.sent.filter((m) => m.t === 'lobbyState'); },
    last(type) { return [...this.sent].reverse().find((m) => m.t === type); },
    snaps() {
      const dec = new SnapDecoder(); // snapshots are deltas: replay the lot, in order, to see them whole
      return this.raws.map((r) => JSON.parse(r)).filter((m) => m.t === 'snap' && dec.apply(m));
    },
  };
}

function setup(opts = {}) {
  const clock = { t: 1000 };
  const evicted = [];
  const mgr = new LobbyManager({
    config: { ...DEFAULT_CONFIG, features: { ...NO_FEATURES, ...(opts.features ?? {}) } },
    rng: mulberry32(7),
    now: () => clock.t,
    onEvict: (m, res) => evicted.push([m.id, res.error]),
    ...opts.manager,
  });
  const advance = (sec) => {
    const n = Math.round(sec / STEP);
    for (let i = 0; i < n; i++) {
      clock.t += STEP * 1000;
      mgr.step(clock.t);
    }
  };
  /** Jump the clock and run one step (no sim catch-up). */
  const jump = (ms) => {
    clock.t += ms;
    mgr.step(clock.t);
  };
  return { mgr, clock, advance, jump, evicted };
}

// ---- 1. lobbyState coalescing --------------------------------------------------------------------------

test('a burst of roster changes sends a bounded number of lobbyState, ending on the latest state', () => {
  const { mgr, jump } = setup();
  const a = member('p1');
  const lobby = mgr.create(a, {}).lobby;
  const others = [];
  for (let i = 2; i <= 10; i++) {
    const m = member(`p${i}`);
    mgr.join(m, lobby.id, {});
    others.push(m);
  }
  jump(500);
  jump(500); // quiet period: everything flushed, nothing recent
  const [b] = others;
  const before = a.states().length;
  for (let i = 0; i < 300; i++) {
    mgr.setTeam(b, i % 2 ? 'plant' : 'zombie');
    mgr.setName(b, `n${i}`);
  }
  const during = a.states().length - before;
  assert.ok(during <= 1, `at most the leading edge goes out immediately, got ${during}`);
  jump(150);
  const total = a.states().length - before;
  assert.ok(total <= 2, `burst of 600 changes -> ${total} lobbyState broadcasts`);
  const final = a.last('lobbyState').lobby.players.find((p) => p.id === 'p2');
  assert.deepEqual([final.name, final.team], ['n299', 'plant'], 'the flush carries the latest state');
  const n = a.states().length;
  jump(1000);
  assert.equal(a.states().length, n, 'nothing dirty: nothing sent');
});

test('a single change after a quiet spell goes out immediately', () => {
  const { mgr, jump } = setup();
  const a = member('p1');
  const b = member('p2');
  const lobby = mgr.create(a, {}).lobby;
  mgr.join(b, lobby.id, {});
  jump(500);
  jump(500);
  mgr.setTeam(b, 'zombie');
  assert.equal(a.last('lobbyState').lobby.players[1].team, 'zombie', 'no waiting for the next tick');
});

test('lobbyState is encoded once per broadcast: members share the view and get a spliced, valid JSON string', () => {
  const { mgr, jump } = setup();
  const [a, b, c] = ['p1', 'p2', 'p3'].map((id) => member(id));
  const lobby = mgr.create(a, {}).lobby;
  mgr.join(b, lobby.id, {});
  mgr.join(c, lobby.id, {});
  jump(500);
  jump(500);
  mgr.setTeam(c, 'zombie');
  const [sa, sb, sc] = [a, b, c].map((m) => [m.last('lobbyState'), m.jsons[m.sent.lastIndexOf(m.last('lobbyState'))]]);
  assert.equal(sa[0].lobby, sb[0].lobby, 'one shared view object');
  assert.equal(sb[0].lobby, sc[0].lobby);
  for (const [obj, json] of [sa, sb, sc]) {
    assert.equal(typeof json, 'string');
    assert.deepEqual(JSON.parse(json), obj, 'pre-encoded string matches the object');
  }
  assert.deepEqual([sa[0].you, sb[0].you, sc[0].you], ['p1', 'p2', 'p3']);
});

test('re-asking for the room state (listLobbies while seated) answers only the asker, not the whole room', () => {
  const { mgr, jump } = setup();
  const a = member('p1');
  const b = member('p2');
  const lobby = mgr.create(a, {}).lobby;
  mgr.join(b, lobby.id, {});
  jump(500);
  const na = a.states().length;
  const nb = b.states().length;
  for (let i = 0; i < 50; i++) mgr.join(b, lobby.id, {});
  jump(500);
  assert.equal(a.states().length, na, 'the host heard nothing');
  assert.ok(b.states().length > nb, 'the asker got the state');
  assert.equal(b.last('lobbyState').lobby.id, lobby.id);
});

test('a new arrival gets the room state at once even when the room was just broadcast to', () => {
  const { mgr } = setup();
  const a = member('p1');
  const b = member('p2');
  const lobby = mgr.create(a, {}).lobby;
  mgr.join(b, lobby.id, {}); // same millisecond as the create
  assert.equal(b.last('lobbyState').lobby.players.length, 2);
  assert.equal(b.last('lobbyState').you, 'p2');
});

// ---- 2. idle waiting rooms + per-IP lobby cap ----------------------------------------------------------------

test('a waiting room idle for 15 minutes is closed and its members are put back in the browser', () => {
  assert.equal(IDLE_LOBBY_MS, 15 * 60_000);
  const { mgr, jump, evicted } = setup();
  const a = member('p1');
  const b = member('p2');
  const lobby = mgr.create(a, {}).lobby;
  mgr.join(b, lobby.id, {});
  jump(IDLE_LOBBY_MS - 1000);
  assert.equal(mgr.lobbies.size, 1);
  mgr.setTeam(b, 'zombie'); // somebody is still there
  jump(IDLE_LOBBY_MS - 1000);
  assert.equal(mgr.lobbies.size, 1, 'activity restarted the clock');
  jump(2000);
  assert.equal(mgr.lobbies.size, 0);
  assert.equal(a.lobby, null);
  assert.equal(b.lobby, null);
  assert.equal(a.last('lobbyState').lobby, null);
  assert.deepEqual(evicted.sort(), [['p1', 'idle'], ['p2', 'idle']]);
  assert.deepEqual(mgr.list(), []);
});

test('idle expiry only applies to waiting rooms; a finished round restarts the idle clock', () => {
  const { mgr, jump, advance } = setup({ features: { winRules: true, initialGarden: true } });
  const a = member('p1');
  const lobby = mgr.create(a, { mode: 'versus' }).lobby;
  mgr.start(a);
  advance(0.2);
  jump(10_000);
  mgr.input(a, { keys: {}, yaw: 0, pitch: 0 });
  assert.equal(lobby.status, 'playing');
  lobby.game.roundTime = DEFAULT_CONFIG.roundLength;
  advance(0.3);
  advance(DEFAULT_CONFIG.endedTime + 1);
  assert.equal(lobby.status, 'waiting');
  jump(IDLE_LOBBY_MS - 2000);
  assert.equal(mgr.lobbies.size, 1, 'idle time counts from the return to the waiting room');
  jump(3000);
  assert.equal(mgr.lobbies.size, 0);
});

test('per-IP cap: at most 3 live lobbies created from one address; leaving frees a slot', () => {
  assert.equal(MAX_LOBBIES_PER_IP, 3);
  const { mgr } = setup();
  const ids = [];
  const ms = [];
  for (let i = 0; i < 3; i++) {
    const m = member(`p${i}`, { ip: '1.2.3.4' });
    ms.push(m);
    const r = mgr.create(m, {});
    assert.ok(!r.error, `create #${i}`);
    ids.push(r.lobby.id);
  }
  const x = member('x', { ip: '1.2.3.4' });
  const r = mgr.create(x, {});
  assert.equal(r.error, 'too_many_yours');
  assert.ok(r.message.length > 10);
  assert.equal(x.lobby, null);
  assert.ok(!mgr.create(member('y', { ip: '5.6.7.8' }), {}).error, 'another address is fine');
  assert.ok(!mgr.create(member('z'), {}).error, 'members without an address are not counted');
  mgr.leave(ms[0]); // that lobby closes
  assert.ok(!mgr.create(x, {}).error, 'a slot is free again');
});

test('per-IP cap counts lobbies, not seats: joining other people\'s lobbies is unlimited', () => {
  const { mgr } = setup();
  const host = member('h', { ip: '9.9.9.9' });
  const lobby = mgr.create(host, {}).lobby;
  for (let i = 0; i < 6; i++) assert.ok(!mgr.join(member(`j${i}`, { ip: '1.2.3.4' }), lobby.id, {}).error);
});

// ---- 3. create(): check the caps before leaving the current lobby --------------------------------------------

test('create at the global cap keeps you where you were when your lobby would not close', () => {
  const { mgr } = setup({ manager: { maxLobbies: 1 } });
  const a = member('p1');
  const b = member('p2');
  const lobby = mgr.create(a, {}).lobby;
  mgr.join(b, lobby.id, {});
  const r = mgr.create(b, { lobbyName: 'Two' });
  assert.equal(r.error, 'too_many_lobbies');
  assert.equal(b.lobby, lobby, 'still in the old lobby');
  assert.ok(lobby.members.has('p2'));
  assert.equal(lobby.members.size, 2);
});

test('create at the global cap works for the last member of a lobby: their old slot is freed', () => {
  const { mgr } = setup({ manager: { maxLobbies: 1 } });
  const a = member('p1');
  const old = mgr.create(a, {}).lobby;
  const r = mgr.create(a, { lobbyName: 'New' });
  assert.ok(!r.error);
  assert.equal(mgr.lobbies.size, 1);
  assert.equal(a.lobby, r.lobby);
  assert.notEqual(a.lobby.id, old.id);
});

test('per-IP cap is also checked before leaving, counting the slot you free', () => {
  const { mgr } = setup();
  const ms = [0, 1, 2].map((i) => member(`p${i}`, { ip: '1.1.1.1' }));
  for (const m of ms) mgr.create(m, {});
  const other = member('o', { ip: '2.2.2.2' });
  mgr.join(other, ms[0].lobby.id, {});
  // p1 is alone in their own lobby: re-creating frees it
  assert.ok(!mgr.create(ms[1], { lobbyName: 'again' }).error);
  assert.equal(mgr.lobbies.size, 3);
  // p0's lobby has a second member, so p0 re-creating would not free a slot
  const old = ms[0].lobby;
  assert.equal(mgr.create(ms[0], {}).error, 'too_many_yours');
  assert.equal(ms[0].lobby, old, 'stayed put');
});

// ---- 4. empty lobby kept for the rejoin window -------------------------------------------------------------------

test('last member drops (socket lost): the lobby is kept for the rejoin window, hidden, and the host gets it back', () => {
  const { mgr, jump } = setup();
  const a = member('p1', { name: 'Ann', cid: 'tok-a' });
  const lobby = mgr.create(a, { lobbyName: 'Fort', team: 'zombie' }).lobby;
  mgr.leave(a, { remember: true });
  assert.equal(mgr.lobbies.size, 1, 'kept');
  assert.equal(lobby.members.size, 0);
  assert.deepEqual(mgr.list(), [], 'not offered to anyone while nobody is in it');
  const stranger = member('s1', { cid: 'tok-s' });
  assert.equal(mgr.join(stranger, lobby.id, {}).error, 'gone', 'strangers cannot walk into it');
  assert.equal(stranger.lobby, null);

  jump(REJOIN_WINDOW_MS - 5000);
  assert.equal(mgr.lobbies.size, 1);
  const a2 = member('p9', { name: 'Ann', cid: 'tok-a' });
  assert.equal(mgr.rejoin(a2), lobby);
  assert.equal(lobby.hostId, 'p9', 'the returning host is host again');
  assert.equal(a2.team, 'zombie');
  const st = a2.last('lobbyState');
  assert.equal(st.lobby.id, lobby.id);
  assert.equal(st.lobby.name, 'Fort');
  assert.equal(st.lobby.host, 'p9');
  assert.equal(mgr.list().length, 1);
  jump(REJOIN_WINDOW_MS); // well past the old deadline: someone is in it, so it stays
  assert.equal(mgr.lobbies.size, 1);
});

test('an unclaimed kept lobby closes when the rejoin window ends', () => {
  const { mgr, jump } = setup();
  const a = member('p1', { cid: 'tok-a' });
  mgr.create(a, {});
  mgr.leave(a, { remember: true });
  jump(REJOIN_WINDOW_MS - 1000);
  assert.equal(mgr.lobbies.size, 1);
  jump(2000);
  assert.equal(mgr.lobbies.size, 0);
  assert.equal(mgr.rejoin(member('p2', { cid: 'tok-a' })), null);
});

test('a clean Leave (or no client token) still closes the empty lobby at once', () => {
  const { mgr } = setup();
  const a = member('p1', { cid: 'tok-a' });
  mgr.create(a, {});
  mgr.leave(a);
  assert.equal(mgr.lobbies.size, 0);
  const b = member('p2', { cid: null });
  mgr.create(b, {});
  mgr.leave(b, { remember: true });
  assert.equal(mgr.lobbies.size, 0, 'nothing to rejoin with');
});

test('a solo game that loses its only player is paused: back to the waiting room, no ticking, host returns to it', () => {
  const { mgr, advance } = setup();
  const a = member('p1', { cid: 'tok-a' });
  const lobby = mgr.create(a, { mode: 'versus', team: 'zombie' }).lobby;
  mgr.start(a);
  advance(0.5);
  mgr.leave(a, { remember: true });
  assert.equal(lobby.status, 'waiting');
  assert.equal(lobby.game.phase, 'lobby');
  const t = lobby.game.time;
  advance(2);
  assert.equal(lobby.game.time, t, 'not ticked while empty');
  const a2 = member('p2', { cid: 'tok-a' });
  assert.equal(mgr.rejoin(a2), lobby);
  assert.equal(lobby.mode, 'versus');
  assert.equal(a2.last('lobbyState').lobby.status, 'waiting');
  assert.equal(a2.team, 'zombie');
  assert.ok(!mgr.start(a2).error, 'and can start again as host');
  assert.equal(lobby.game.humans().length, 1);
});

test('everyone dropped at once: the first to come back is host', () => {
  const { mgr } = setup();
  const a = member('p1', { cid: 'tok-a' });
  const b = member('p2', { cid: 'tok-b' });
  const lobby = mgr.create(a, {}).lobby;
  mgr.join(b, lobby.id, {});
  mgr.leave(a, { remember: true });
  mgr.leave(b, { remember: true });
  assert.equal(mgr.lobbies.size, 1);
  const b2 = member('p3', { cid: 'tok-b' });
  const a2 = member('p4', { cid: 'tok-a' });
  assert.equal(mgr.rejoin(b2), lobby);
  assert.equal(mgr.rejoin(a2), lobby);
  assert.equal(lobby.hostId, 'p3');
  assert.deepEqual([...lobby.members.keys()], ['p3', 'p4']);
});

// ---- 5. round end inside the catch-up loop ---------------------------------------------------------------------------

test('the round ending partway through a catch-up step never fans out the empty lobby snapshot', () => {
  const { mgr, clock, advance } = setup({ features: { winRules: true, initialGarden: true } });
  const a = member('p1');
  const lobby = mgr.create(a, { mode: 'versus' }).lobby;
  mgr.start(a);
  advance(0.2);
  lobby.game.roundTime = DEFAULT_CONFIG.roundLength;
  advance(0.2);
  assert.equal(lobby.game.phase, 'ended');
  lobby.game.endTimer = STEP * 2.5; // runs out on the 3rd tick of the next step
  lobby.snapAcc = 0.01; // snapshots are due on the 2nd and 3rd of those ticks (1.5 ticks per snapshot)
  const phasesBefore = a.snaps().length;
  clock.t += 120;
  mgr.step(clock.t);
  assert.equal(lobby.status, 'waiting');
  const fresh = a.snaps().slice(phasesBefore).map((s) => s.phase);
  assert.ok(!fresh.includes('lobby'), `phases fanned out: ${fresh}`);
  assert.equal(a.last('lobbyState').lobby.status, 'waiting');
  const after = a.raws.length;
  advance(1);
  assert.equal(a.raws.length, after, 'and nothing more is sent while waiting');
});
