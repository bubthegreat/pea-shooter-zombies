// Weapon ladders. Index in the array is the upgrade tier (0 = starting gun).
// rate = shots per second, speed = projectile m/s, spread = random cone half-angle (rad).

function weapon(id, name, damage, rate, pellets, spread, speed, projKind) {
  return Object.freeze({ id, name, damage, rate, pellets, spread, speed, projKind });
}

export const PLANT_LADDER = Object.freeze([
  weapon('pea_blaster', 'Pea Blaster', 1, 4, 1, 0, 50, 'pea'),
  weapon('pea_rifle', 'Pea Rifle', 1, 9, 1, 0, 70, 'pea'),
  weapon('spike_shotgun', 'Spike Shotgun', 1, 1.3, 7, 0.12, 55, 'spike'),
  weapon('house_gun', 'House Gun', 5, 1.5, 1, 0, 40, 'housepea'),
]);

export const ZOMBIE_LADDER = Object.freeze([
  weapon('goo_blaster', 'Goo Blaster', 8, 3, 1, 0, 50, 'bullet'),
  weapon('zombie_rifle', 'Zombie Rifle', 8, 6, 1, 0, 60, 'bullet'),
  weapon('zombie_shotgun', 'Zombie Shotgun', 6, 1.2, 6, 0.12, 50, 'bullet'),
  weapon('auto_shot_rifle', 'Auto-Shot Rifle', 8, 12, 1, 0.02, 65, 'bullet'),
]);

const BY_ID = new Map([...PLANT_LADDER, ...ZOMBIE_LADDER].map((w) => [w.id, w]));

export function getWeapon(id) {
  return BY_ID.get(id) ?? null;
}

export function ladderFor(team) {
  return team === 'zombie' ? ZOMBIE_LADDER : PLANT_LADDER;
}

/** Weapon for a team at a tier (tier is clamped to the ladder). */
export function weaponFor(team, tier = 0) {
  const ladder = ladderFor(team);
  return ladder[Math.max(0, Math.min(ladder.length - 1, tier | 0))];
}
