// Weapon ladders. Index in the array is the upgrade tier (0 = starting gun), 8 tiers each.
// rate = shots per second, speed = projectile m/s, spread = random cone half-angle (rad).
// Optional: splash (blast radius m; damage falls off with distance), gravity (m/s^2, arcing shots),
// lob (rad added to the aim pitch so a lobber is on target at medium range), slow ({factor, secs}), life (s).

function weapon(id, name, damage, rate, pellets, spread, speed, projKind, extra = {}) {
  return Object.freeze({ id, name, damage, rate, pellets, spread, speed, projKind, ...extra });
}

export const PLANT_LADDER = Object.freeze([
  weapon('pea_blaster', 'Pea Blaster', 1, 4, 1, 0, 50, 'pea'),
  weapon('double_pea', 'Double Pea', 1, 3.5, 2, 0.03, 50, 'pea'),
  weapon('pea_rifle', 'Pea Rifle', 1, 9, 1, 0, 70, 'pea'),
  weapon('snow_pea', 'Snow Pea', 1, 6, 1, 0, 55, 'snow', { slow: Object.freeze({ factor: 0.5, secs: 2 }) }),
  weapon('spike_shotgun', 'Spike Shotgun', 1, 1.4, 8, 0.045, 55, 'spike'),
  weapon('repeater', 'Repeater', 1, 14, 1, 0.01, 75, 'pea'),
  weapon('melon_lobber', 'Melon Lobber', 7, 1.2, 1, 0.01, 26, 'melon', { splash: 3.5, gravity: 12, lob: 0.18, life: 3 }),
  weapon('house_gun', 'House Gun', 5, 1.5, 1, 0, 40, 'housepea'),
]);

// Zombie shots are slow and chunky on purpose: kids can see them coming and dodge.
export const ZOMBIE_LADDER = Object.freeze([
  weapon('goo_blaster', 'Goo Blaster', 8, 3, 1, 0, 20, 'bullet', { life: 2.5 }),
  weapon('slime_pistol', 'Slime Pistol', 8, 4.5, 1, 0, 22, 'slime', { life: 2.5 }),
  weapon('zombie_rifle', 'Zombie Rifle', 8, 6, 1, 0, 22, 'bullet', { life: 2.5 }),
  weapon('bone_burst', 'Bone Burst', 7, 2.2, 3, 0.03, 21, 'bone', { life: 2.5 }),
  weapon('zombie_shotgun', 'Zombie Shotgun', 7, 1.2, 8, 0.05, 20, 'bullet', { life: 2.5 }),
  weapon('sludge_sprayer', 'Sludge Sprayer', 5, 10, 1, 0.05, 20, 'sludge', { life: 2.5 }),
  weapon('brain_cannon', 'Brain Cannon', 40, 0.8, 1, 0, 18, 'brain', { splash: 3.5, life: 3 }),
  weapon('auto_shot_rifle', 'Auto-Shot Rifle', 8, 12, 1, 0.02, 22, 'bullet', { life: 2.5 }),
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
