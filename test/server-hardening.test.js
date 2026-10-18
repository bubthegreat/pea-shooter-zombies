// Abuse-resistance of the WebSocket server: slow readers, heartbeat, per-IP caps, message rates, idle rooms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, clientIp, MAX_SOCKETS_PER_IP } from '../server/index.js';
import { MAX_LOBBIES_PER_IP } from '../server/lobby.js';
import { connect, waitFor, until, sleep, soloGame } from './ws-helpers.js';

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

const xff = (ip) => ({ headers: { 'X-Forwarded-For': ip } });
const HUGE = 64 * 1024 * 1024;

/** The server-side socket for the nth connection (connection order). */
const serverSocket = (srv, n = 0) => [...srv.wss.clients][n];
const pretendSlowReader = (sws) => Object.defineProperty(sws, 'bufferedAmount', { get: () => HUGE });

// ---- 1. slow readers are cut off on every send path -------------------------------------------------------

test('a slow reader is terminated when a reliable message (lobby list) is sent to it', async () => {
  await withServer({}, async (srv, open) => {
    const ws = await open();
    await until(() => srv.wss.clients.size === 1);
    pretendSlowReader(serverSocket(srv));
    ws.say({ t: 'listLobbies', cid: 'A' });
    await until(() => ws.closed, 1500);
  });
});

test('a slow reader is terminated when the live lobby list is pushed to it', async () => {
  await withServer({}, async (srv, open) => {
    const browser = await open();
    const maker = await open();
    browser.say({ t: 'listLobbies', cid: 'B' });
    await waitFor(browser, (m) => m.t === 'lobbies');
    pretendSlowReader(serverSocket(srv, 0));
    maker.say({ t: 'createLobby', name: 'Mk', cid: 'M' });
    await until(() => browser.closed, 1500);
    assert.equal(maker.closed, false);
  });
});

test('a slow reader in a waiting room is terminated by the next roster broadcast; the others carry on', async () => {
  await withServer({}, async (srv, open) => {
    const [a, b] = [await open(), await open()];
    a.say({ t: 'createLobby', name: 'Ann', cid: 'A' });
    const id = (await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby)).lobby.id;
    b.say({ t: 'joinLobby', lobbyId: id, name: 'Bo', cid: 'B' });
    await waitFor(b, (m) => m.t === 'lobbyState' && m.lobby?.players.length === 2);
    pretendSlowReader(serverSocket(srv, 1));
    a.say({ t: 'setTeam', team: 'zombie' });
    await until(() => b.closed, 1500);
    assert.equal(a.closed, false);
    await until(() => srv.lobbies.lobbies.get(id)?.members.size === 1, 1500);
  });
});

test('a slow reader in a running game is terminated instead of being skipped forever', async () => {
  await withServer({}, async (srv, open) => {
    const ws = await open();
    await soloGame(ws, { name: 'Slow', cid: 'S' });
    pretendSlowReader(serverSocket(srv));
    await until(() => ws.closed, 1500);
  });
});

// ---- 1b. heartbeat ignores unsolicited pongs ----------------------------------------------------------------

test('a client that never reads but spams unsolicited pongs is still dropped by the heartbeat', async () => {
  await withServer({ heartbeatMs: 100 }, async (srv, open) => {
    const ws = await open({ autoPong: false });
    const spam = setInterval(() => {
      try {
        ws.pong();
      } catch {
        // closed
      }
    }, 5);
    try {
      await until(() => ws.closed, 1500);
    } finally {
      clearInterval(spam);
    }
  });
});

test('a client that answers pings stays connected across many heartbeats', async () => {
  await withServer({ heartbeatMs: 60 }, async (srv, open) => {
    const ws = await open();
    await sleep(500);
    assert.equal(ws.closed, false);
    assert.equal(srv.wss.clients.size, 1);
  });
});

// ---- 2. client address + per-IP caps ----------------------------------------------------------------------------

