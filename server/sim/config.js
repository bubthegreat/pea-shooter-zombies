// All gameplay tunables live here. Later modules read from game.config (never hard-code numbers).
import { WORLD, gardenSlots } from './world.js';
import { PLANT_LADDER, ZOMBIE_LADDER } from './weapons.js';
import { planWaves } from './rules.js';

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
    peashooter: { cost: 50, range: 25, rate: 1.5, damage: 1, speed: 50, projKind: 'pea', aimError: 0.16 },
    cactus: { cost: 100, range: 50, rate: 0.8, damage: 2, speed: 60, projKind: 'spike', aimError: 0.12 },
  },
  turretMuzzleHeight: 1.0,
  turretAimHeight: 0.6, // fraction of target height to aim at
  turretLag: 0.5, // seconds: turrets aim at where a moving target was this long ago
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

  // Mower
  mowerStartTime: 3, // seconds from "use" to driving
  mowerUseRange: 2.5, // a zombie this close can start it
  mowerSpeed: 7, // m/s for the zombie riding it
  mowerKillRadius: 1.5, // garden plants this close to a driving mower are mowed
  botMowerSpeedScale: 0.6, // bots drive slower than kids
  mowerDamageScale: 0.25, // the driver takes this share of incoming damage

  // Rounds, waves and win rules
  roundLength: 480,
  endedTime: 10, // result screen before an automatic restart
  waveFirst: 5, // seconds into the round
  waveInterval: 45,
  lastWaveLead: 60, // final wave arrives this many seconds before sunrise
  maxZombieBots: 40,

  // Bots. aimError = random cone half-angle (rad); fireScale scales the weapon fire rate;
  // reaction = seconds before a freshly spotted target is shot at; waveBase + wave number = wave size.
  difficulties: {
    easy: { aimError: 0.15, fireScale: 0.5, reaction: 0.8, waveBase: 2 },
    normal: { aimError: 0.07, fireScale: 0.8, reaction: 0.4, waveBase: 3 },
  },
  zombieBotSpeed: 3,
  plantBotSpeed: 4,
  botThinkInterval: 0.25,
  botAimRerollInterval: 0.3,
  zombieBotShootRange: 20,
  zombieBotStopDistance: 8, // zombies stop this far from the plant they are attacking
  mowerBotChance: 0.25, // share of zombie bots that go for the mower
  mowerBotStopDistance: 1.2,
  plantBotShootRange: 30,
  plantBotAimError: 0.15,
  plantBotFireScale: 0.4,
  maxConvertedBots: 8, // beyond this the longest-serving converted bots retire in a leaf poof
  plantBotReaction: 0.3,
  guardLineZ: -4, // plant bots hold the line here, just in front of the garden
  guardLineHalfWidth: 18,
  defenderCount: 4, // plant bots when no human plays plants
  versusDefenderCount: 2, // plant bots alongside a human plant in versus
  defenderRespawn: 8,
};

/** Config subset sent to clients in the welcome message (plain JSON). */
export function publicConfig(config = DEFAULT_CONFIG) {
  const c = config;
  return {
    tickRate: c.tickRate,
    snapRate: c.snapRate,
    maxPlayers: c.maxPlayers,
    // Player and movement. Entity y is the feet position; the camera sits eyeHeight above it.
    moveSpeed: c.moveSpeed,
    jumpSpeed: c.jumpSpeed,
    gravity: c.gravity,
    eyeHeight: c.eyeHeight,
    playerRadius: c.playerRadius,
    playerHeight: c.playerHeight,
    pitchLimit: c.pitchLimit,
    // Health and timers
    zombieHp: c.zombieHp,
    plantHp: c.plantHp,
    gardenPlantHp: c.gardenPlantHp,
    wiltRespawn: c.wiltRespawn,
    sproutTime: c.sproutTime,
    // Rounds
    roundLength: c.roundLength,
    endedTime: c.endedTime,
    waves: { first: c.waveFirst, interval: c.waveInterval, lastWaveLead: c.lastWaveLead, times: planWaves(c) },
    // Upgrades
    tierThresholds: c.tierThresholds,
    streakBonus: c.streakBonus,
    weapons: { plant: PLANT_LADDER, zombie: ZOMBIE_LADDER },
    // Garden and sunshine
    plantTypes: Object.fromEntries(
      Object.entries(c.plantTypes).map(([k, t]) => [k, { cost: t.cost, range: t.range, rate: t.rate, damage: t.damage, projKind: t.projKind }]),
    ),
    plantRange: c.plantRange,
    startSunshine: c.startSunshine,
    sunValue: c.sunValue,
    sunPerConversion: c.sunPerConversion,
    sunPickupRadius: c.sunPickupRadius,
    sunRestHeight: c.sunRestHeight,
    sunLifetime: c.sunLifetime,
    // Mower
    mowerStartTime: c.mowerStartTime,
    mowerUseRange: c.mowerUseRange,
    mowerSpeed: c.mowerSpeed,
    mowerKillRadius: c.mowerKillRadius,
    // Projectile visuals/collision
    projectileRadius: c.projectileRadius,
    // World layout (bounds, gate, house, garage, mowerHome, plantSpawn, solids) and garden slots
    world: WORLD,
    gardenSlots: gardenSlots(),
  };
}
