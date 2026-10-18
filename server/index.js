// HTTP static server + WebSocket game server. `npm start` runs this file.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from './sim/game.js';
import { DEFAULT_CONFIG, publicConfig } from './sim/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CLIENT_DIR = path.join(ROOT, 'client');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');

const DEFAULT_PORT = 8080;
const MAX_MESSAGE_BYTES = 4096; // larger client messages are ignored
const HARD_MAX_PAYLOAD = 16 * 1024; // ws closes connections that exceed this
const STALE_INPUT_MS = 500; // no input for this long => release all keys
const HEARTBEAT_MS = 10000;
const MAX_CATCHUP_STEPS = 5;
const MAX_BUFFERED_BYTES = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const NEUTRAL_INPUT = { keys: { f: false, b: false, l: false, r: false, jump: false }, fire: false, use: false, plant: 0 };

/** Join `rel` under `base`, refusing anything that escapes it. */
function safeJoin(base, rel) {
  if (rel.includes('\0')) return null;
  const full = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

/** Map a URL pathname to a file path, or null. */
function resolveStatic(pathname, clientDir) {
  const addons = '/vendor/three/addons/';
  if (pathname.startsWith(addons)) {
    return safeJoin(path.join(THREE_DIR, 'examples', 'jsm'), pathname.slice(addons.length));
  }
  if (pathname.startsWith('/vendor/') && !pathname.slice(8).includes('/')) {
    return safeJoin(path.join(THREE_DIR, 'build'), pathname.slice(8));
  }
  return safeJoin(clientDir, pathname === '/' ? '/index.html' : pathname);
}

function makeHttpHandler(clientDir) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    let file = resolveStatic(pathname, clientDir);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) {
        file = path.join(file, 'index.html');
        fs.stat(file, (err2, st2) => (err2 || !st2.isFile() ? notFound(res) : sendFile(req, res, file, st2)));
        return;
      }
      if (err || !st.isFile()) return notFound(res);
      sendFile(req, res, file, st);
    });
  };
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function sendFile(req, res, file, st) {
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const vendor = file.startsWith(THREE_DIR + path.sep);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': vendor ? 'public, max-age=86400' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function lanUrls(port) {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

function parsePort(value) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_PORT;
}

/**
 * Start the game server. Resolves once listening.
 * Options: port (default $PORT or 8080), host (default 0.0.0.0), clientDir, config, rng, log.
 */
export function startServer(opts = {}) {
  const {
    port = parsePort(process.env.PORT),
    host = '0.0.0.0',
    clientDir = DEFAULT_CLIENT_DIR,
    config = DEFAULT_CONFIG,
    rng = Math.random,
    log = () => {},
  } = opts;

  const game = new Game(config, rng);
  const server = http.createServer(makeHttpHandler(path.resolve(clientDir)));
  const wss = new WebSocketServer({ server, maxPayload: HARD_MAX_PAYLOAD });
  const clients = new Set();
  let nextClientId = 1;

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  wss.on('connection', (ws) => {
    const client = { ws, id: `p${nextClientId++}`, joined: false, lastInputAt: 0, inputActive: false, alive: true };
    clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clients.delete(client);
      if (client.joined) {
        game.removePlayer(client.id);
        log(`player ${client.id} left`);
      }
    });
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary || !data || data.length > MAX_MESSAGE_BYTES) return;
        let msg;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
        if (msg.t === 'join') {
          if (client.joined) return;
          const p = game.addPlayer(client.id, { name: msg.name, team: msg.team, mode: msg.mode, difficulty: msg.difficulty });
          if (!p) {
            send(ws, { t: 'error', reason: 'full', message: 'The game is full (2 players). Try again later!' });
            return;
          }
          client.joined = true;
          client.lastInputAt = performance.now();
          send(ws, { t: 'welcome', id: client.id, config: publicConfig(game.config) });
          log(`player ${client.id} (${p.name}) joined as ${p.team}`);
        } else if (msg.t === 'input') {
          if (!client.joined) return;
          client.lastInputAt = performance.now();
          client.inputActive = true;
          game.handleInput(client.id, msg);
        }
      } catch (err) {
        log(`message error: ${err?.message ?? err}`);
      }
    });
  });

  function broadcast() {
    const snap = game.snapshot();
    game.drainEvents();
    let payload = null;
    for (const c of clients) {
      if (!c.joined || c.ws.readyState !== c.ws.OPEN || c.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      payload ??= JSON.stringify(snap);
      c.ws.send(payload);
    }
  }

  function releaseStaleInputs(now) {
    for (const c of clients) {
      if (c.joined && c.inputActive && now - c.lastInputAt > STALE_INPUT_MS) {
        c.inputActive = false;
        game.handleInput(c.id, NEUTRAL_INPUT);
      }
    }
  }

  const step = 1 / config.tickRate;
  const snapStep = 1 / config.snapRate;
  let last = performance.now();
  let acc = 0;
  let snapAcc = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    acc += Math.min((now - last) / 1000, 0.25);
    last = now;
    let steps = 0;
    while (acc >= step && steps < MAX_CATCHUP_STEPS) {
      releaseStaleInputs(now);
      game.tick(step);
      acc -= step;
      steps++;
      snapAcc += step;
      if (snapAcc >= snapStep - 1e-9) {
        snapAcc -= snapStep;
        broadcast();
      }
    }
    if (steps === MAX_CATCHUP_STEPS) acc = 0; // fell behind; drop the backlog
  }, Math.max(1, Math.floor(1000 / config.tickRate / 2)));

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        // socket already closing
      }
    }
  }, HEARTBEAT_MS);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actualPort = server.address().port;
      resolve({
        server,
        wss,
        game,
        port: actualPort,
        close() {
          clearInterval(loop);
          clearInterval(heartbeat);
          for (const c of clients) c.ws.terminate();
          return new Promise((r) => {
            wss.close(() => server.close(() => r()));
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
  startServer({ log })
    .then((s) => {
      console.log(`Backyard Battle is running!`);
      console.log(`  This computer:  http://localhost:${s.port}`);
      for (const u of lanUrls(s.port)) console.log(`  Home network:   ${u}`);
      const shutdown = () => {
        console.log('\nShutting down...');
        s.close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error(err.code === 'EADDRINUSE' ? 'That port is already in use. Set PORT=<number> to use another.' : err);
      process.exit(1);
    });
}
