// Small helpers shared by the bot brains (bots.js: zombie bots and the basic Gardener; gardener.js: the smart Gardener).
import { dist2D, rightVec, forwardVec } from './vec.js';
export const EYE_LOS = 1.4;

/** Nearest living entity of `list` within maxDist that the bot can see (up to the 4 closest are line-of-sight checked). */
export function nearestVisible(game, b, list, maxDist) {
  const near = [];
  for (const e of list) {
    if (e.state !== 'alive') continue;
    const d = dist2D(b.x, b.z, e.x, e.z);
    if (d <= maxDist) near.push([d, e]);
  }
  near.sort((p, q) => p[0] - q[0]);
  for (let i = 0; i < Math.min(4, near.length); i++) {
    const t = near[i][1];
    if (game.field.clearLine(b.x, b.y + EYE_LOS, b.z, t.x, t.y + t.height * game.config.turretAimHeight, t.z, b.team)) return t;
  }
  return null;
}

/** Convert a world-space walking direction into f/b/l/r keys relative to the bot's yaw. */
export function setMoveKeys(b, dx, dz) {
  const k = b.input.keys;
  k.f = k.b = k.l = k.r = false;
  if (dx === 0 && dz === 0) return;
  const fwd = forwardVec(b.yaw);
  const right = rightVec(b.yaw);
  const f = dx * fwd.x + dz * fwd.z;
  const r = dx * right.x + dz * right.z;
  if (f > 0.35) k.f = true;
  else if (f < -0.35) k.b = true;
  if (r > 0.35) k.r = true;
  else if (r < -0.35) k.l = true;
}

/** The next point of the bot's path it still has to reach, or null when the path is done. */
export function nextPoint(b, ai, stop) {
  while (ai.pi < ai.path.length) {
    const wp = ai.path[ai.pi];
    const last = ai.pi === ai.path.length - 1;
    if (Math.hypot(wp.x - b.x, wp.z - b.z) < (last ? stop : 0.8)) {
      ai.pi++;
      continue;
    }
    return wp;
  }
  return null;
}

export function setPath(ai, pts) {
  ai.path = pts;
  ai.pi = 0;
}

/**
 * Stuck detection (every think tick): a bot that wants to move but isn't making progress shoots the destructible thing in
 * front of it, or else sidesteps and jumps.
 */
export function checkStuck(game, b, ai, dir, speed) {
  const c = game.config;
  const dt = c.botThinkInterval;
  const moved = Math.hypot(b.x - ai.lx, b.z - ai.lz);
  ai.lx = b.x;
  ai.lz = b.z;
  if (!ai.moving || ai.blocker) {
    ai.stuck = 0;
    return;
  }
  if (moved < speed * dt * 0.3) ai.stuck += dt;
  else {
    ai.stuck = 0;
    return;
  }
  if (ai.stuck < c.botStuckTime) return;
  const hit = dir ? game.field.segment(b.x, b.y + 1.0, b.z, b.x + dir.x * 2.6, b.y + 1.0, b.z + dir.z * 2.6, 0.1, b.team) : null;
  const piece = hit ? game.cover.pieceOf(hit.c) : null;
  if (piece && game.cover.canHurt(piece, b.team)) {
    ai.blocker = piece.id;
    ai.stuck = 0;
    return;
  }
  ai.side = ai.side === 0 ? (game.rng() < 0.5 ? -1 : 1) : -ai.side;
  ai.sideT = 0.9;
  ai.jump = true;
  if (ai.stuck > 2.5) {
    ai.replan = 0; // find another way
    ai.stuck = 0;
  }
}


/** A pseudo-target for aiming at a destructible piece (a door, a gravestone, a fort wall). */
export function pieceTarget(piece) {
  const mid = Math.min(piece.y1, piece.y0 + 1.4);
  return { x: piece.x, z: piece.z, y: piece.y0, height: Math.max(0.5, (mid - piece.y0) / 0.6) };
}

/** The piece a bot is shooting its way through, if it is still standing. */
export function blockerPiece(game, ai) {
  if (!ai.blocker) return null;
  const p = game.cover.get(ai.blocker);
  if (!p || p.state !== 'alive') {
    ai.blocker = null;
    return null;
  }
  return p;
}
