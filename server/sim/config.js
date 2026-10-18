// All gameplay tunables live here. Later modules read from game.config (never hard-code numbers).
import { WORLD, PLOTS, gardenSlots } from './world.js';
import { PLANT_LADDER, ZOMBIE_LADDER } from './weapons.js';
import { planWaves } from './rules.js';
import { MAP } from './map.js';
import { terrainConfig } from './terrain.js';
import { potRules } from './pots.js';

export const DEFAULT_CONFIG = {
  tickRate: 30,
  snapRate: 20,
  maxDt: 0.1, // clamp for one tick() call
  roundLength: 480, // seconds from night to sunrise

  // Feature switches (tests and debugging turn individual subsystems off).
  features: {
    initialGarden: false, // no default plants: the plants plant their own defence
    fridge: true,
    cover: true,
    headStart: true,
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
  startSunshine: 300,
  sunPerConversion: 25,
  sunValue: 25,
  sunDropInterval: 3,
  sunLifetime: 30,
  sunPickupRadius: 1.5,
  sunFallSpeed: 4,
  sunDropHeight: 12,
  sunRestHeight: 1,
  sunDropX: [-36, 36],
  sunDropZ: [-40, 42],
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
  // plants / plant players (dpsStruct: against doors, cover and builds); knock: m/s push on plant players; deflect: chance to swat a light shot (damage <= deflectMaxDamage); blowSun: m/s push on suns.
  rackUseRange: 2,
  rackRespawn: 20, // an item is back on its hook this many seconds after a drop / wreck / conversion
  rack: [
    { item: 'weed_eater', x: 11.2, z: 20.8 },
    { item: 'leaf_blower', x: 13.6, z: 20.8 },
    { item: 'hedge_trimmer', x: 16.0, z: 20.8 },
    { item: 'wheelbarrow', x: 18.4, z: 20.8 },
  ],
  equipment: {
    weed_eater: {
      name: 'Weed Eater', blurb: 'Shreds garden plants in seconds, hurts plant kids - but the range is tiny',
      range: 3, halfAngle: 0.7, tick: 0.1, dpsGarden: 40, dpsFighter: 30, dpsStruct: 22, speedScale: 1, needs: 'gas',
    },
    leaf_blower: {
      name: 'Leaf Blower', blurb: 'Pushes plant kids back, swats peas, blows suns away - but barely hurts',
      range: 9, halfAngle: 0.45, tick: 0.1, dpsGarden: 2, dpsFighter: 3, knock: 12, deflect: 0.85, deflectMaxDamage: 2, blowSun: 8, speedScale: 1, needs: 'battery',
    },
    hedge_trimmer: {
      name: 'Hedge Trimmer', blurb: 'Wilts plant kids fast and chews turrets - but you walk slower',
      range: 2, halfAngle: 0.8, tick: 0.1, dpsGarden: 30, dpsFighter: 150, dpsStruct: 40, speedScale: 0.75, needs: 'battery',
    },
    wheelbarrow: {
      name: 'Wheelbarrow', blurb: 'A rolling shield that soaks up shots - but you cannot attack',
      hp: 30, speedScale: 0.85, shield: { forward: 1.1, halfWidth: 0.9, depth: 0.7, height: 1.2 },
    },
  },
  // Mower parts: counts per round, how close a kid must be to pick one up, how long a shot carrier cannot pick anything up.
  // The tools with `needs` (equipment) and the mower (Battery + Gas Can + Spark Plug) start unpowered.
  parts: { counts: { battery: 3, gas: 2, plug: 1 }, pickRange: 1.8, lockSecs: 2, botChance: 0.2 },
  // Share of zombie bots that go for each item (rolled once per bot, after the mower roll).
  botItemChance: { weed_eater: 0, hedge_trimmer: 0, leaf_blower: 0, wheelbarrow: 0 },

  // The Fridge Meter: every living zombie standing by the open fridge (up to maxZombies) fills 1 / fillSeconds of the
  // meter per second; it never drains. A full meter is a zombie win.
  fridge: { fillSeconds: 10, maxZombies: 4 },
  headStart: 15, // seconds the plants have alone: zombies wait in the gate pen (waves are shifted by this)

  // Rounds, waves and win rules
  roundLength: 480,
  endedTime: 10, // result screen before the next round (or the waiting room)
  autoRestart: true, // after the result screen start the next round at once; lobbies set false and go back to their waiting room
  waveFirst: 5, // seconds into the round
  waveInterval: 45,
  lastWaveLead: 60, // final wave arrives this many seconds before sunrise
  maxZombieBots: 40,

  // Difficulty levels, easiest first (key order = the order in the lobby menus). Each level scales BOTH computer sides.
  // Zombie bots: aimError = random cone half-angle (rad); fireScale scales the weapon fire rate; reaction = seconds before
  // a freshly spotted target is shot at; wave size = waveBase + waveStep * wave number; speedScale scales zombieBotSpeed;
  // shootScale scales zombieBotShootRange; lead 0..1 = how much they lead moving targets; smart 0..1 = how much new bots pick
  // the weakest door instead of the fixed route odds; focus = share of each wave that goes for the wave's weakest door;
  // errand / mower scale the share of bots that fetch parts / go for the mower; maxBots caps living zombie bots.
  // `gardener` = overrides of config.gardener for this level (see below); `{}` = the basic Gardener.
  difficulties: {
    easy: { name: 'Easy', aimError: 0.15, fireScale: 0.3, reaction: 0.8, waveBase: 2, waveStep: 1, speedScale: 1, shootScale: 1, lead: 0, smart: 0, focus: 0, errand: 1, mower: 1, maxBots: 40, gardener: {} },
    normal: { name: 'Normal', aimError: 0.14, fireScale: 0.3, reaction: 0.4, waveBase: 4, waveStep: 1, speedScale: 1, shootScale: 1, lead: 0, smart: 0, focus: 0, errand: 1, mower: 1, maxBots: 40, gardener: {} },
    hard: {
      name: 'Hard', aimError: 0.11, fireScale: 0.36, reaction: 0.32, waveBase: 5, waveStep: 1.15, speedScale: 1.05, shootScale: 1.05, lead: 0.2, smart: 0.25, focus: 0.15, errand: 1.25, mower: 1.2, maxBots: 40,
      gardener: { brain: 'smart', speed: 4.5, income: 11, maxSunshine: 400, aimError: 0.12, fireScale: 0.4, reaction: 0.4, lead: 0.3, tier: 2, upgradeInterval: 25, think: 0.25 },
    },
    veryhard: {
      name: 'Very Hard', aimError: 0.09, fireScale: 0.42, reaction: 0.26, waveBase: 6, waveStep: 1.3, speedScale: 1.1, shootScale: 1.1, lead: 0.4, smart: 0.45, focus: 0.3, errand: 1.5, mower: 1.5, maxBots: 40,
      gardener: { brain: 'smart', speed: 5, income: 12, maxSunshine: 500, aimError: 0.08, fireScale: 0.55, reaction: 0.3, head: 0.2, lead: 0.5, strafe: 0.3, tier: 3, upgradeInterval: 16, forts: 4, think: 0.2 },
    },
    expert: {
      name: 'Expert', aimError: 0.07, fireScale: 0.5, reaction: 0.2, waveBase: 7, waveStep: 1.5, speedScale: 1.18, shootScale: 1.15, lead: 0.6, smart: 0.65, focus: 0.45, errand: 1.8, mower: 1.8, maxBots: 40,
      gardener: { brain: 'smart', count: 2, speed: 5.5, income: 9, maxSunshine: 500, aimError: 0.05, fireScale: 0.7, reaction: 0.2, head: 0.4, lead: 0.7, strafe: 0.5, tier: 5, upgradeInterval: 11, forts: 6, pots: 4, retreat: true, collect: true, think: 0.15 },
    },
    nightmare: {
      name: 'Nightmare', aimError: 0.05, fireScale: 0.6, reaction: 0.15, waveBase: 9, waveStep: 1.75, speedScale: 1.28, shootScale: 1.2, lead: 0.8, smart: 0.85, focus: 0.6, errand: 2.2, mower: 2.2, maxBots: 40,
      gardener: { brain: 'smart', count: 2, speed: 6, income: 11, maxSunshine: 600, aimError: 0.03, fireScale: 0.85, reaction: 0.15, head: 0.65, lead: 0.85, strafe: 0.7, tier: 6, upgradeInterval: 7, forts: 8, pots: 6, retreat: true, collect: true, think: 0.12 },
    },
    insane: {
      name: 'Insane', aimError: 0.035, fireScale: 0.75, reaction: 0.1, waveBase: 11, waveStep: 2, speedScale: 1.4, shootScale: 1.3, lead: 1, smart: 1, focus: 0.8, errand: 2.6, mower: 2.6, maxBots: 40,
      gardener: { brain: 'smart', count: 2, speed: 6.5, income: 13, maxSunshine: 800, aimError: 0.018, fireScale: 1, reaction: 0.1, head: 0.85, lead: 1, strafe: 0.9, tier: 7, upgradeInterval: 4, forts: 10, pots: 8, retreat: true, collect: true, think: 0.1 },
    },
  },
  zombieBotSpeed: 3,
  botThinkInterval: 0.25,
  botAimRerollInterval: 0.3,
  zombieBotShootRange: 20,
  zombieBotStopDistance: 8, // zombies stop this far from the plant they are attacking
  mowerBotChance: 0.25, // share of zombie bots that go for the mower once all three parts are in
  mowerBotStopDistance: 1.2,

  // Doors: HP of each (a zombie shot does 8). Plants walk and shoot through their own doors; zombies must break them.
  doorHp: { front: 220, side: 220, back: 220, garage: 360, default: 220 },
  // Door repair (plant kids and the Gardener, free): hold E at the repair pile inside a door (world.js `repair`) without moving or
  // shooting. rate = door HP per second per repairer; range = metres from the pile; a fully broken door is rebuilt after
  // rebuildTime seconds of work and comes back with rebuildHp of its HP; a hit on the repairer stops the work for hurtPause s.
  repair: { rate: 9, range: 1.8, rebuildTime: 3, rebuildHp: 0.25, hurtPause: 1.2, fxEvery: 0.5 },
  // Destructible cover by kind: hp (a pea does 1, a goo shot 8; rocks are tough, stones and fences medium).
  cover: {
    gravestone: { hp: 60 },
    rock: { hp: 420 },
    tree: { hp: 240 },
    hedge: { hp: 70 },
    trashcan: { hp: 45 },
    picnic: { hp: 110 },
    pool: { hp: 50 },
    shedwall: { hp: 130 },
  },
  // Forts (both teams). Footprint w x d in metres (rotatable), h = height, hp; cost in sunshine (plants) / brains (zombie kids).
  builds: {
    maxPerPlayer: 12,
    reach: 14, // how far from the builder a build may go up
    plant: [
      { id: 'hedgewall', name: 'Hedge Wall', cost: 25, w: 3, d: 1, h: 1.8, hp: 60 },
      { id: 'fence', name: 'Wooden Fence', cost: 45, w: 3, d: 1, h: 1.6, hp: 150 },
      // A flower pot: a garden slot on the house's interior floor (rules: pots.js; cap: config.pots.max, apart from the fort cap).
      { id: 'pot', name: 'Flower Pot', cost: 25, w: 1, d: 1, h: 0.7, hp: 90, pot: true },
    ],
    zombie: [
      { id: 'tombwall', name: 'Tombstone Wall', cost: 25, w: 3, d: 1, h: 1.5, hp: 140 },
      { id: 'junk', name: 'Junk Barricade', cost: 10, w: 2, d: 1, h: 1.3, hp: 60 },
      { id: 'cantower', name: 'Trash-can Tower', cost: 15, w: 1, d: 1, h: 2.6, hp: 90 },
    ],
  },
  // Flower pots (plant kids and the Gardener; a build kind, see builds.plant). max = pots standing per player; spacing = least
  // distance between two pot centres; laneClear / fridgeClear / pileClear = clear radius round the bots' walkways, the fridge
  // spot and the repair piles; inset = how far inside a room's walls a pot stands; sit = how high a potted plant stands above the floor.
  pots: { max: 10, spacing: 2.2, laneClear: 1.5, fridgeClear: 1.7, pileClear: 1.3, inset: 0.6, sit: 0.55 },
  // Brains (zombie kids): +perHit for hitting a plant, door or plant structure (at most once per `gap` s per target), +perTurret for destroying a turret.
  brains: { start: 10, perHit: 5, perTurret: 10, gap: 0.5, max: 150 },
  // Bots: how far from a door they stand and shoot at it, how long they must be stuck before they act.
  botStuckTime: 0.5,

  // The Gardener: the plant team's only computer player, present only while no human plays plants.
  // It walks the garden replanting empty slots from its own sunshine income and shoots weakly.
  gardener: {
    name: 'Gardener',
    speed: 4,
    startSunshine: 300,
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
    rest: { x: 5, z: 4 }, // idles on the porch
    // The smart brain (levels Hard and up, see difficulties[..].gardener; server/sim/gardener.js). Every level may override any key above.
    brain: 'basic', // 'basic' walks the slots and replants; 'smart' watches all four doors and plans
    count: 1, // how many Gardeners there are (each has its own sunshine, its own half of the work)
    think: 0.25, // seconds between decisions
    head: 0, // 0..1: chance a target is aimed at the head (headshots are 3x)
    lead: 0, // 0..1: how much it leads moving targets
    strafe: 0, // 0..1: how much it sidesteps while fighting
    tier: 0, // highest plant tier it may plant; it unlocks one tier every `tierEvery` seconds of the round
    tierEvery: 25,
    forts: 0, // forts (fences / hedges on the approaches) it keeps standing, at most
    pots: 0, // pots it keeps in the house (last line around the kitchen), at most
    retreat: false, // falls back to the kitchen to guard the fridge when a door has fallen
    collect: false, // walks to sunshine pickups (sky drops and what converted zombies leave behind)
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
    builds: c.builds,
    repair: c.repair,
    doorHp: c.doorHp,
    pots: c.pots,
    potRules: potRules(c), // where a pot may stand (shapes + numbers), for the ghost preview
    brains: c.brains,
    startSunshine: c.startSunshine,
    headStart: c.headStart,
    fridge: c.fridge,
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
    // Static map (terrain grid, colliders, doors, cover, plots...) and garden slots
    map: publicMap(),
    gardenSlots: gardenSlots(),
  };
}

const r2 = (v) => Math.round(v * 100) / 100;

function compact(c) {
  const o = { s: c.s, y0: r2(c.y0), y1: r2(c.y1) };
  if (c.s === 'box') Object.assign(o, { minX: r2(c.minX), maxX: r2(c.maxX), minZ: r2(c.minZ), maxZ: r2(c.maxZ) });
  else Object.assign(o, { x: r2(c.x), z: r2(c.z), r: r2(c.r) });
  if (c.id) o.id = c.id;
  if (c.kind) o.kind = c.kind;
  if (c.style) o.style = c.style;
  if (c.rot) o.rot = r2(c.rot);
  if (c.passTeam) o.passTeam = c.passTeam;
  return o;
}

let mapCache = null;

/** The static map in plain JSON, built once. */
function publicMap() {
  mapCache ??= {
    bounds: WORLD.bounds,
    gate: WORLD.gate,
    pen: WORLD.pen,
    house: WORLD.house,
    garage: WORLD.garage,
    doors: WORLD.doors,
    doorways: WORLD.doorways,
    rooms: WORLD.rooms,
    fridge: WORLD.fridge,
    mowerHome: WORLD.mowerHome,
    plantSpawn: WORLD.plantSpawn,
    deck: WORLD.deck,
    shed: WORLD.shed,
    cellar: WORLD.cellar,
    creek: WORLD.creek,
    bridge: WORLD.bridge,
    gravel: WORLD.gravel,
    plots: PLOTS.map((p) => ({ index: p.index, door: p.door, rect: p.rect })),
    terrain: terrainConfig(),
    statics: MAP.statics.map(compact),
    doorPieces: MAP.doors.map(compact),
    cover: MAP.cover.map(compact),
    repairPiles: WORLD.repair,
    partSpots: MAP.partSpots,
    noBuild: MAP.noBuild,
  };
  return mapCache;
}
