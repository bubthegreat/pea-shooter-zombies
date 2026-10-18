// Plant roster helpers for the HUD, the planting keys and the upgrade prompt. Pure functions (no DOM, no three.js).
// The server's config.plantTypes (welcome message) is the truth for names, costs and unlock tiers; this file only adds
// icons and fallbacks. Key order of plantTypes = planting keys 1..9.

const ICONS = {
  peashooter: '\u{1F331}', cactus: '\u{1F335}', repeater: '\u{1F33F}', snowpea: '❄️', spikesquash: '\u{1F383}',
  melonpult: '\u{1F349}', wallnut: '\u{1F330}', gatling: '\u{1F52B}', houseplant: '\u{1F3E1}',
};

/** Roster used before (or without) a server config: the same nine plants as server/sim/config.js. */
export const DEFAULT_PLANTS = {
  peashooter: { name: 'Peashooter', tier: 0, cost: 50 },
  cactus: { name: 'Cactus', tier: 0, cost: 100 },
  repeater: { name: 'Repeater', tier: 1, cost: 125 },
  snowpea: { name: 'Snow Pea', tier: 2, cost: 150 },
  spikesquash: { name: 'Spike Squash', tier: 3, cost: 175 },
  melonpult: { name: 'Melon-pult', tier: 4, cost: 200 },
  wallnut: { name: 'Wall-nut', tier: 5, cost: 150 },
  gatling: { name: 'Gatling Pea', tier: 6, cost: 250 },
  houseplant: { name: 'House Plant', tier: 7, cost: 300 },
};

export const DEFAULT_LEVELS = { max: 3, cost: [0.75, 1.25], reach: 3, lookCone: 0.5 };

/** Seed icon for a planting key (1-based) or plant id; used by touch hints ("Tap 🌱 to plant"). */
export function plantIcon(kind) {
  return ICONS[kind] || '\u{1F331}';
}

/** Plants in planting-key order: [{ key (1-based), id, name, icon, tier, cost }]. */
export function plantList(config) {
  const types = config && config.plantTypes && typeof config.plantTypes === 'object' && Object.keys(config.plantTypes).length ? config.plantTypes : DEFAULT_PLANTS;
  return Object.keys(types).map((id, i) => {
    const t = types[id] || {};
    const d = DEFAULT_PLANTS[id] || {};
    return {
      key: i + 1,
      id,
      name: typeof t.name === 'string' && t.name ? t.name : d.name || id,
      icon: plantIcon(id),
      tier: Number.isFinite(t.tier) ? t.tier : d.tier ?? 0,
      cost: Number.isFinite(t.cost) ? t.cost : d.cost ?? 100,
      noAttack: !!t.noAttack,
    };
  });
}

/** The plants a kid at `tier` may plant. */
export function unlockedPlants(config, tier) {
  return plantList(config).filter((p) => p.tier <= (tier | 0));
}

/** The plants that the next tier unlocks (empty at the top), with the tier number. */
export function nextUnlock(config, tier) {
  const all = plantList(config);
  const top = all.reduce((m, p) => Math.max(m, p.tier), 0);
  const t = (tier | 0) + 1;
  if (t > top) return null;
  const fresh = all.filter((p) => p.tier === t);
  return fresh.length ? { tier: t, plants: fresh } : null;
}

/** "★★" for a level. */
export function stars(level) {
  return '★'.repeat(Math.max(1, Math.min(9, level | 0)));
}

function levels(config) {
  return { ...DEFAULT_LEVELS, ...((config && config.plantLevels) || {}) };
}

/** Sunshine to take a plant of `kind` from `level` to level + 1; null at the top level. */
export function upgradeCost(config, kind, level = 1) {
  const L = levels(config);
  const base = plantList(config).find((p) => p.id === kind);
  const mult = L.cost[level - 1];
  if (!base || level >= L.max || mult === undefined) return null;
  return Math.round(base.cost * mult);
}

/**
 * The garden plant the U key would upgrade, with the same rule as the server (server/sim/garden.js pickUpgradeTarget):
 * within `reach` metres, the one inside the look cone with the smallest angle, otherwise the nearest.
 * entities: Map or array of snapshot entities. Returns { plant, looked } or null.
 */
export function pickUpgradeTarget(entities, player, config) {
  const L = levels(config);
  const fx = -Math.sin(player.yaw || 0);
  const fz = -Math.cos(player.yaw || 0);
  let looked = null;
  let lookAngle = L.lookCone;
  let nearest = null;
  let nearestDist = L.reach;
  for (const g of entities.values ? entities.values() : entities) {
    if (g.kind !== 'garden' || (g.state !== undefined && g.state !== 'alive')) continue;
    const d = Math.hypot(player.x - g.x, player.z - g.z);
    if (d > L.reach) continue;
    if (d < nearestDist) {
      nearest = g;
      nearestDist = d;
    }
    if (d < 0.05) continue;
    const angle = Math.acos(Math.max(-1, Math.min(1, (fx * (g.x - player.x) + fz * (g.z - player.z)) / d)));
    if (angle <= lookAngle) {
      looked = g;
      lookAngle = angle;
    }
  }
  if (looked) return { plant: looked, looked: true };
  return nearest ? { plant: nearest, looked: false } : null;
}

/** HUD / prompt text for the upgrade a kid is about to buy, e.g. "Press U to upgrade Cactus ★★ — 75☀". */
export function upgradePrompt(config, plant, sunshine) {
  const info = plantList(config).find((p) => p.id === plant.plantKind);
  const name = info ? info.name : 'plant';
  const level = plant.level || 1;
  const cost = upgradeCost(config, plant.plantKind, level);
  if (cost === null) return `${name} ${stars(level)} is fully grown!`;
  if (sunshine < cost) return `${name} ${stars(level + 1)} needs ☀️ ${cost} to upgrade — grab some sunshine!`;
  return `Press U to upgrade ${name} ${stars(level + 1)} — ${cost}☀️`;
}
