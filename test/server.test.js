import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-client-'));
fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>Test</title>');
fs.writeFileSync(path.join(tmp, 'style.css'), 'body{}');
fs.writeFileSync(path.join(tmp, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
fs.mkdirSync(path.join(tmp, 'sub'));
fs.writeFileSync(path.join(tmp, 'sub', 'a.js'), 'export default 1;');

let srv;
let base;
test.before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', clientDir: tmp });
  base = `http://127.0.0.1:${srv.port}`;
});
test.after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
    ws.messages = [];
    ws.waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      ws.messages.push(m);
      ws.waiters = ws.waiters.filter((w) => !w(m));
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitFor(ws, pred, ms = 3000) {
  const found = ws.messages.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
    ws.waiters.push((m) => {
      if (!pred(m)) return false;
      clearTimeout(timer);
      resolve(m);
      return true;
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('serves client files with correct MIME types', async () => {
  let r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(await r.text(), /<title>/);
  r = await fetch(`${base}/style.css`);
  assert.match(r.headers.get('content-type'), /text\/css/);
  r = await fetch(`${base}/icon.svg`);
  assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  r = await fetch(`${base}/sub/a.js`);
  assert.match(r.headers.get('content-type'), /javascript/);
  r = await fetch(`${base}/missing.png`);
  assert.equal(r.status, 404);
  r = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(r.status, 200);
});

test('serves three.js and addons from node_modules', async () => {
  let r = await fetch(`${base}/vendor/three.module.js`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  r = await fetch(`${base}/vendor/three/addons/controls/PointerLockControls.js`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/vendor/three/addons/nope.js`);
  assert.equal(r.status, 404);
});

test('path traversal is refused', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/vendor/three/addons/../../../../package.json', '/..%2fpackage.json']) {
    const r = await fetch(`${base}${p}`);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    const body = await r.text();
    assert.ok(!body.includes('backyard-battle'), `${p} leaked file`);
  }
  // raw (unnormalized) request path
  const raw = await new Promise((resolve) => {
    import('node:net').then(({ default: net }) => {
      const s = net.connect(srv.port, '127.0.0.1', () => s.write('GET /../../package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let buf = '';
      s.on('data', (d) => (buf += d));
      s.on('close', () => resolve(buf));
    });
  });
  assert.ok(!raw.includes('backyard-battle'));
});

test('join gets welcome with config and snapshots containing the player entity', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ t: 'join', name: 'Tester', team: 'plant', mode: 'coop', difficulty: 'easy' }));
  const welcome = await waitFor(ws, (m) => m.t === 'welcome');
  assert.equal(typeof welcome.id, 'string');
  assert.equal(typeof welcome.config, 'object');
  assert.equal(welcome.config.eyeHeight, 1.6);
  const snap = await waitFor(ws, (m) => m.t === 'snap' && m.entities.some((e) => e.id === welcome.id));
  assert.equal(snap.phase, 'playing');
  const me = snap.entities.find((e) => e.id === welcome.id);
  assert.equal(me.kind, 'player');
  assert.equal(me.name, 'Tester');

  // movement over the wire
  const z0 = me.z;
  for (let i = 0; i < 15; i++) {
    ws.send(JSON.stringify({ t: 'input', seq: i, keys: { f: true, b: false, l: false, r: false, jump: false }, yaw: 0, pitch: 0, fire: false, use: false, plant: 0 }));
    await sleep(33);
  }
  const later = await waitFor(ws, (m) => m.t === 'snap' && m.entities.find((e) => e.id === welcome.id)?.z < z0 - 1);
  assert.ok(later);
  ws.close();
  await sleep(100);
});

test('malformed and oversized messages are ignored and the server keeps working', async () => {
  const ws = await connect();
  ws.send('not json');
  ws.send('{"t":');
  ws.send('null');
  ws.send('[]');
  ws.send('"str"');
  ws.send(JSON.stringify({ t: 42 }));
  ws.send(JSON.stringify({ t: 'input', yaw: 'x' })); // before join
  ws.send(Buffer.from([1, 2, 3]));
  ws.send(JSON.stringify({ t: 'join', name: 'x'.repeat(8000) })); // > 4 KB: ignored
  await sleep(150);
  assert.ok(!ws.messages.some((m) => m.t === 'welcome'), 'oversized join ignored');
  ws.send(JSON.stringify({ t: 'join', name: 'Ok', team: 'zombie', mode: 'versus', difficulty: 'normal' }));
  const welcome = await waitFor(ws, (m) => m.t === 'welcome');
  ws.send(JSON.stringify({ t: 'input', keys: 'bad', yaw: 'bad', pitch: {}, fire: [], plant: 'x' }));
  ws.send('x'.repeat(5000));
  ws.send(JSON.stringify({ t: 'join', team: 'plant' })); // double join ignored
  await sleep(150);
  const snap = await waitFor(ws, (m) => m.t === 'snap' && m.entities.some((e) => e.id === welcome.id));
  assert.equal(snap.entities.find((e) => e.id === welcome.id).team, 'zombie');
  ws.close();
  await sleep(100);
});

test('disconnect removes the entity; last human out resets to lobby; third player is told the game is full', async () => {
  const a = await connect();
  const b = await connect();
  const c = await connect();
  a.send(JSON.stringify({ t: 'join', name: 'A', team: 'plant', mode: 'versus' }));
  const wa = await waitFor(a, (m) => m.t === 'welcome');
  b.send(JSON.stringify({ t: 'join', name: 'B', team: 'zombie' }));
  const wb = await waitFor(b, (m) => m.t === 'welcome');
  c.send(JSON.stringify({ t: 'join', name: 'C', team: 'zombie' }));
  const err = await waitFor(c, (m) => m.t === 'error');
  assert.equal(err.reason, 'full');
  await waitFor(a, (m) => m.t === 'snap' && m.entities.some((e) => e.id === wb.id));

  b.close();
  await waitFor(a, (m) => m.t === 'snap' && m.entities.some((e) => e.id === wa.id) && !m.entities.some((e) => e.id === wb.id));
  assert.equal(srv.game.phase, 'playing');
  a.close();
  const start = Date.now();
  while (srv.game.phase !== 'lobby' && Date.now() - start < 2000) await sleep(20);
  assert.equal(srv.game.phase, 'lobby');
  assert.equal(srv.game.entities.size, 0);
  c.close();
});

test('stale input is released so a silent client stops moving', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ t: 'join', name: 'Idle', team: 'plant', mode: 'coop' }));
  const welcome = await waitFor(ws, (m) => m.t === 'welcome');
  ws.send(JSON.stringify({ t: 'input', keys: { f: true }, yaw: 0, pitch: 0 }));
  await sleep(1200);
  const p = srv.game.entities.get(welcome.id);
  assert.equal(p.input.keys.f, false);
  ws.close();
  await sleep(100);
});
