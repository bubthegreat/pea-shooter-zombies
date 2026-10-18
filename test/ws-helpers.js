// WebSocket test helpers (no tests in here).
import { WebSocket } from 'ws';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function connect(srv, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`, opts);
    ws.messages = [];
    ws.waiters = [];
    ws.closed = false;
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      ws.messages.push(m);
      ws.waiters = ws.waiters.filter((w) => !w(m));
    });
    ws.on('close', () => {
      ws.closed = true;
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.say = (obj) => ws.send(JSON.stringify(obj));
    ws.last = (type) => [...ws.messages].reverse().find((m) => m.t === type);
  });
}

/** Resolve with the first message (already received or future) matching pred. */
export function waitFor(ws, pred, ms = 3000) {
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

/** Resolve with the first message matching pred that arrives AFTER this call. */
export function waitNext(ws, pred, ms = 3000) {
  const skip = ws.messages.length;
  const later = ws.messages.slice(skip).find(pred);
  if (later) return Promise.resolve(later);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for next message')), ms);
    ws.waiters.push((m) => {
      if (!pred(m)) return false;
      clearTimeout(timer);
      resolve(m);
      return true;
    });
  });
}

export async function until(pred, ms = 3000) {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > ms) throw new Error('timeout');
    await sleep(15);
  }
}

/** Create a lobby as this socket and start it; resolves with the welcome message. */
export async function soloGame(ws, { name = 'Solo', team = 'plant', mode = 'coop', difficulty = 'easy', cid } = {}) {
  ws.say({ t: 'createLobby', name, team, mode, difficulty, cid });
  await waitFor(ws, (m) => m.t === 'lobbyState' && m.lobby);
  ws.say({ t: 'startGame' });
  return waitFor(ws, (m) => m.t === 'welcome');
}

/** The one lobby on a server that only has one. */
export const onlyLobby = (srv) => [...srv.lobbies.lobbies.values()][0];
