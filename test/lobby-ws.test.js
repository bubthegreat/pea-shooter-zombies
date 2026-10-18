import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { connect, waitFor, waitNext, until, sleep } from './ws-helpers.js';

async function withServer(opts, fn) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', ...opts });
  const sockets = [];
  const open = async (o) => {
    const ws = await connect(srv, o);
    sockets.push(ws);
    return ws;
  };
  try {
    await fn(srv, open);
  } finally {
    for (const ws of sockets) ws.close();
    await sleep(30);
    await srv.close();
  }
}

test('browser: listLobbies answers with the live list; creating shows up for other browsers without asking again', async () => {
  await withServer({}, async (srv, open) => {
    const a = await open();
    const b = await open();
    a.say({ t: 'listLobbies', cid: 'A', name: 'Ann' });
    b.say({ t: 'listLobbies', cid: 'B', name: 'Bo' });
    const first = await waitFor(b, (m) => m.t === 'lobbies');
    assert.deepEqual(first.lobbies, []);
    a.say({ t: 'createLobby', name: 'Ann', lobbyName: 'Fun Club', mode: 'versus', difficulty: 'easy', team: 'zombie', cid: 'A' });
    const st = await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby);
    assert.equal(st.lobby.name, 'Fun Club');
    assert.equal(st.lobby.hostName, 'Ann');
    assert.equal(st.you, st.lobby.host);
    const pushed = await waitFor(b, (m) => m.t === 'lobbies' && m.lobbies.length === 1);
    const row = pushed.lobbies[0];
    assert.deepEqual(
      { name: row.name, host: row.host, players: row.players, mode: row.mode, difficulty: row.difficulty, status: row.status },
      { name: 'Fun Club', host: 'Ann', players: 1, mode: 'versus', difficulty: 'easy', status: 'waiting' },
    );
    // a creator is no longer a browser: they do not get list pushes
    const count = a.messages.filter((m) => m.t === 'lobbies').length;
    b.say({ t: 'joinLobby', lobbyId: row.id, name: 'Bo', team: 'plant' });
    await waitFor(b, (m) => m.t === 'lobbyState' && m.lobby?.players.length === 2);
    await sleep(700);
    assert.equal(a.messages.filter((m) => m.t === 'lobbies').length, count);
  });
});

test('3 clients: create, join, non-host cannot start, host starts, everyone is in the game', async () => {
  await withServer({}, async (srv, open) => {
    const [a, b, c] = [await open(), await open(), await open()];
    a.say({ t: 'createLobby', name: 'Ann', lobbyName: 'Test', mode: 'versus', team: 'plant', cid: 'A' });
    const created = await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby);
    const id = created.lobby.id;
    b.say({ t: 'joinLobby', lobbyId: id, name: 'Bo', team: 'zombie', cid: 'B' });
    c.say({ t: 'joinLobby', lobbyId: id, name: 'Cy', team: 'zombie', cid: 'C' });
    await waitFor(c, (m) => m.t === 'lobbyState' && m.lobby?.players.length === 3);

    b.say({ t: 'startGame' });
    const err = await waitFor(b, (m) => m.t === 'error');
    assert.equal(err.reason, 'not_host');
    b.say({ t: 'setOptions', mode: 'coop' });
    await waitNext(b, (m) => m.t === 'error');
    assert.equal(srv.lobbies.lobbies.get(id).mode, 'versus');
    assert.equal(srv.lobbies.lobbies.get(id).status, 'waiting');

    a.say({ t: 'startGame' });
    for (const ws of [a, b, c]) {
      const w = await waitFor(ws, (m) => m.t === 'welcome');
      assert.equal(typeof w.id, 'string');
      assert.equal(w.config.eyeHeight, 1.6);
      assert.ok(!('maxPlayers' in w.config));
    }
    const wa = a.last('welcome');
    const snap = await waitFor(c, (m) => m.t === 'snap' && m.entities.filter((e) => e.kind === 'player').length === 3);
    assert.equal(snap.phase, 'playing');
    assert.deepEqual(snap.entities.filter((e) => e.kind === 'player').map((e) => e.name).sort(), ['Ann', 'Bo', 'Cy']);
    assert.equal(snap.entities.find((e) => e.id === wa.id).team, 'plant');

    // movement over the wire
    const z0 = snap.entities.find((e) => e.id === wa.id).z;
    for (let i = 0; i < 15; i++) {
      a.say({ t: 'input', seq: i, keys: { f: true, b: false, l: false, r: false, jump: false }, yaw: 0, pitch: 0, fire: false, use: false, plant: 0 });
      await sleep(33);
    }
    await waitFor(a, (m) => m.t === 'snap' && m.entities.find((e) => e.id === wa.id)?.z < z0 - 1);
  });
});

