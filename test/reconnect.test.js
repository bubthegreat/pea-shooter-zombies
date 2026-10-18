import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, HEARTBEAT_MS } from '../server/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(srv, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`, opts);
    ws.messages = [];
    ws.closed = false;
    ws.on('message', (d) => ws.messages.push(JSON.parse(d.toString())));
    ws.on('close', () => {
      ws.closed = true;
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function until(pred, ms = 3000) {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > ms) throw new Error('timeout');
    await sleep(15);
  }
}

test('a half-open client (never answers pings) is dropped within a couple of heartbeats', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', heartbeatMs: 100 });
  try {
    const ws = await connect(srv, { autoPong: false });
    ws.send(JSON.stringify({ t: 'join', name: 'Ghost', team: 'plant', mode: 'coop' }));
    await until(() => ws.messages.some((m) => m.t === 'welcome'));
    assert.equal(srv.game.humans().length, 1);
    await until(() => srv.game.humans().length === 0, 1500);
    await until(() => ws.closed, 1500);
  } finally {
    await srv.close();
  }
});

test('the default heartbeat gives a worst case of ~6 s for a dead socket', () => {
  // a client is dropped when it misses one ping round: up to two periods after it went silent
  assert.ok(HEARTBEAT_MS * 2 <= 6000, `heartbeat ${HEARTBEAT_MS} ms`);
});

test('rejoining with the same client token replaces the ghost instead of hitting "full"', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const a = await connect(srv);
    a.send(JSON.stringify({ t: 'join', name: 'Kid', team: 'plant', mode: 'versus', cid: 'tok-1' }));
    await until(() => a.messages.some((m) => m.t === 'welcome'));
    const other = await connect(srv);
    other.send(JSON.stringify({ t: 'join', name: 'Other', team: 'zombie', cid: 'tok-2' }));
    await until(() => other.messages.some((m) => m.t === 'welcome'));
    assert.equal(srv.game.humans().length, 2);

    // a's socket is still "open" server-side (half-open), but the page retries on a fresh socket
    const b = await connect(srv);
    b.send(JSON.stringify({ t: 'join', name: 'Kid', team: 'zombie', mode: 'versus', cid: 'tok-1' }));
    await until(() => b.messages.some((m) => m.t === 'welcome' || m.t === 'error'));
    assert.ok(b.messages.some((m) => m.t === 'welcome'), `joined: ${JSON.stringify(b.messages[0])}`);
    assert.equal(srv.game.humans().length, 2, 'ghost removed, no duplicate');
    await until(() => a.closed, 1500);
    const names = srv.game.humans().map((h) => h.name).sort();
    assert.deepEqual(names, ['Kid', 'Other']);

    // a different token is still told the game is full
    const c = await connect(srv);
    c.send(JSON.stringify({ t: 'join', name: 'Third', team: 'plant', cid: 'tok-3' }));
    await until(() => c.messages.some((m) => m.t === 'error'));
    assert.equal(c.messages.find((m) => m.t === 'error').reason, 'full');
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
      w.send(JSON.stringify({ t: 'join', name: 'J', team: 'plant', mode: 'coop', cid }));
      await until(() => w.messages.some((m) => m.t === 'welcome' || m.t === 'error'));
      assert.ok(w.messages.some((m) => m.t === 'welcome'));
      w.close();
      await until(() => srv.game.humans().length === 0);
    }
  } finally {
    await srv.close();
  }
});
