// Gun upgrades: kills fill a progress meter (tier thresholds); a long no-hurt streak jumps an extra tier.
import { ladderFor } from './weapons.js';

/** Highest tier whose cumulative-kill threshold has been reached. */
export function tierForProgress(thresholds, progress) {
  let tier = 0;
  for (let i = 0; i < thresholds.length; i++) if (progress >= thresholds[i]) tier = i;
  return tier;
}

function setTier(game, player, tier, bonus) {
  const weapon = ladderFor(player.team)[tier];
  player.tier = tier;
  player.weapon = weapon.id;
  game.emit('upgrade', { id: player.id, tier, weapon: weapon.id, name: weapon.name, bonus });
}

/** A human player beat an enemy (converted a zombie, or wilted/destroyed/mowed a plant). Bots are ignored. */
export function recordKill(game, player) {
  if (!player || player.kind !== 'player') return;
  const c = game.config;
  const top = ladderFor(player.team).length - 1;
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
