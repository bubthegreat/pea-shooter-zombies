// Shared test helpers (no tests in here).
import { Game } from '../server/sim/game.js';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { gardenSlots } from '../server/sim/world.js';
import { MAP } from '../server/sim/map.js';
import { STEP } from '../server/sim/collide.js';
import { ensureAI } from '../server/sim/bots.js';
import { itineraryFor } from '../server/sim/nav.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const NO_FEATURES = {
  initialGarden: false,
  cover: false,
  headStart: false,
  waves: false,
  botAI: false,
  sunDrops: false,
  gardener: false,
  winRules: false,
};

/** Game with every optional subsystem off unless listed in `features`. Deterministic rng. */
export function makeGame({ features = {}, seed = 1234, ...overrides } = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides, features: { ...NO_FEATURES, ...features } };
  return new Game(config, mulberry32(seed));
}

export function run(game, seconds, dt = 1 / 30) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) game.tick(dt);
}

export function keys(over = {}) {
  return { f: false, b: false, l: false, r: false, jump: false, ...over };
}

export function entitiesOfKind(game, kind) {
  return [...game.entities.values()].filter((e) => e.kind === kind);
}

// ---- the garden plots (4 plots of 4 rows x 4 columns; plot 0 = in front of the front door) -------------------------------
export const SLOTS = gardenSlots();
export const slotIdx = (plot, row, col) => plot * 16 + row * 4 + col;
export const slotPos = (plot, row, col) => SLOTS[slotIdx(plot, row, col)];
/** Front plot slot (row 0 = outermost, the Peashooter row; col 0..3 left to right). */
export const S = (row, col) => slotPos(0, row, col);

/** Is the body centre of `e` inside a blocking static wall/furniture box? (Doors and cover are not static.) */
export function insideStatic(e) {
  for (const c of MAP.statics) {
    if (c.blocks === false || c.y1 <= e.y + STEP || c.y0 >= e.y + 1.8) continue;
    if (c.s === 'box' && e.x > c.minX + 0.05 && e.x < c.maxX - 0.05 && e.z > c.minZ + 0.05 && e.z < c.maxZ - 0.05) return c;
    if (c.s === 'cyl' && Math.hypot(e.x - c.x, e.z - c.z) < c.r - 0.05) return c;
  }
  return null;
}

/** Make a zombie bot walk one specific route + door. */
export function forceRoute(game, bot, route, door) {
  ensureAI(game, bot);
  bot.ai.itin = itineraryFor(route, door);
  bot.ai.path = bot.ai.itin.nodes.slice();
  bot.ai.pi = 0;
  bot.ai.mode = 'route';
  return bot;
}

export function breakDoors(game, ...ids) {
  for (const id of ids.length ? ids : ['front', 'side', 'back', 'garage']) game.cover.destroy(game.cover.get(`door:${id}`));
}