test('two lobbies at once: snapshots stay inside their own lobby', async () => {
  await withServer({}, async (srv, open) => {
    const [a, b] = [await open(), await open()];
    const wa = await (async () => {
      a.say({ t: 'createLobby', name: 'Ann', cid: 'A' });
      await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby);
      a.say({ t: 'startGame' });
      return waitFor(a, (m) => m.t === 'welcome');
    })();
    b.say({ t: 'createLobby', name: 'Bo', cid: 'B' });
    await waitFor(b, (m) => m.t === 'lobbyState' && m.lobby);
    b.say({ t: 'startGame' });
    const wb = await waitFor(b, (m) => m.t === 'welcome');
    assert.notEqual(wa.id, wb.id);
    await waitFor(b, (m) => m.t === 'snap' && m.entities.some((e) => e.id === wb.id));
    await waitFor(a, (m) => m.t === 'snap');
    await sleep(200);
    for (const s of a.messages.filter((m) => m.t === 'snap')) assert.ok(!s.entities.some((e) => e.id === wb.id));
    for (const s of b.messages.filter((m) => m.t === 'snap')) assert.ok(!s.entities.some((e) => e.id === wa.id));
    assert.equal(srv.lobbies.lobbies.size, 2);
  });
});

test('host leaves: the next player is host; last one out closes the lobby; list updates', async () => {
  await withServer({}, async (srv, open) => {
    const [a, b, watcher] = [await open(), await open(), await open()];
    watcher.say({ t: 'listLobbies', cid: 'W' });
    a.say({ t: 'createLobby', name: 'Ann', cid: 'A' });
    const id = (await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby)).lobby.id;
    b.say({ t: 'joinLobby', lobbyId: id, name: 'Bo', cid: 'B' });
    await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby?.players.length === 2);
    a.say({ t: 'leaveLobby' });
    const st = await waitFor(b, (m) => m.t === 'lobbyState' && m.lobby?.players.length === 1);
    assert.equal(st.lobby.hostName, 'Bo');
    assert.equal(st.lobby.host, st.you);
    const back = await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby === null);
    assert.equal(back.lobby, null);
    // the leaver is back in the browser and gets the list
    const out = a.messages.findIndex((m) => m.t === 'lobbyState' && m.lobby === null);
    const list = await waitFor(a, (m) => m.t === 'lobbies' && a.messages.indexOf(m) > out);
    assert.equal(list.lobbies.length, 1);
    b.close();
    await until(() => srv.lobbies.lobbies.size === 0);
    await waitFor(watcher, (m) => m.t === 'lobbies' && m.lobbies.length === 0 && watcher.messages.filter((x) => x.t === 'lobbies' && x.lobbies.length === 1).length > 0);
  });
});

