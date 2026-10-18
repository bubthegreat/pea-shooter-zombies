// Weapons. The zombie ladder has 8 tiers (index = upgrade tier, 0 = starting gun); plants have the single Pea Blaster.
// rate = shots per second, speed = projectile m/s, spread = random cone half-angle (rad).
// Optional: splash (blast radius m; damage falls off with distance), gravity (m/s^2, arcing shots),
// lob (rad added to the aim pitch so a lobber is on target at medium range), slow ({factor, secs}), life (s).

function weapon(id, name, damage, rate, pellets, spread, speed, projKind, extra = {}) {
  return Object.freeze({ id, name, damage, rate, pellets, spread, speed, projKind, ...extra });
}

// Plant kids keep this one gun all round. Their kill meter unlocks plant types (see config.plantTypes), not guns.
export const PLANT_GUN = weapon('pea_blaster', 'Pea Blaster', 1, 4, 1, 0, 50, 'pea');
export const PLANT_LADDER = Object.freeze([PLANT_GUN]);

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
