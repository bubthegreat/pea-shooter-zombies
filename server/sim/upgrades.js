// Upgrades: kills fill a progress meter (tier thresholds); a long no-hurt streak jumps an extra tier.
// Zombie kids get a better gun per tier; plant kids unlock a new plant type per tier (one gun all round).
import { ladderFor } from './weapons.js';

/** Highest tier whose cumulative-kill threshold has been reached. */
export function tierForProgress(thresholds, progress) {
  let tier = 0;
  for (let i = 0; i < thresholds.length; i++) if (progress >= thresholds[i]) tier = i;
  return tier;
}

/** Highest tier a team can reach: zombies climb the gun ladder, plants unlock plant types. */
function topTier(c, team) {
  if (team === 'zombie') return ladderFor('zombie').length - 1;
  let top = 0;
  for (const t of Object.values(c.plantTypes)) top = Math.max(top, t.tier ?? 0);
  return top;
}

/** Plant kinds a plant kid has unlocked at `tier`, in planting-key order. */
export function unlockedKinds(c, tier) {
  return Object.keys(c.plantTypes).filter((k) => (c.plantTypes[k].tier ?? 0) <= tier);
}

function setTier(game, player, tier, bonus) {
  const c = game.config;
  const before = player.tier;
  player.tier = tier;
  if (player.team === 'zombie') {
    const weapon = ladderFor('zombie')[tier];
    player.weapon = weapon.id;
    game.emit('upgrade', { id: player.id, tier, weapon: weapon.id, name: weapon.name, bonus });
    return;
  }
  // Plant kids keep their Pea Blaster; a new tier unlocks plants to put in the garden instead.
  const fresh = unlockedKinds(c, tier).filter((k) => (c.plantTypes[k].tier ?? 0) > before);
  const newest = fresh.at(-1) ?? null;
  game.emit('upgrade', { id: player.id, tier, plantKind: newest, plantKinds: fresh, name: newest ? c.plantTypes[newest].name : '', bonus });
}

/** A human player beat an enemy (converted a zombie, or wilted/destroyed/mowed a plant). Bots are ignored. */
export function recordKill(game, player) {
  if (!player || player.kind !== 'player') return;
  const c = game.config;
  const top = topTier(c, player.team);
  player.progress += 1;
  player.streak += 1;
  let tier = Math.min(top, tierForProgress(c.tierThresholds, player.progress));
  let bonus = false;
  if (player.streak >= c.streakBonus && tier < top) {
    // Streak bonus: skip ahead one upgrade and carry the kill meter with it.
    tier += 1;
    bonus = true;
    player.streak = 0;
    player.progress = Math.max(player.progress, c.tierThresholds[tier]);
  }
  if (tier > player.tier) setTier(game, player, tier, bonus);
}

/** A human player took damage: the no-hurt streak starts over (tier is kept). */
export function recordHurt(player) {
  if (player && player.kind === 'player') player.streak = 0;
}