test('round end: back to the waiting room with teams kept', async () => {
  const config = { ...DEFAULT_CONFIG, endedTime: 0.4 };
  await withServer({ config }, async (srv, open) => {
    const [a, b] = [await open(), await open()];
    a.say({ t: 'createLobby', name: 'Ann', mode: 'versus', team: 'plant', cid: 'A' });
    const id = (await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby)).lobby.id;
    b.say({ t: 'joinLobby', lobbyId: id, name: 'Bo', team: 'zombie', cid: 'B' });
    await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby?.players.length === 2);
    a.say({ t: 'startGame' });
    await waitFor(b, (m) => m.t === 'welcome');
    const lobby = srv.lobbies.lobbies.get(id);
    lobby.game.roundTime = config.roundLength; // sunrise
    await waitFor(b, (m) => m.t === 'snap' && m.phase === 'ended');
    const endedAt = b.messages.findIndex((x) => x.t === 'snap' && x.phase === 'ended');
    const st = await waitFor(b, (m) => m.t === 'lobbyState' && m.lobby?.status === 'waiting' && b.messages.indexOf(m) > endedAt);
    assert.deepEqual(st.lobby.players.map((p) => [p.name, p.team]), [['Ann', 'plant'], ['Bo', 'zombie']]);
    const n = b.messages.filter((m) => m.t === 'snap').length;
    await sleep(200);
    assert.equal(b.messages.filter((m) => m.t === 'snap').length, n, 'no snapshots in the waiting room');
    a.say({ t: 'startGame' });
    const w2 = await waitNext(b, (m) => m.t === 'welcome');
    const at = b.messages.indexOf(w2);
    await waitFor(b, (m) => m.t === 'snap' && m.phase === 'playing' && m.roundTime < 2 && b.messages.indexOf(m) > at);
  });
});

test('joining a game in progress drops you straight in', async () => {
  await withServer({}, async (srv, open) => {
    const [a, b] = [await open(), await open()];
    a.say({ t: 'createLobby', name: 'Ann', cid: 'A' });
    const id = (await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby)).lobby.id;
    a.say({ t: 'startGame' });
    await waitFor(a, (m) => m.t === 'welcome');
    await sleep(150);
    b.say({ t: 'joinLobby', lobbyId: id, name: 'Zed', team: 'zombie', cid: 'B' });
    const w = await waitFor(b, (m) => m.t === 'welcome');
    const snap = await waitFor(b, (m) => m.t === 'snap' && m.entities.some((e) => e.id === w.id));
    assert.equal(snap.entities.find((e) => e.id === w.id).team, 'zombie');
    assert.ok(snap.roundTime > 0.05, 'round kept running');
    const list = await waitFor(b, (m) => m.t === 'lobbyState');
    assert.equal(list.lobby.status, 'playing');
  });
});

test('names: setName works in the waiting room and mid-game and is sanitized', async () => {
  await withServer({}, async (srv, open) => {
    const [a, b] = [await open(), await open()];
    a.say({ t: 'createLobby', name: 'Ann', cid: 'A' });
    const id = (await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby)).lobby.id;
    b.say({ t: 'joinLobby', lobbyId: id, name: 'Bo', cid: 'B' });
    await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby?.players.length === 2);
    const ctl = String.fromCharCode(0, 7);
    b.say({ t: 'setName', name: `  ${ctl}Bobby${'z'.repeat(30)}` });
    const st = await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby?.players[1]?.name.startsWith('Bobby'));
    assert.equal(st.lobby.players[1].name, `Bobby${'z'.repeat(11)}`);
    a.say({ t: 'startGame' });
    const w = await waitFor(b, (m) => m.t === 'welcome');
    b.say({ t: 'setName', name: 'Robert' });
    await waitFor(a, (m) => m.t === 'snap' && m.entities.find((e) => e.id === w.id)?.name === 'Robert');
    b.say({ t: 'setName', name: '' });
    await waitFor(a, (m) => m.t === 'snap' && m.entities.find((e) => e.id === w.id)?.name === 'Player');
  });
});

