import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, publicConfig } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { MAP } from '../server/sim/map.js';
import { checkBuild } from '../server/sim/build.js';
import { rulesOf, potProblem, POT_LANES } from '../server/sim/pots.js';
import { applyDamage } from '../server/sim/combat.js';
import { levelScale } from '../server/sim/garden.js';
import { makeGame, run, keys, entitiesOfKind, insideStatic } from './helpers.js';

const FORT_X = [-30, -27, -18, -12, -9, -6, -3, 0, 3, 6, 9, 12]; // open lawn cells for twelve hedge walls
const POT = DEFAULT_CONFIG.builds.plant.findIndex((b) => b.id === 'pot') + 1;
const potDef = () => ({ ...DEFAULT_CONFIG.builds.plant[POT - 1], team: 'plant' });

/** A plant kid standing in the kitchen with plenty of sunshine. */
function potGame(extra = {}) {
  const game = makeGame({ features: { cover: false, ...extra.features }, ...extra.config });
  const p = game.addPlayer('p', { name: 'Pea', team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { name: 'Zed', team: 'zombie' });
  p.x = -2;
  p.z = 11;
  p.y = 0;
  p.sunshine = 1000;
  z.x = 30;
  z.z = -30;
  game.drainEvents();
  return { game, p, z };
}
const place = (game, id, gx, gz, kind = POT) => {
  const e = game.entities.get(id);
  game.handleInput(id, { build: kind, bx: gx, bz: gz, br: 0, buildSeq: e.buildSeqSeen + 1 });
  game.tick(1 / 30);
};
const pots = (game) => [...game.cover.pieces.values()].filter((x) => x.build?.kind === 'pot');
const fails = (game) => game.drainEvents().filter((e) => e.type === 'buildFail').map((e) => e.reason);
const why = (game, p, gx, gz, opts) => {
  const r = checkBuild(game, p, potDef(), gx, gz, 0, opts);
  return r.ok ? null : r.reason;
};

test('config: the pot is a plant build kind with its own cap, cost 25, and it is public', () => {
  const def = DEFAULT_CONFIG.builds.plant[POT - 1];
  assert.equal(def.id, 'pot');
  assert.equal(def.cost, 25);
  assert.equal(def.pot, true);
  assert.deepEqual([def.w, def.d], [1, 1]);
  assert.ok(def.hp > 0);
  assert.equal(DEFAULT_CONFIG.pots.max, 10);
  assert.deepEqual(publicConfig().pots, DEFAULT_CONFIG.pots);
  assert.ok(publicConfig().potRules.rooms.length === 3 && publicConfig().potRules.lanes.length > 5);
  assert.equal(DEFAULT_CONFIG.builds.plant.length, 3);
});

test('placing a pot in the kitchen: costs sunshine, a build event, a solid piece with HP, and a garden slot', () => {
  const { game, p } = potGame();
  const slots0 = game.slots.length;
  place(game, 'p', -5, 11); // the kitchen, west side
  const [pot] = pots(game);
  assert.ok(pot, 'it stands');
  assert.equal(p.sunshine, 1000 - 25);
  assert.equal(pot.hp, DEFAULT_CONFIG.builds.plant[POT - 1].hp);
  assert.deepEqual([pot.collider.minX, pot.collider.maxX, pot.collider.minZ, pot.collider.maxZ], [-5, -4, 11, 12]);
  assert.equal(pot.collider.y1, 0.7);
  const ev = game.drainEvents().find((e) => e.type === 'build');
  assert.deepEqual([ev.kind, ev.x, ev.z, ev.by], ['pot', -5, 11, 'p']);
  assert.equal(game.slots.length, slots0 + 1);
  const slot = game.slots.at(-1);
  assert.deepEqual([slot.x, slot.z, slot.pot, slot.plantId], [-4.5, 11.5, pot.id, null]);
  assert.ok(game.mapState().builds.some((b) => b.kind === 'pot' && b.x === -5), 'late joiners see it');
  // solid: a zombie walking into it is stopped
  const z = game.entities.get('z');
  z.x = -4.5;
  z.z = 13.5;
  z.y = 0;
  game.handleInput('z', { keys: keys({ f: true }), yaw: 0, pitch: 0 });
  run(game, 1.2);
  assert.ok(z.z >= 12 + z.radius - 0.03, `blocked by the pot, z=${z.z}`);
});

test('pots only go on the interior floor: not outside, not in the garage, not when the kid stands outdoors', () => {
  const { game, p } = potGame();
  assert.equal(why(game, p, -5, 11), null);
  assert.equal(why(game, p, -2, 2), 'house', 'the porch');
  assert.equal(why(game, p, 3, 0), 'house', 'the lawn');
  assert.equal(why(game, { ...p, x: 6, z: 12 }, 13, 14), 'house', 'the garage is not the house');
  assert.equal(why(game, p, -14, 11), 'house', 'in the wall');
  const out = { ...p, x: 5, z: 2 };
  assert.equal(why(game, out, -5, 11), 'house', 'standing on the porch');
  const door = { ...p, x: 5, z: 6 };
  assert.equal(why(game, door, -5, 11), null, 'standing in the doorway counts as indoors');
});

test('pots never block the way: doorways, walkways, the fridge front and the repair piles stay open', () => {
  const { game, p } = potGame();
  assert.equal(why(game, p, 4, 7), 'lane', 'inside the front door');
  assert.equal(why(game, p, 4, 20), 'lane', 'inside the back door');
  assert.equal(why(game, p, -13, 14), 'lane', 'inside the side door');
  assert.equal(why(game, p, -8, 14), 'lane', 'the living-kitchen doorway');
  assert.equal(why(game, p, 0, 14), 'lane', 'the kitchen-hall doorway');
  assert.equal(why(game, p, -3, 21), 'lane', 'in front of the fridge');
  assert.equal(why(game, p, -2, 20), 'lane', 'the way to the fridge');
  assert.equal(why(game, { ...p }, 3, 7), 'lane', 'the front door repair pile');
  assert.equal(why(game, p, -5, 11), null);
  assert.equal(why(game, p, 0, 21), null, 'beside the fridge lane is fine');
});

test('pots keep apart, respect the walls and furniture, and are refused on top of people and turrets', () => {
  const { game, p } = potGame();
  place(game, 'p', -5, 10);
  assert.equal(pots(game).length, 1);
  game.drainEvents();
  place(game, 'p', -5, 11);
  assert.deepEqual(fails(game), ['crowd'], 'right next to another pot');
  place(game, 'p', -5, 12);
  assert.deepEqual(fails(game), ['crowd'], '2 m is still too close');
  place(game, 'p', -5, 13);
  assert.equal(pots(game).length, 2, '3 m is fine');
  assert.equal(why(game, p, -12, 9), 'blocked', 'on the coffee table');
  assert.equal(why(game, p, -3, 9), 'blocked', 'on the kitchen table');
  p.x = -9.5;
  p.z = 9.5;
  assert.equal(why(game, p, -10, 9), 'busy', 'on top of the builder');
});

test('costs sunshine, has its own cap of 10 that forts do not share', () => {
  const { game, p } = potGame();
  p.sunshine = 20;
  place(game, 'p', -5, 10);
  assert.deepEqual(fails(game), ['cost']);
  p.sunshine = 5000;
  // ten far-apart legal cells in the living room and kitchen
  const cells = [];
  for (let gz = 7; gz <= 22; gz++) for (let gx = -13; gx <= 6; gx++) if (checkBuild(game, { ...p, x: -2, z: 11.5 }, potDef(), gx, gz, 0, { free: true }).ok) cells.push([gx, gz]);
  const chosen = [];
  for (const [gx, gz] of cells) if (chosen.every(([x, z]) => Math.hypot(x - gx, z - gz) >= 3)) chosen.push([gx, gz]);
  assert.ok(chosen.length >= 12, `room for a dozen pots, found ${chosen.length}`);
  for (const [gx, gz] of chosen.slice(0, 10)) {
    [p.x, p.z] = [[-2, 11.5], [-10, 12], [5, 12], [-10, 20]].find(([x, z]) => Math.hypot(x - gx, z - gz) > 2.5);
    place(game, 'p', gx, gz);
    const f = fails(game);
    assert.deepEqual(f, [], `pot at ${gx}, ${gz}: ${f}`);
  }
  assert.equal(pots(game).length, 10);
  game.drainEvents();
  const [gx, gz] = chosen[10];
  [p.x, p.z] = [[-2, 11.5], [-10, 12], [5, 12], [-10, 20]].find(([x, z]) => Math.hypot(x - gx, z - gz) > 2.5);
  place(game, 'p', gx, gz);
  assert.deepEqual(fails(game), ['cap'], 'the eleventh pot');
  assert.equal(game.cover.buildsOf('p', 'pot'), 10);
  assert.equal(game.cover.buildsOf('p', 'fort'), 0);
  // forts still have their 12
  for (let i = 0; i < 12; i++) {
    p.x = FORT_X[i] + 1.5;
    p.z = -24;
    place(game, 'p', FORT_X[i], -28, 1);
    const f = fails(game);
    assert.deepEqual(f, [], `fort ${i}: ${f}`);
  }
  assert.equal(game.cover.buildsOf('p', 'fort'), 12);
  assert.equal(game.cover.buildsOf('p', 'pot'), 10);
  assert.equal(game.cover.buildsOf('p'), 22);
  // a destroyed pot frees one of the ten
  game.cover.destroy(pots(game)[0]);
  assert.equal(game.cover.buildsOf('p', 'pot'), 9);
});

test('a pot is a garden slot: any unlocked plant goes in, it stands on the soil and can be levelled up', () => {
  const { game, p } = potGame();
  place(game, 'p', -5, 10);
  const [pot] = pots(game);
  const idx = game.slots.findIndex((s) => s.pot === pot.id);
  p.x = -4.5;
  p.z = 8.5;
  game.drainEvents();
  game.handleInput('p', { plant: 2, plantSeq: 1 }); // key 2 = Cactus (tier 0)
  game.tick(1 / 30);
  const g = entitiesOfKind(game, 'garden')[0];
  assert.ok(g, 'planted in the pot');
  assert.equal(g.plantKind, 'cactus');
  assert.equal(g.slot, idx);
  assert.deepEqual([g.x, g.z], [-4.5, 10.5]);
  assert.equal(g.y, DEFAULT_CONFIG.pots.sit, 'stands up on the pot soil');
  assert.equal(game.slots[idx].plantId, g.id);
  assert.ok(game.drainEvents().some((e) => e.type === 'plant' && e.id === g.id));
  // the slot is taken now
  game.handleInput('p', { plant: 1, plantSeq: 2 });
  game.tick(1 / 30);
  assert.equal(entitiesOfKind(game, 'garden').length, 1);
  // upgrade like any plant
  p.sunshine = 500;
  const before = p.sunshine;
  game.handleInput('p', { upgrade: true, yaw: Math.PI });
  game.tick(1 / 30);
  game.handleInput('p', { upgrade: false });
  assert.equal(g.level, 2);
  assert.ok(p.sunshine < before);
  assert.equal(g.maxHp, Math.round(DEFAULT_CONFIG.gardenPlantHp * levelScale(game.config, 2).hp));
  // it shoots from up there
  const zb = game.spawnBot('zombie', -4.5, 16.5);
  zb.hp = zb.maxHp = 1e6;
  game.drainEvents();
  run(game, 4);
  assert.ok(game.drainEvents().some((e) => e.type === 'hit' && e.id === zb.id && e.by === g.id), 'the potted Cactus shot a zombie in the kitchen');
});

test('a Wall-nut in a pot does not add a second solid blob: the pot is the only thing that blocks', () => {
  const { game, p } = potGame();
  place(game, 'p', -5, 10);
  p.tier = 7;
  p.x = -4.5;
  p.z = 8.5;
  game.handleInput('p', { plant: 7, plantSeq: 1 });
  game.tick(1 / 30);
  const nut = entitiesOfKind(game, 'garden').find((g) => g.plantKind === 'wallnut');
  assert.ok(nut, 'wall-nut planted');
  assert.equal(nut.blocks, undefined);
});

test('breaking the pot destroys the plant in it; the zombie kid is paid for both; the slot is reused by the next pot', () => {
  const { game, p, z } = potGame();
  place(game, 'p', -5, 10);
  const [pot] = pots(game);
  p.x = -4.5;
  p.z = 8.5;
  game.handleInput('p', { plant: 1, plantSeq: 1 });
  game.tick(1 / 30);
  const g = entitiesOfKind(game, 'garden')[0];
  const slotsN = game.slots.length;
  const idx = g.slot;
  game.drainEvents();
  const brains0 = z.brains;
  game.cover.damage(pot, 1000, z, 'zombie');
  assert.equal(pot.state, 'broken');
  assert.equal(game.entities.has(g.id), false, 'the plant went with it');
  assert.equal(entitiesOfKind(game, 'garden').length, 0);
  const evs = game.drainEvents();
  assert.ok(evs.some((e) => e.type === 'coverBreak' && e.id === pot.id));
  assert.ok(evs.some((e) => e.type === 'wilt' && e.id === g.id && e.plantKind === 'peashooter'));
  assert.ok(z.brains > brains0, 'brains for the hit and the turret');
  assert.equal(game.slots[idx].disabled, true);
  assert.equal(game.slots.length, slotsN);
  assert.equal(game.mapState().builds.some((b) => b.id === pot.id), false);
  // a disabled slot takes no plant
  p.x = -4.5;
  p.z = 8.5;
  game.handleInput('p', { plant: 1, plantSeq: 2 });
  game.tick(1 / 30);
  assert.equal(entitiesOfKind(game, 'garden').length, 0);
  // the next pot takes the slot over
  p.x = -2;
  p.z = 11;
  place(game, 'p', -5, 13);
  assert.equal(game.slots.length, slotsN, 'slot reused, list does not grow');
  assert.equal(game.slots[idx].disabled, undefined);
  assert.equal(game.slots[idx].z, 13.5);
});

test('zombie shots and tools damage a pot; the plant team cannot hurt its own', () => {
  const { game, p, z } = potGame();
  place(game, 'p', -5, 10);
  const [pot] = pots(game);
  assert.equal(game.cover.canHurt(pot, 'zombie'), true);
  assert.equal(game.cover.canHurt(pot, 'plant'), false);
  assert.equal(game.cover.damage(pot, 10, p, 'plant'), false);
  assert.equal(pot.hp, DEFAULT_CONFIG.builds.plant[POT - 1].hp);
  assert.equal(game.cover.damage(pot, 10, z, 'zombie'), true);
  assert.equal(pot.hp, DEFAULT_CONFIG.builds.plant[POT - 1].hp - 10);
});

test('a new round clears every pot and its slot', () => {
  const { game, p } = potGame();
  place(game, 'p', -5, 10);
  p.x = -4.5;
  p.z = 8.5;
  game.handleInput('p', { plant: 1, plantSeq: 1 });
  game.tick(1 / 30);
  assert.equal(entitiesOfKind(game, 'garden').length, 1);
  game.startRound();
  assert.equal(pots(game).length, 0);
  assert.equal(game.slots.length, 64);
  assert.equal(entitiesOfKind(game, 'garden').length, 0);
  assert.deepEqual(game.mapState().builds, []);
});

test('no layout of pots can wall the house off: with every pot the rules allow, the fridge is still reachable from every door', () => {
  const { game, p } = potGame();
  const rules = rulesOf(game.config);
  // greedily fill the house: lowest-cost cells first, as many players as it takes
  let n = 0;
  for (let gz = 7; gz <= 23; gz++) {
    for (let gx = -13; gx <= 7; gx++) {
      const owner = `o${Math.floor(n / 10)}`;
      if (!game.entities.has(owner)) {
        const o = game.addPlayer(owner, { team: 'plant', mode: 'versus' });
        o.sunshine = 1e6;
      }
      const o = game.entities.get(owner);
      o.x = gx + 0.5;
      o.z = gz + 3;
      if (potProblem(rules, gx, gz)) continue;
      o.x = -1;
      o.z = 12;
      const r = checkBuild(game, o, potDef(), gx, gz, 0, { free: true });
      if (!r.ok) continue;
      game.cover.addBuild(DEFAULT_CONFIG.builds.plant[POT - 1], o, gx, gz, 0, r);
      n++;
    }
  }
  assert.ok(n >= 12, `${n} pots`);
  void p;
  // flood fill over free 0.25 m cells for a person-sized circle
  const free = (x, z) => {
    const q = { x, z };
    game.field.resolve(q, 0.5, 0, 1.8, 'zombie');
    return Math.abs(q.x - x) < 1e-6 && Math.abs(q.z - z) < 1e-6;
  };
  const step = 0.25;
  const seen = new Set();
  const key = (x, z) => `${Math.round(x / step)},${Math.round(z / step)}`;
  const start = [5, 12];
  const goal = [WORLD.fridge.stand.x, WORLD.fridge.stand.z];
  const queue = [start];
  seen.add(key(...start));
  const reach = new Set();
  while (queue.length) {
    const [x, z] = queue.pop();
    for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < -13.7 || nx > 7.9 || nz < 6.3 || nz > 23.7 || seen.has(key(nx, nz)) || !free(nx, nz)) continue;
      seen.add(key(nx, nz));
      queue.push([nx, nz]);
    }
  }
  reach.add(key(...goal));
  assert.ok(seen.has(key(...goal)), 'the fridge spot is reachable from the hall');
  for (const id of ['in_front', 'hall', 'in_back', 'hall_w', 'kit_e', 'kitchen', 'kit_w', 'lk', 'living', 'in_side', 'fridge']) {
    const [x, z] = MAP.nodes[id];
    assert.ok(seen.has(key(x, z)), `waypoint ${id} (${x}, ${z}) is still connected to the hall`);
  }
  void MAP; void POT_LANES; void insideStatic; void applyDamage;
});