test('clientIp: last X-Forwarded-For entry, else the socket address', () => {
  const req = (headers, remoteAddress = '10.1.1.1') => ({ headers, socket: { remoteAddress } });
  assert.equal(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' })), '203.0.113.7', 'spoofed leading entry ignored');
  assert.equal(clientIp(req({ 'x-forwarded-for': '  203.0.113.7  ' })), '203.0.113.7');
  assert.equal(clientIp(req({})), '10.1.1.1');
  assert.equal(clientIp(req({ 'x-forwarded-for': '' })), '10.1.1.1');
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4, ' })), '10.1.1.1', 'empty last entry: fall back');
  assert.equal(clientIp(req({}, '::ffff:192.0.2.5')), '192.0.2.5');
  assert.equal(clientIp({ headers: {}, socket: {} }), 'unknown');
  assert.ok(clientIp(req({ 'x-forwarded-for': 'x'.repeat(500) })).length <= 64);
});

test('at most 8 concurrent sockets per address (X-Forwarded-For); other addresses and freed slots are fine', async () => {
  assert.equal(MAX_SOCKETS_PER_IP, 8);
  await withServer({}, async (srv, open) => {
    const mine = [];
    for (let i = 0; i < MAX_SOCKETS_PER_IP; i++) mine.push(await open(xff('203.0.113.1')));
    const extra = await open(xff('203.0.113.1, 10.0.0.9'));
    await until(() => extra.closed, 1500);
    assert.ok(mine.every((w) => !w.closed));
    const other = await open(xff('203.0.113.2'));
    await sleep(100);
    assert.equal(other.closed, false);
    mine[0].close();
    await until(() => mine[0].closed && srv.wss.clients.size === MAX_SOCKETS_PER_IP, 1500);
    const again = await open(xff('203.0.113.1'));
    await sleep(100);
    assert.equal(again.closed, false);
  });
});

test('without X-Forwarded-For the socket address is used', async () => {
  await withServer({ maxSocketsPerIp: 2 }, async (srv, open) => {
    await open();
    await open();
    const third = await open();
    await until(() => third.closed, 1500);
  });
});

test('an over-limit socket costs nothing: no client record, and its messages are ignored', async () => {
  await withServer({ maxSocketsPerIp: 1 }, async (srv, open) => {
    const a = await open();
    const b = await open();
    b.say({ t: 'createLobby', name: 'Nope', cid: 'B' });
    await until(() => b.closed, 1500);
    assert.equal(srv.lobbies.lobbies.size, 0);
    assert.equal(a.closed, false);
  });
});

test('at most 3 live lobbies per address; a 4th is refused with a friendly message, other addresses are fine', async () => {
  assert.equal(MAX_LOBBIES_PER_IP, 3);
  await withServer({}, async (srv, open) => {
    const socks = [];
    for (let i = 0; i < 3; i++) {
      const ws = await open(xff('198.51.100.4'));
      ws.say({ t: 'createLobby', name: `K${i}`, cid: `c${i}` });
      await waitFor(ws, (m) => m.t === 'lobbyState' && m.lobby);
      socks.push(ws);
    }
    const fourth = await open(xff('198.51.100.4'));
    fourth.say({ t: 'createLobby', name: 'K3', cid: 'c3' });
    const err = await waitFor(fourth, (m) => m.t === 'error');
    assert.equal(err.reason, 'too_many_yours');
    assert.ok(err.message);
    assert.equal(srv.lobbies.lobbies.size, 3);
    const stranger = await open(xff('198.51.100.5'));
    stranger.say({ t: 'createLobby', name: 'Fine', cid: 'c9' });
    await waitFor(stranger, (m) => m.t === 'lobbyState' && m.lobby);
    // leaving closes one of mine, freeing a slot
    socks[0].say({ t: 'leaveLobby' });
    await waitFor(socks[0], (m) => m.t === 'lobbyState' && m.lobby === null);
    fourth.say({ t: 'createLobby', name: 'K3', cid: 'c3' });
    await waitFor(fourth, (m) => m.t === 'lobbyState' && m.lobby);
  });
});

// ---- 2b. idle waiting rooms --------------------------------------------------------------------------------------

test('an idle waiting room is closed and its occupant told, with the lobby list', async () => {
  await withServer({ idleLobbyMs: 250 }, async (srv, open) => {
    const ws = await open();
    ws.say({ t: 'createLobby', name: 'Zzz', cid: 'Z' });
    await waitFor(ws, (m) => m.t === 'lobbyState' && m.lobby);
    const gone = await waitFor(ws, (m) => m.t === 'lobbyState' && m.lobby === null, 3000);
    assert.equal(gone.lobby, null);
    const err = await waitFor(ws, (m) => m.t === 'error');
    assert.equal(err.reason, 'idle');
    const list = await waitFor(ws, (m) => m.t === 'lobbies' && ws.messages.indexOf(m) > ws.messages.indexOf(gone));
    assert.deepEqual(list.lobbies, []);
    assert.equal(srv.lobbies.lobbies.size, 0);
  });
});

// ---- 4. a solo host reconnecting ----------------------------------------------------------------------------------------

test('a solo host whose socket dies slips back into the same lobby, and is host again', async () => {
  await withServer({}, async (srv, open) => {
    const a = await open();
    a.say({ t: 'createLobby', name: 'Ann', lobbyName: 'Mine', cid: 'tok-a' });
    const first = await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby);
    a.terminate();
    await until(() => srv.lobbies.lobbies.get(first.lobby.id)?.members.size === 0, 1500);
    assert.equal(srv.lobbies.lobbies.size, 1, 'kept for the rejoin window');
    const b = await open();
    b.say({ t: 'listLobbies', cid: 'tok-a', name: 'Ann' });
    const st = await waitFor(b, (m) => m.t === 'lobbyState' && m.lobby);
    assert.equal(st.lobby.id, first.lobby.id);
    assert.equal(st.lobby.name, 'Mine');
    assert.equal(st.lobby.host, st.you);
    assert.ok(!b.messages.some((m) => m.t === 'lobbies'), 'no browser list: straight back into the room');
  });
});

