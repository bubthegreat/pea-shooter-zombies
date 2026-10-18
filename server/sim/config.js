// All gameplay tunables live here. Later modules read from game.config (never hard-code numbers).
import { WORLD } from './world.js';

export const DEFAULT_CONFIG = {
  tickRate: 30,
  snapRate: 20,
  maxDt: 0.1, // clamp for one tick() call
  maxPlayers: 2,
  roundLength: 480, // seconds from night to sunrise

  // Feature switches (tests and debugging turn individual subsystems off).
  features: {
    initialGarden: true,
    waves: true,
    botAI: true,
    sunDrops: true,
    defenders: true,
    winRules: true,
  },

  // Humans and movement
  moveSpeed: 6, // m/s
  jumpSpeed: 6,
  gravity: 18,
  eyeHeight: 1.6,
  playerRadius: 0.5,
  playerHeight: 1.8,
  pitchLimit: 1.5,
  zombieHp: 5,
  plantHp: 100, // plant players and plant bots
  nameMaxLength: 16,
  defaultName: 'Player',
  defaultMode: 'coop',
  defaultDifficulty: 'normal',
};

/** Config subset sent to clients in the welcome message. */
export function publicConfig(config = DEFAULT_CONFIG) {
  return {
    tickRate: config.tickRate,
    snapRate: config.snapRate,
    moveSpeed: config.moveSpeed,
    jumpSpeed: config.jumpSpeed,
    gravity: config.gravity,
    eyeHeight: config.eyeHeight,
    playerRadius: config.playerRadius,
    playerHeight: config.playerHeight,
    pitchLimit: config.pitchLimit,
    world: WORLD,
  };
}
