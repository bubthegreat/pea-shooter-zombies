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

  // Garden plants (stationary turrets) and sunshine
  gardenPlantHp: 60,
  gardenPlantRadius: 0.6,
  gardenPlantHeight: 1.2,
  plantTypes: {
    // range in m, rate in shots/s, speed in m/s, aimError = random cone half-angle (rad)
    peashooter: { cost: 50, range: 25, rate: 1.5, damage: 1, speed: 50, projKind: 'pea', aimError: 0.06 },
    cactus: { cost: 100, range: 50, rate: 0.8, damage: 2, speed: 60, projKind: 'spike', aimError: 0.04 },
  },
  turretMuzzleHeight: 1.0,
  turretAimHeight: 0.6, // fraction of target height to aim at
  plantRange: 4, // a plant can be placed in an empty slot this close to the player
  startSunshine: 100,
  sunPerConversion: 25,
  sunValue: 25,
  sunDropInterval: 8,
  sunLifetime: 30,
  sunPickupRadius: 1.5,
  sunFallSpeed: 4,
  sunDropHeight: 12,
  sunRestHeight: 1,
  sunDropX: [-28, 28],
  sunDropZ: [-30, 20],
  sunMaxActive: 6,
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