// ---- 6. message rates -----------------------------------------------------------------------------------------------------

test('input beyond ~60/s is dropped; a normal 30 Hz stream is not', async () => {
  await withServer({}, async (srv, open) => {
    const ws = await open();
    await soloGame(ws, { name: 'Fast', cid: 'F' });
    let n = 0;
    const real = srv.lobbies.input.bind(srv.lobbies);
    srv.lobbies.input = (m, msg) => {
      n++;
      return real(m, msg);
    };
    const input = { t: 'input', keys: { f: true }, yaw: 0, pitch: 0 };
    for (let i = 0; i < 150; i++) ws.say(input);
    await sleep(300);
    assert.ok(n >= 55 && n <= 90, `accepted ${n} of 150 sent in a burst`);
    assert.equal(ws.closed, false, '150 messages is under the hard cap');
    await sleep(1100); // let the bucket refill
    n = 0;
    for (let i = 0; i < 20; i++) {
      ws.say(input);
      await sleep(33);
    }
    assert.equal(n, 20, 'a steady 30 Hz stream gets through untouched');
  });
});

test('more than ~200 messages/s of anything gets the socket terminated', async () => {
  await withServer({}, async (srv, open) => {
    const ws = await open();
    for (let i = 0; i < 600; i++) ws.say({ t: 'nonsense', i });
    await until(() => ws.closed, 1500);
  });
});

test('junk and oversized frames count towards the message cap too', async () => {
  await withServer({}, async (srv, open) => {
    const ws = await open();
    for (let i = 0; i < 600; i++) ws.send('{not json');
    await until(() => ws.closed, 1500);
  });
});

// ---- 1c. state bursts over the wire --------------------------------------------------------------------------------------

test('a client toggling its team in a burst does not make the room re-broadcast per message', async () => {
  await withServer({}, async (srv, open) => {
    const [a, b] = [await open(), await open()];
    a.say({ t: 'createLobby', name: 'Ann', cid: 'A' });
    const id = (await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby)).lobby.id;
    b.say({ t: 'joinLobby', lobbyId: id, name: 'Bo', cid: 'B' });
    await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby?.players.length === 2);
    await sleep(300);
    const mark = a.messages.length;
    for (let i = 0; i < 20; i++) b.say({ t: 'setTeam', team: i % 2 ? 'plant' : 'zombie' });
    await waitFor(a, (m) => m.t === 'lobbyState' && m.lobby?.players[1]?.team === 'plant' && a.messages.indexOf(m) >= mark);
    await sleep(400);
    const got = a.messages.slice(mark).filter((m) => m.t === 'lobbyState').length;
    assert.ok(got <= 3, `20 setTeam -> ${got} lobbyState`);
    assert.equal(a.last('lobbyState').lobby.players[1].team, 'plant');
  });
});
