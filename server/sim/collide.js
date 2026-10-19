// Collision field for the server: the shared Field (shared/field.js) over the server's terrain grid and yard bounds.
//   - resolve(): push a standing circle out of whatever blocks it. A collider blocks walking when its top is above the
//     feet + STEP; lower ones are walked (or jumped) onto.
//   - groundAt(): terrain height, or the top of a collider the feet can step onto.
//   - segment(): first thing a projectile or line of sight runs into.
import { WORLD, PLAYER_RADIUS } from './world.js';
import { terrainHeight } from './terrain.js';
import { MAP } from './map.js';
import { Field as BaseField, STEP, MAX_SLOPE } from '../../shared/field.js';

export { STEP, MAX_SLOPE };

export class Field extends BaseField {
  constructor() {
    super(WORLD.bounds, terrainHeight);
  }
}

/** A fresh field holding copies of the static colliders. */
export function createField() {
  const f = new Field();
  for (const c of MAP.statics) f.add({ ...c });
  return f;
}

let staticField = null;

/** Push a point (circle of `radius`) out of the yard edge and the static walls; for tests and tools without a Game. Mutates pos. */
export function clampToWorld(pos, radius = PLAYER_RADIUS) {
  staticField ??= createField();
  return staticField.resolve(pos, radius, pos.y ?? 0, (pos.y ?? 0) + 1.8, null);
}
