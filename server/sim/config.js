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
  wiltRespawn: 4, // plant fighter respawn delay (s)
  sproutTime: 5, // converted zombie player digs back up after this (s)
  nameMaxLength: 16,
  defaultName: 'Player',
  defaultMode: 'coop',
  defaultDifficulty: 'normal',

  // Projectiles
  projectileLife: 2, // seconds
  projectileStep: 0.4, // max meters moved per collision substep (prevents tunneling)
  muzzleForward: 0.6, // projectiles spawn this far in front of the eye
  projectileRadius: { pea: 0.12, spike: 0.12, housepea: 0.3, bullet: 0.15 },

  // Upgrades
  tierThresholds: [0, 3, 7, 12], // cumulative kills needed for tier 0..3
  streakBonus: 10, // kills in a row without being hurt => jump one extra tier

  // Garden plants (stationary turrets)
  gardenPlantHp: 60,
  gardenPlantRadius: 0.6,
  gardenPlantHeight: 1.2,
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
