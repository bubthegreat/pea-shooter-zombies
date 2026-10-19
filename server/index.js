// HTTP static server + WebSocket game server. `npm start` runs this file.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from './sim/config.js';
import { sanitizeName } from './sim/names.js';
import { LobbyManager, MAX_LOBBIES, MAX_LOBBIES_PER_IP, MAX_PLAYERS_PER_LOBBY, IDLE_LOBBY_MS } from './lobby.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CLIENT_DIR = path.join(ROOT, 'client');
const SHARED_DIR = path.join(ROOT, 'shared'); // pure modules the server and the client both run (collision, walking)
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');

const DEFAULT_PORT = 8080;
const MAX_MESSAGE_BYTES = 4096; // larger client messages are ignored
const HARD_MAX_PAYLOAD = 16 * 1024; // ws closes connections that exceed this
const LIST_PUSH_MS = 500; // how often the live lobby list is re-checked (round timers tick every second)
const LIST_MIN_GAP_MS = 100; // message-triggered list rebuilds are at most this frequent (the timer above catches up)
const MANAGE_PER_SEC = 10; // lobby-management messages per client: sustained rate...
const MANAGE_BURST = 20; // ...and burst
const INPUT_PER_SEC = 60; // `input` messages per client (the real client sends 30/s): sustained rate; extras are dropped
const INPUT_BURST = 60;
const MESSAGES_PER_SEC = 200; // every message of any kind, per socket: sustained rate; going over it terminates the socket
const MESSAGES_BURST = 200;
export const MAX_SOCKETS_PER_IP = 8; // concurrent sockets from one address
const MAX_IP_LENGTH = 64;
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
  if (pathname.startsWith('/shared/')) return safeJoin(SHARED_DIR, pathname.slice(8));
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

/**
 * The caller's address, for the per-address caps. We sit behind a trusted gateway, so the first X-Forwarded-For entry
 * is the client; without the header it is the socket's own address.
 */
export function clientIp(req) {
  const raw = req.headers?.['x-forwarded-for'];
  // Envoy appends the peer it saw, so the rightmost entry is the one a client can't forge.
  const header = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const last = header?.split(',').pop().trim();
  const ip = last || req.socket?.remoteAddress || 'unknown';
  return ip.replace(/^::ffff:/i, '').slice(0, MAX_IP_LENGTH);
}

/** Token bucket: true when one more event fits the rate (and uses it up). */
function take(bucket, now, perSec, burst) {
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * perSec);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function parsePort(value) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_PORT;
}

/**
 * Start the game server. Resolves once listening.
 * Options: port (default $PORT or 8080), host (default 0.0.0.0), clientDir, config, rng, log, heartbeatMs,
 * maxLobbies / maxPlayersPerLobby / maxLobbiesPerIp / maxSocketsPerIp / idleLobbyMs (hidden safety caps, tests
 * change them).
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
    maxLobbiesPerIp = MAX_LOBBIES_PER_IP,
    maxSocketsPerIp = MAX_SOCKETS_PER_IP,
    idleLobbyMs = IDLE_LOBBY_MS,
  } = opts;

  const manager = new LobbyManager({
    config,
    rng,
    log,
    maxLobbies,
    maxPlayers: maxPlayersPerLobby,
    maxLobbiesPerIp,
    idleLobbyMs,
    // a room the manager closed on its own (idle): say why and put the kids back in the browser
    onEvict: (client, res) => {
      client.send({ t: 'error', reason: res.error, message: res.message });
      sendList(client);
    },
  });
  const server = http.createServer(makeHttpHandler(path.resolve(clientDir)));
  const wss = new WebSocketServer({ server, maxPayload: HARD_MAX_PAYLOAD });
  const clients = new Set();
  const socketsByIp = new Map(); // address -> open sockets
  let nextClientId = 1;
  let lastListJson = '';
  let lastListAt = -Infinity;

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

  /** Send the lobby list to everyone who is browsing, but only when it changed (and not more than once per minGap). */
  function pushList(minGap = LIST_MIN_GAP_MS) {
    const now = performance.now();
    if (now - lastListAt < minGap) return;
    lastListAt = now;
    const json = JSON.stringify({ t: 'lobbies', lobbies: manager.list() });
    if (json === lastListJson) return;
    lastListJson = json;
    for (const c of clients) if (c.browsing && !c.lobby) c.raw(json);
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

  function onMessage(client, msg) {
    const now = performance.now();
    if (msg.t === 'input') {
      if (take(client.inputBucket, now, INPUT_PER_SEC, INPUT_BURST)) manager.input(client, msg); // extras are dropped
      return;
    }
    if (!take(client.manageBucket, now, MANAGE_PER_SEC, MANAGE_BURST)) return; // lobby management: ~10/s sustained
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

  wss.on('connection', (ws, req) => {
    ws.on('error', () => {});
    const ip = clientIp(req);
    const open = socketsByIp.get(ip) ?? 0;
    if (open >= maxSocketsPerIp) {
      ws.close(1013, 'Too many connections'); // 1013: try again later
      setTimeout(() => ws.terminate(), 1000).unref(); // don't wait on a peer that never answers the close
      return;
    }
    socketsByIp.set(ip, open + 1);
    const t0 = performance.now();
    // every send path goes through here: a socket that cannot drain is cut off instead of buffering without bound
    const out = (str) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.terminate();
        return;
      }
      ws.send(str);
    };
    const client = {
      ws,
      ip,
      id: `p${nextClientId++}`,
      cid: null,
      name: 'Player',
      team: 'plant',
      lobby: null, // set by the LobbyManager
      browsing: false, // wants lobby-list pushes
      lastInputAt: 0,
      inputActive: false,
      alive: true,
      pingNonce: null, // the payload of the ping we are waiting for a pong to; only an echo of it counts
      dead: false,
      manageBucket: { tokens: MANAGE_BURST, at: t0 },
      inputBucket: { tokens: INPUT_BURST, at: t0 },
      messageBucket: { tokens: MESSAGES_BURST, at: t0 },
      /** obj is encoded here unless the caller already has the JSON (a broadcast encodes its payload once). */
      send(obj, json) {
        out(json ?? JSON.stringify(obj));
      },
      raw: out,
    };
    clients.add(client);
    ws.on('pong', (data) => {
      // unsolicited pongs (or ones that don't echo our nonce) say nothing about the connection being alive
      if (client.pingNonce && Buffer.isBuffer(data) && data.equals(client.pingNonce)) {
        client.alive = true;
        client.pingNonce = null;
      }
    });
    ws.on('close', () => {
      const n = (socketsByIp.get(ip) ?? 1) - 1;
      if (n > 0) socketsByIp.set(ip, n);
      else socketsByIp.delete(ip);
      client.dead = true;
      dropClient(client);
      pushList();
    });
    ws.on('message', (data, isBinary) => {
      if (client.dead) return;
      if (!take(client.messageBucket, performance.now(), MESSAGES_PER_SEC, MESSAGES_BURST)) {
        client.dead = true;
        log(`player ${client.id} flooded messages; dropped`);
        ws.terminate();
        return;
      }
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
      pushList(0);
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
      c.pingNonce = crypto.randomBytes(8); // a client that isn't reading can't echo this back
      try {
        c.ws.ping(c.pingNonce);
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
