// What the computer players know about the other side's defence: how strong each door's garden plot is and how battered the
// door is. The zombie bots use it to pick the weakest way in (levels Hard and up, `smart` / `focus`), the Gardener to decide
// where to spend (gardener.js).
import { WORLD } from './world.js';
import { levelScale } from './garden.js';

/** Firepower of one garden plant (damage per second, levels included); a Wall-nut counts as a modest tank. */
export function plantPower(c, g) {
  const t = c.plantTypes[g.plantKind];
  if (!t) return 0;
  const s = levelScale(c, g.level ?? 1);
  if (t.noAttack) return 3 * s.hp;
  return t.damage * (t.pellets ?? 1) * 0.6 * t.rate * s.damage * s.rate * (t.splash ? 1.4 : 1) * (t.slow ? 1.3 : 1);
}

/**
 * Per door (front, side, back, garage): { id, power (its plot's plants), frac (door HP share, 0 broken), broken, weak }.
 * `weak` is higher the easier the way in: few plants, a battered or broken door. Cached for the current sim tick.
 */
export function doorStrength(game) {
  if (game._intel && game._intel.t === game.time) return game._intel.list;
  const c = game.config;
  const power = [0, 0, 0, 0];
  for (const e of game.entities.values()) {
    if (e.kind !== 'garden' || e.state !== 'alive') continue;
    const s = game.slots[e.slot];
    if (s && s.plot >= 0) power[s.plot] += plantPower(c, e);
  }
  const list = WORLD.doors.map((d, i) => {
    const piece = game.cover.get(`door:${d.id}`);
    const broken = !piece || piece.state !== 'alive';
    const frac = broken ? 0 : piece.hp / piece.maxHp;
    const weak = (1 / (1 + power[i] / 8)) * (broken ? 3 : 1.3 - 0.3 * frac);
    return { id: d.id, power: power[i], frac, broken, weak };
  });
  game._intel = { t: game.time, list };
  return list;
}

/** The weakest door right now. */
export function weakestDoor(game) {
  let best = null;
  for (const d of doorStrength(game)) if (!best || d.weak > best.weak) best = d;
  return best;
}
