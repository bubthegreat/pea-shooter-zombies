import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, HEARTBEAT_MS } from '../server/index.js';
import { connect, until, sleep, soloGame, waitFor } from './ws-helpers.js';

test('a half-open client (never answers pings) is dropped within a couple of heartbeats', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', heartbeatMs: 100 });
  try {
    const ws = await connect(srv, { autoPong: false });
    await soloGame(ws, { name: 'Ghost' });
    const lobby = [...srv.lobbies.lobbies.values()][0];
    assert.equal(lobby.game.humans().length, 1);
    await until(() => srv.lobbies.lobbies.size === 0, 1500);
    await until(() => ws.closed, 1500);
  } finally {
    await srv.close();
  }
});

test('the default heartbeat gives a worst case of ~6 s for a dead socket', () => {
  // a client is dropped when it misses one ping round: up to two periods after it went silent
  assert.ok(HEARTBEAT_MS * 2 <= 6000, `heartbeat ${HEARTBEAT_MS} ms`);
});

test('a page retrying on a fresh socket with the same client token replaces its ghost, no duplicate player', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const a = await connect(srv);
    a.say({ t: 'createLobby', name: 'Kid', team: 'plant', mode: 'versus', cid: 'tok-1' });
    const id = (await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby)).lobby.id;
    const other = await connect(srv);
    other.say({ t: 'joinLobby', lobbyId: id, name: 'Other', team: 'zombie', cid: 'tok-2' });
    await waitFor(other, (m) => m.t === 'lobbyState' && m.lobby);
    a.say({ t: 'startGame' });
    await waitFor(other, (m) => m.t === 'welcome');
    const lobby = srv.lobbies.lobbies.get(id);
    assert.equal(lobby.game.humans().length, 2);

    // a's socket is still "open" server-side (half-open), but the page retries on a fresh socket
    const b = await connect(srv);
    b.say({ t: 'listLobbies', cid: 'tok-1', name: 'Kid' });
    await waitFor(b, (m) => m.t === 'welcome');
    assert.equal(lobby.game.humans().length, 2, 'ghost removed, no duplicate');
    await until(() => a.closed, 1500);
    assert.deepEqual(lobby.game.humans().map((h) => h.name).sort(), ['Kid', 'Other']);

    // a different token is simply another player: there is no cap on how many can join
    const c = await connect(srv);
    c.say({ t: 'joinLobby', lobbyId: id, name: 'Third', team: 'plant', cid: 'tok-3' });
    await waitFor(c, (m) => m.t === 'welcome');
    assert.equal(lobby.game.humans().length, 3);
    for (const w of [b, other, c]) w.close();
    await sleep(50);
  } finally {
    await srv.close();
  }
});

test('junk client tokens are ignored', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    for (const cid of [42, {}, 'x'.repeat(500), null, '']) {
      const w = await connect(srv);
      await soloGame(w, { name: 'J', cid });
      w.close();
      await until(() => srv.lobbies.lobbies.size === 0);
    }
  } finally {
    await srv.close();
  }
});