test('caps: 20 lobbies and 50 players are enforced (small caps via options)', async () => {
  await withServer({ maxLobbies: 2, maxPlayersPerLobby: 2 }, async (srv, open) => {
    const [a, b, c, d] = [await open(), await open(), await open(), await open()];
    a.say({ t: 'createLobby', name: 'A', cid: 'A' });
    const id = (await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby)).lobby.id;
    b.say({ t: 'createLobby', name: 'B', cid: 'B' });
    await waitFor(b, (m) => m.t === 'lobbyState' && m.lobby);
    c.say({ t: 'createLobby', name: 'C', cid: 'C' });
    assert.equal((await waitFor(c, (m) => m.t === 'error')).reason, 'too_many_lobbies');
    c.say({ t: 'joinLobby', lobbyId: id, name: 'C', cid: 'C' });
    await waitFor(c, (m) => m.t === 'lobbyState' && m.lobby);
    d.say({ t: 'joinLobby', lobbyId: id, name: 'D', cid: 'D' });
    assert.equal((await waitFor(d, (m) => m.t === 'error')).reason, 'lobby_full');
    d.say({ t: 'joinLobby', lobbyId: 'nope', name: 'D' });
    await waitNext(d, (m) => m.t === 'error' && m.reason === 'gone');
  });
});

test('reconnect: the same client token slips back into its lobby; ghosts are replaced', async () => {
  await withServer({}, async (srv, open) => {
    const [a, b] = [await open(), await open()];
    a.say({ t: 'createLobby', name: 'Ann', cid: 'tok-a' });
    const id = (await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby)).lobby.id;
    b.say({ t: 'joinLobby', lobbyId: id, name: 'Bo', team: 'zombie', cid: 'tok-b' });
    await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby?.players.length === 2);
    a.say({ t: 'startGame' });
    await waitFor(b, (m) => m.t === 'welcome');
    // b's page reconnects on a fresh socket while the old one is still half-open
    const b2 = await open();
    b2.say({ t: 'listLobbies', cid: 'tok-b', name: 'Bo' });
    const w = await waitFor(b2, (m) => m.t === 'welcome');
    const st = await waitFor(b2, (m) => m.t === 'lobbyState' && m.lobby);
    assert.equal(st.lobby.id, id);
    assert.equal(st.lobby.status, 'playing');
    assert.equal(st.lobby.players.find((p) => p.id === w.id).team, 'zombie');
    assert.equal(st.lobby.players.length, 2, 'ghost removed, no duplicate');
    await until(() => b.closed);
    // a clean Leave is final: reconnecting does not put you back
    b2.say({ t: 'leaveLobby' });
    await waitFor(b2, (m) => m.t === 'lobbyState' && m.lobby === null);
    const b3 = await open();
    b3.say({ t: 'listLobbies', cid: 'tok-b', name: 'Bo' });
    const list = await waitFor(b3, (m) => m.t === 'lobbies');
    assert.equal(list.lobbies.length, 1);
    assert.ok(!b3.messages.some((m) => m.t === 'welcome'));
  });
});

test('junk: old join, bad ids, oversized and non-object messages are ignored', async () => {
  await withServer({}, async (srv, open) => {
    const a = await open();
    a.say({ t: 'join', name: 'Old', team: 'plant' }); // removed from the protocol
    a.say({ t: 'joinLobby', lobbyId: { x: 1 } });
    a.say({ t: 'joinLobby' });
    a.say({ t: 'createLobby', lobbyName: 'x'.repeat(8000) });
    a.say({ t: 'startGame' });
    a.say({ t: 'setTeam', team: 'plant' });
    a.say({ t: 'input', keys: 'bad' });
    a.say({ t: 'createLobby', name: 42, lobbyName: ['x'], mode: {}, difficulty: 5, team: null, cid: 7 });
    const st = await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby);
    assert.equal(st.lobby.hostName, 'Player');
    assert.equal(st.lobby.name, "Player's Backyard");
    assert.ok(!a.messages.some((m) => m.t === 'welcome'));
    assert.equal(srv.lobbies.lobbies.size, 1);
  });
});
