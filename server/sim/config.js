// All gameplay tunables live here. Later modules read from game.config (never hard-code numbers).
import { WORLD, gardenSlots } from './world.js';
import { PLANT_LADDER, ZOMBIE_LADDER } from './weapons.js';
import { planWaves } from './rules.js';

export const DEFAULT_CONFIG = {
  tickRate: 30,
  snapRate: 20,
  maxDt: 0.1, // clamp for one tick() call
  roundLength: 480, // seconds from night to sunrise

  // Feature switches (tests and debugging turn individual subsystems off).
  features: {
    initialGarden: true,
    waves: true,
    botAI: true,
    sunDrops: true,
    gardener: true,
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
  projectileRadius: {
    pea: 0.12, snow: 0.14, spike: 0.12, melon: 0.3, housepea: 0.3, // plant shots: small and quick
    bullet: 0.28, slime: 0.28, bone: 0.25, sludge: 0.25, brain: 0.45, // zombie shots: big and slow
  },
  headshotMultiplier: 3, // damage multiplier for hits on the head zone of players and bots
  headHeight: 0.4, // top slice (m) of the body that counts as the head

  // Upgrades
  tierThresholds: [0, 2, 4, 7, 10, 14, 18, 23], // cumulative kills needed for tier 0..7
  streakBonus: 10, // kills in a row without being hurt => jump one extra tier

  // Garden plants (stationary turrets) and sunshine
  gardenPlantHp: 60,
  gardenPlantRadius: 0.6,
  gardenPlantHeight: 1.2,
  // Plant types in unlock order (key order = planting key 1..9). tier = kill-meter tier that unlocks it.
  // range in m, rate in shots/s, speed in m/s, aimError = random cone half-angle (rad).
  // Optional: pellets + spread (shotgun volley), splash / gravity / life (lobbed shots), slow ({factor, secs}),
  // hp / radius / height / muzzle (default gardenPlant* / turretMuzzleHeight), noAttack, blocks (solid for walking).
  plantTypes: {
    peashooter: { tier: 0, name: 'Peashooter', cost: 50, range: 25, rate: 1.5, damage: 1, speed: 50, projKind: 'pea', aimError: 0.14 },
    cactus: { tier: 0, name: 'Cactus', cost: 100, range: 50, rate: 0.8, damage: 3, speed: 60, projKind: 'spike', aimError: 0.12 },
    repeater: { tier: 1, name: 'Repeater', cost: 125, range: 25, rate: 3, damage: 1, speed: 55, projKind: 'pea', aimError: 0.13 },
    snowpea: { tier: 2, name: 'Snow Pea', cost: 150, range: 25, rate: 1.5, damage: 1, speed: 55, projKind: 'snow', aimError: 0.13, slow: { factor: 0.5, secs: 2 } },
    spikesquash: { tier: 3, name: 'Spike Squash', cost: 175, range: 12, rate: 0.9, damage: 1, speed: 55, projKind: 'spike', aimError: 0.08, pellets: 8, spread: 0.05 },
    melonpult: { tier: 4, name: 'Melon-pult', cost: 200, range: 32, rate: 0.5, damage: 7, speed: 26, projKind: 'melon', aimError: 0.03, splash: 3.5, gravity: 12, life: 3.5 },
    wallnut: { tier: 5, name: 'Wall-nut', cost: 150, hp: 400, radius: 0.8, height: 1.5, noAttack: true, blocks: true },
    gatling: { tier: 6, name: 'Gatling Pea', cost: 250, range: 28, rate: 6, damage: 1, speed: 70, projKind: 'pea', aimError: 0.1 },
    houseplant: { tier: 7, name: 'House Plant', cost: 300, range: 35, rate: 0.6, damage: 5, speed: 40, projKind: 'housepea', aimError: 0.06, hp: 150, radius: 1.1, height: 3, muzzle: 2.4 },
  },
  // Planted plants level up 1 -> 3 (U near one): each level above 1 adds this share of the base stat.
  // cost = multiple of the plant's cost per step (level 1 -> 2, 2 -> 3); reach = metres from the kid; lookCone = half-angle (rad) of "looking at".
  plantLevels: { max: 3, damage: 0.4, rate: 0.25, hp: 0.5, cost: [0.75, 1.25], reach: 3, lookCone: 0.5 },
  turretMuzzleHeight: 1.0,
  turretAimHeight: 0.6, // fraction of target height to aim at
  turretLag: 0.5, // seconds: turrets aim at where a moving target was this long ago
  plantRange: 4, // a plant can be placed in an empty slot this close to the player
  startSunshine: 200,
  sunPerConversion: 25,
  sunValue: 25,
  sunDropInterval: 3.5,
  sunLifetime: 30,
  sunPickupRadius: 1.5,
  sunFallSpeed: 4,
  sunDropHeight: 12,
  sunRestHeight: 1,
  sunDropX: [-28, 28],
  sunDropZ: [-30, 20],
  sunMaxActive: 10,

  // Mower
  mowerStartTime: 3, // seconds from "use" to driving
  mowerUseRange: 2.5, // a zombie this close can start it
  mowerSpeed: 7, // m/s for the zombie riding it
  mowerKillRadius: 1.5, // garden plants this close to a driving mower are mowed
  botMowerSpeedScale: 0.6, // bots drive slower than kids
  mowerHp: 40, // the mower's own HP; the driver inside takes no damage at all
  mowerRespawn: 20, // seconds a wrecked mower stays broken before reappearing at the garage
  mowerRadius: 0.9, // hit volume of a started mower (covers the driver)
  mowerHeight: 1.9,

  // Garage equipment rack: zombies swap their gun for a lawn tool (E at the rack; Q or E elsewhere to drop it).
  // range/halfAngle: melee cone (m, rad); tick: seconds between swings; dps*: damage per second against garden
  // plants / plant players; knock: m/s push on plant players; deflect: chance to swat a light shot (damage <= deflectMaxDamage); blowSun: m/s push on suns.
  rackUseRange: 2,
  rackRespawn: 20, // an item is back on its hook this many seconds after a drop / wreck / conversion
  rack: [
    { item: 'weed_eater', x: 15.5, z: 41.5 },
    { item: 'leaf_blower', x: 18.5, z: 41.5 },
    { item: 'hedge_trimmer', x: 21.5, z: 41.5 },
    { item: 'wheelbarrow', x: 24.5, z: 41.5 },
  ],
  equipment: {
    weed_eater: {
      name: 'Weed Eater', blurb: 'Shreds garden plants in seconds, hurts plant kids - but the range is tiny',
      range: 3, halfAngle: 0.7, tick: 0.1, dpsGarden: 40, dpsFighter: 30, speedScale: 1,
    },
    leaf_blower: {
      name: 'Leaf Blower', blurb: 'Pushes plant kids back, swats peas, blows suns away - but barely hurts',
      range: 9, halfAngle: 0.45, tick: 0.1, dpsGarden: 2, dpsFighter: 3, knock: 12, deflect: 0.85, deflectMaxDamage: 2, blowSun: 8, speedScale: 1,
    },
    hedge_trimmer: {
      name: 'Hedge Trimmer', blurb: 'Wilts plant kids fast and chews turrets - but you walk slower',
      range: 2, halfAngle: 0.8, tick: 0.1, dpsGarden: 30, dpsFighter: 150, speedScale: 0.75,
    },
    wheelbarrow: {
      name: 'Wheelbarrow', blurb: 'A rolling shield that soaks up shots - but you cannot attack',
      hp: 30, speedScale: 0.85, shield: { forward: 1.1, halfWidth: 0.9, depth: 0.7, height: 1.2 },
    },
  },
  // Share of zombie bots that go for each item (rolled once per bot, after the mower roll).
  botItemChance: { weed_eater: 0.12, hedge_trimmer: 0.05, leaf_blower: 0.03, wheelbarrow: 0.05 },

  // Rounds, waves and win rules
  roundLength: 480,
  endedTime: 10, // result screen before the next round (or the waiting room)
  autoRestart: true, // after the result screen start the next round at once; lobbies set false and go back to their waiting room
  waveFirst: 5, // seconds into the round
  waveInterval: 45,
  lastWaveLead: 60, // final wave arrives this many seconds before sunrise
  maxZombieBots: 40,

  // Bots. aimError = random cone half-angle (rad); fireScale scales the weapon fire rate;
  // reaction = seconds before a freshly spotted target is shot at; waveBase + wave number = wave size.
  difficulties: {
    easy: { aimError: 0.15, fireScale: 0.3, reaction: 0.8, waveBase: 2 },
    normal: { aimError: 0.14, fireScale: 0.3, reaction: 0.4, waveBase: 3 },
  },
  zombieBotSpeed: 3,
  botThinkInterval: 0.25,
  botAimRerollInterval: 0.3,
  zombieBotShootRange: 20,
  zombieBotStopDistance: 8, // zombies stop this far from the plant they are attacking
  mowerBotChance: 0.25, // share of zombie bots that go for the mower
  mowerBotStopDistance: 1.2,
  // Mower-seeking bots sneak up the right-hand flank (clear of the garden) before turning into the garage.
  mowerFlank: { x: 28, startZ: -20, endZ: 22 },

  // The Gardener: the plant team's only computer player, present only while no human plays plants.
  // It walks the garden replanting empty slots from its own sunshine income and shoots weakly.
  gardener: {
    name: 'Gardener',
    speed: 4,
    startSunshine: 200,
    income: 10, // sunshine per second
    maxSunshine: 300,
    respawn: 10, // seconds after it wilts
    shootRange: 25,
    aimError: 0.2,
    fireScale: 0.25,
    reaction: 0.6,
    plantReach: 2.5, // walks to within this distance of a slot before planting
    upgradeInterval: 45, // seconds between plant upgrades (it replants first)
    upgradeReserve: 100, // sunshine it keeps back after an upgrade, for replanting
    restZ: 16, // idles behind the garden
  },
};

const PUBLIC_PLANT_FIELDS = ['tier', 'name', 'cost', 'range', 'rate', 'damage', 'projKind', 'pellets', 'splash', 'slow', 'hp', 'radius', 'height', 'noAttack', 'blocks'];

/** Config subset sent to clients in the welcome message (plain JSON). */
export function publicConfig(config = DEFAULT_CONFIG) {
  const c = config;
  return {
    tickRate: c.tickRate,
    snapRate: c.snapRate,
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
      Object.entries(c.plantTypes).map(([k, t]) => [k, Object.fromEntries(PUBLIC_PLANT_FIELDS.filter((f) => t[f] !== undefined).map((f) => [f, t[f]]))]),
    ),
    plantLevels: c.plantLevels,
    plantRange: c.plantRange,
    startSunshine: c.startSunshine,
    sunValue: c.sunValue,
    sunPerConversion: c.sunPerConversion,
    sunPickupRadius: c.sunPickupRadius,
    sunRestHeight: c.sunRestHeight,
    sunLifetime: c.sunLifetime,
    // Garage equipment
    rackUseRange: c.rackUseRange,
    rackRespawn: c.rackRespawn,
    rack: c.rack,
    equipment: c.equipment,
    // Mower
    mowerHp: c.mowerHp,
    mowerRespawn: c.mowerRespawn,
    mowerStartTime: c.mowerStartTime,
    mowerUseRange: c.mowerUseRange,
    mowerSpeed: c.mowerSpeed,
    mowerKillRadius: c.mowerKillRadius,
    // Projectile visuals/collision, headshots
    projectileRadius: c.projectileRadius,
    headshotMultiplier: c.headshotMultiplier,
    headHeight: c.headHeight,
    // World layout (bounds, gate, house, garage, mowerHome, plantSpawn, solids) and garden slots
    world: WORLD,
    gardenSlots: gardenSlots(),
  };
}
