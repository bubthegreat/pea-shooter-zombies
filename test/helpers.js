// Shared test helpers (no tests in here).
import { Game } from '../server/sim/game.js';
import { DEFAULT_CONFIG } from '../server/sim/config.js';

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
  waves: false,
  botAI: false,
  sunDrops: false,
  defenders: false,
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
