// HTTP static server + WebSocket game server. `npm start` runs this file.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from './sim/config.js';
import { sanitizeName } from './sim/names.js';
import { LobbyManager, MAX_LOBBIES, MAX_PLAYERS_PER_LOBBY } from './lobby.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CLIENT_DIR = path.join(ROOT, 'client');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');

const DEFAULT_PORT = 8080;
const MAX_MESSAGE_BYTES = 4096; // larger client messages are ignored
const HARD_MAX_PAYLOAD = 16 * 1024; // ws closes connections that exceed this
const LIST_PUSH_MS = 500; // how often the live lobby list is re-checked (round timers tick every second)
const MANAGE_PER_SEC = 10; // lobby-management messages per client: sustained rate...
const MANAGE_BURST = 20; // ...and burst
export const HEARTBEAT_MS = 3000; // ping period; a client that misses one ping round is dropped, so ~6 s worst case
const MAX_CID_LENGTH = 64;
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
 * Options: port (default $PORT or 8080), host (default 0.0.0.0), clientDir, config, rng, log, heartbeatMs,
 * maxLobbies / maxPlayersPerLobby (hidden safety caps, tests lower them).
 */
export function startServer(opts = {}) {
  const {
    port = parsePort(process.env.PORT),
    host = '0.0.0.0',
    clientDir = DEFAULT_CLIENT_DIR,
    config = DEFAULT_CONFIG,
    rng = Math.random,
    log = () => {},
    heartbeatMs = HEARTBEAT_MS,
    maxLobbies = MAX_LOBBIES,
    maxPlayersPerLobby = MAX_PLAYERS_PER_LOBBY,
  } = opts;

  const manager = new LobbyManager({ config, rng, log, maxLobbies, maxPlayers: maxPlayersPerLobby });
  const server = http.createServer(makeHttpHandler(path.resolve(clientDir)));
  const wss = new WebSocketServer({ server, maxPayload: HARD_MAX_PAYLOAD });
  const clients = new Set();
  let nextClientId = 1;
  let lastListJson = '';

  /** Forget a client; if it was in a lobby, take it out (and remember it, so the same page can slip back in). */
  function dropClient(client) {
    clients.delete(client);
    if (client.lobby) log(`player ${client.id} (${client.name}) left`);
    manager.leave(client, { remember: true });
  }

  /** A page retrying on a fresh socket (join timeout, network blip) must not be locked out by its own ghost. */
  function evictGhosts(client, cid) {
    for (const other of [...clients]) {
      if (other === client || other.cid !== cid) continue;
      dropClient(other);
      other.ws.terminate();
      log(`replaced stale connection ${other.id}`);
    }
  }

  function identify(client, cid) {
    if (client.cid !== null || typeof cid !== 'string' || cid === '' || cid.length > MAX_CID_LENGTH) return;
    client.cid = cid;
    evictGhosts(client, cid);
  }

  /** Send the lobby list to everyone who is browsing, but only when it changed. */
  function pushList(force = false) {
    const json = JSON.stringify({ t: 'lobbies', lobbies: manager.list() });
    if (!force && json === lastListJson) return;
    lastListJson = json;
    for (const c of clients) if (c.browsing && !c.lobby && c.ws.readyState === c.ws.OPEN) c.ws.send(json);
  }

  function sendList(client) {
    client.browsing = true;
    client.send({ t: 'lobbies', lobbies: manager.list() });
  }

  function reply(client, res) {
    if (res.error) client.send({ t: 'error', reason: res.error, message: res.message });
    if (!client.lobby) sendList(client); // not in a lobby (any more): show the list
    else client.browsing = false;
  }

  /** Lobby-management messages are rate limited (input is not): ~10/s sustained. */
  function allowManagement(client, now) {
    client.tokens = Math.min(MANAGE_BURST, client.tokens + ((now - client.tokensAt) / 1000) * MANAGE_PER_SEC);
    client.tokensAt = now;
    if (client.tokens < 1) return false;
    client.tokens -= 1;
    return true;
  }

  function onMessage(client, msg) {
    if (msg.t === 'input') {
      manager.input(client, msg);
      return;
    }
    if (!allowManagement(client, performance.now())) return;
    switch (msg.t) {
      case 'listLobbies': {
        identify(client, msg.cid);
        if (!client.lobby && typeof msg.name === 'string') client.name = sanitizeName(msg.name);
        if (client.lobby) manager.join(client, client.lobby.id); // already in: just resend the room state
        else if (manager.rejoin(client)) client.browsing = false;
        else sendList(client);
        break;
      }
      case 'createLobby': {
        identify(client, msg.cid);
        reply(client, manager.create(client, { lobbyName: msg.lobbyName, mode: msg.mode, difficulty: msg.difficulty, team: msg.team, name: msg.name }));
        break;
      }
      case 'joinLobby': {
        identify(client, msg.cid);
        reply(client, manager.join(client, msg.lobbyId, { team: msg.team, name: msg.name }));
        break;
      }
      case 'leaveLobby':
        manager.leave(client);
        sendList(client);
        break;
      case 'setTeam':
        manager.setTeam(client, msg.team);
        break;
      case 'setName':
        manager.setName(client, msg.name);
        break;
      case 'setOptions': {
        const res = manager.setOptions(client, { mode: msg.mode, difficulty: msg.difficulty });
        if (res.error) client.send({ t: 'error', reason: res.error, message: res.message });
        break;
      }
      case 'startGame': {
        const res = manager.start(client);
        if (res.error) client.send({ t: 'error', reason: res.error, message: res.message });
        break;
      }
      default:
        return;
    }
    pushList();
  }

  wss.on('connection', (ws) => {
    const t0 = performance.now();
    const client = {
      ws,
      id: `p${nextClientId++}`,
      cid: null,
      name: 'Player',
      team: 'plant',
      lobby: null, // set by the LobbyManager
      browsing: false, // wants lobby-list pushes
      lastInputAt: 0,
      inputActive: false,
      alive: true,
      tokens: MANAGE_BURST,
      tokensAt: t0,
      send(obj) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
      },
      raw(str) {
        if (ws.readyState === ws.OPEN && ws.bufferedAmount <= MAX_BUFFERED_BYTES) ws.send(str);
      },
    };
    clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      dropClient(client);
      pushList();
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
        onMessage(client, msg);
      } catch (err) {
        log(`message error: ${err?.message ?? err}`);
      }
    });
  });

  // One timer drives every lobby's game (each has its own accumulator and snapshot fanout) and the live lobby list.
  const loop = setInterval(() => {
    manager.step(performance.now());
  }, Math.max(1, Math.floor(1000 / config.tickRate / 2)));
  const listTimer = setInterval(() => {
    try {
      pushList();
    } catch (err) {
      log(`list error: ${err?.message ?? err}`);
    }
  }, LIST_PUSH_MS);

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
  }, heartbeatMs);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actualPort = server.address().port;
      resolve({
        server,
        wss,
        lobbies: manager,
        port: actualPort,
        close() {
          clearInterval(loop);
          clearInterval(listTimer);
          clearInterval(heartbeat);
          for (const c of clients) c.ws.terminate();
          manager.close();
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
