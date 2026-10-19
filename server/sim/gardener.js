// The smart Gardener (levels Hard and up; config.difficulties[..].gardener.brain === 'smart'). The basic Gardener (Easy,
// Normal) lives in bots.js and walks the slots; this one plans:
//
//  - it WATCHES all four doors: for each, the zombies heading for it or near it against the firepower of its garden plot,
//    and spends where the need is greatest (the weakest, least planted, most threatened door first);
//  - it plants a sensible mix by slot role (long range at the back, shotguns and slows at the front, Wall-nuts at the
//    chokepoint), unlocking better plants over the round, then upgrades the plants of the busiest plot;
//  - it builds forts across the zombies' approaches, repairs and rebuilds doors at the repair piles, replants what dies;
//  - when a door has fallen and zombies are inside, one Gardener falls back to the kitchen to guard the fridge, putting
//    flower pots with plants in them around it;
//  - it collects sunshine (what converted zombies leave behind), shoots with lead, headshots and strafing.
//
// Everything is scaled by the level table (config.difficulties[level].gardener); see config.js for the knobs.
import { WORLD, doorFace, inRect, slotIndex } from './world.js';
import { MAP } from './map.js';
import { createField } from './collide.js';
import { planRoute } from './nav.js';
import { tryPlant, tryUpgrade, upgradeCost, levelScale } from './garden.js';
import { plantPower as power } from './intel.js';
import { tryBuild, checkBuild } from './build.js';
import { potProblem, rulesOf } from './pots.js';
import { pileNear } from './repair.js';
import { dist2D, yawTo } from './vec.js';
import { setMoveKeys, nextPoint, setPath, checkStuck, pieceTarget, blockerPiece } from './botkit.js';

const DOORS = WORLD.doors; // front, side, back, garage (the same order as PLOTS and the snapshot's doors)
const STAND = WORLD.fridge.stand;
const isFighter = (e) => e.kind === 'player' || e.kind === 'bot';
const inHouse = (x, z) => inRect(WORLD.house, x, z) || inRect(WORLD.garage, x, z);

// ---- static knowledge (computed once) ------------------------------------------------------------------------------------

/** How likely a door is to be where the zombie bots go, from the route odds (sums to 1). */
const PRIOR = DOORS.map((d) => {
  let w = 0;
  for (const fam of Object.values(MAP.routes)) {
    const sum = fam.variants.reduce((a, v) => a + v.weight, 0);
    for (const v of fam.variants) if (v.door === d.id) w += (fam.weight * v.weight) / sum;
  }
  return w;
});

// Plot slots in the order a plot is filled, with the role of each slot: [row, col, role]. Row 0 faces the zombies.
const TEMPLATE = [
  [2, 1, 'gun'], [3, 1, 'snipe'], [2, 2, 'gun'], [3, 2, 'snipe'],
  [1, 1, 'slow'], [1, 2, 'slow'], [0, 1, 'tank'], [0, 2, 'tank'],
  [1, 0, 'close'], [1, 3, 'close'], [3, 0, 'snipe'], [3, 3, 'snipe'],
  [2, 0, 'gun'], [2, 3, 'gun'], [0, 0, 'close'], [0, 3, 'close'],
];
// Best first. Cheaper kinds are the fallback when the best one is not unlocked yet or not affordable.
const PREFS = {
  snipe: ['melonpult', 'houseplant', 'cactus'],
  gun: ['gatling', 'repeater', 'peashooter'],
  slow: ['snowpea', 'repeater', 'peashooter'],
  close: ['spikesquash', 'repeater', 'peashooter'],
  tank: ['wallnut'],
  pot: ['spikesquash', 'gatling', 'repeater', 'snowpea', 'peashooter'],
};

/** Points along every route to a door, walking back from the door, where a fort across the path makes the zombies stop and shoot. */
const FORT_SPOTS = DOORS.map((d) => {
  const out = [];
  for (const fam of Object.values(MAP.routes)) {
    for (const v of fam.variants) {
      if (v.door !== d.id) continue;
      const pts = v.nodes.map((n) => MAP.nodes[n]);
      for (const back of [18, 22, 26, 30, 34, 38]) {
        // walk back along the polyline
        let left = back;
        for (let i = pts.length - 1; i > 0; i--) {
          const [bx, bz] = pts[i];
          const [ax, az] = pts[i - 1];
          const len = Math.hypot(bx - ax, bz - az);
          if (left <= len) {
            const f = left / len;
            const x = bx + (ax - bx) * f;
            const z = bz + (az - bz) * f;
            const dx = (bx - ax) / len;
            const dz = (bz - az) / len;
            const rot = Math.abs(dz) > Math.abs(dx) ? 0 : 1; // wall across the direction of travel
            for (const off of [0, 3, -3, 6, -6]) {
              const cx = x - dz * off;
              const cz = z + dx * off;
              out.push(rot === 0 ? { gx: Math.round(cx - 1.5), gz: Math.round(cz - 0.5), rot } : { gx: Math.round(cx - 0.5), gz: Math.round(cz - 1.5), rot });
            }
            break;
          }
          left -= len;
        }
      }
    }
  }
  const seen = new Set();
  return out.filter((s) => {
    const k = `${s.gx},${s.gz},${s.rot}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
});

let staticField = null;
let potCellsCache = null;
let guardCache = null;

function statics() {
  staticField ??= createField();
  return staticField;
}

/** Floor cells (grid corners) where a pot may stand from the map rules alone, best spots round the fridge first. */
function potCells(config) {
  if (potCellsCache) return potCellsCache;
  const rules = rulesOf(config);
  const f = statics();
  const out = [];
  for (let gz = 7; gz <= 23; gz++) {
    for (let gx = -13; gx <= 7; gx++) {
      if (potProblem(rules, gx, gz)) continue;
      let hit = false;
      f.each(gx, gx + 1, gz, gz + 1, (c) => {
        if (hit || c.blocks === false || c.y1 <= 0.3 || c.y0 >= 0.7) return;
        if (c.s === 'box') hit = c.minX < gx + 1 && c.maxX > gx && c.minZ < gz + 1 && c.maxZ > gz;
        else hit = Math.hypot(c.x - (gx + 0.5), c.z - (gz + 0.5)) < c.r + 0.5;
      });
      if (hit) continue;
      const cx = gx + 0.5;
      const cz = gz + 0.5;
      const d = Math.hypot(cx - STAND.x, cz - STAND.z);
      if (d > 8) continue;
      const los = f.clearLine(cx, 1.2, cz, STAND.x, 1.2, STAND.z, 'plant') ? 1 : 0;
      const west = f.clearLine(cx, 1.2, cz, -6, 1.2, 15, 'plant') ? 1 : 0; // sees the living-room doorway
      const east = f.clearLine(cx, 1.2, cz, 2, 1.2, 15, 'plant') ? 1 : 0; // sees the hall doorway
      out.push({ gx, gz, score: los * 10 + (west + east) * 2.5 - Math.abs(d - 4) * 1.2 });
    }
  }
  out.sort((a, b) => b.score - a.score);
  potCellsCache = out;
  return out;
}

/** Spots in the kitchen from which the fridge and both doorways can be seen. */
function guardSpots() {
  if (guardCache) return guardCache;
  const f = statics();
  const out = [];
  for (let x = -5; x <= 1; x += 1) {
    for (let z = 15.5; z <= 21; z += 1) {
      const q = { x, z };
      f.resolve(q, 0.55, 0, 1.8, 'plant');
      if (Math.abs(q.x - x) > 1e-6 || Math.abs(q.z - z) > 1e-6) continue;
      const d = Math.hypot(x - STAND.x, z - STAND.z);
      if (d < 3 || d > 7) continue;
      if (!f.clearLine(x, 1.4, z, STAND.x, 1.0, STAND.z, 'plant')) continue;
      out.push({ x, z, d });
    }
  }
  guardCache = out;
  return out;
}

// ---- per-tick shared analysis -----------------------------------------------------------------------------------------------

/** The state of the four doors, the zombies and the plots, computed once per tick for every Gardener. */
function analyse(game, ctx, gc) {
  const ga = (game._ga ??= { t: -1 });
  if (ga.t === game.time) return ga;
  ga.t = game.time;
  const c = game.config;
  const plotPower = [0, 0, 0, 0];
  const plotCount = [0, 0, 0, 0];
  const plotEmpty = [0, 0, 0, 0];
  for (const s of game.slots) if (s.plot >= 0 && !s.disabled && !s.plantId) plotEmpty[s.plot]++;
  let plants = 0;
  for (const g of ctx.gardenPlants) {
    if (g.state !== 'alive') continue;
    const s = game.slots[g.slot];
    if (s && s.plot >= 0) {
      plotPower[s.plot] += power(c, g);
      plotCount[s.plot]++;
    }
    plants++;
  }
  const insideZ = [];
  const fridgeZ = [];
  for (const z of ctx.zombieSide) {
    if (z.state !== 'alive' || game.isHeld(z)) continue;
    if (inRect(WORLD.house, z.x, z.z, 0.3) && z.y > -1) insideZ.push(z); // (zombies fetching parts in the garage are not a fridge raid)
    if (dist2D(z.x, z.z, STAND.x, STAND.z) < 5) fridgeZ.push(z);
  }
  ga.doors = DOORS.map((d, i) => {
    const piece = game.cover.get(`door:${d.id}`);
    const face = doorFace(d);
    let threat = 0;
    for (const z of ctx.zombieSide) {
      if (z.state !== 'alive') continue;
      const held = game.isHeld(z); // still waiting in the gate pen
      const dd = dist2D(z.x, z.z, face.x, face.z);
      if (!held && dd < 45) threat += 1 - dd / 45;
      if (z.ai && z.ai.itin && z.ai.itin.door === d.id && (held || dd >= 45)) threat += 0.4; // on its way there
    }
    const broken = !piece || piece.state !== 'alive';
    return {
      i,
      id: d.id,
      piece,
      broken,
      frac: broken ? 0 : piece.hp / piece.maxHp,
      face,
      pile: WORLD.repair.find((r) => r.door === d.id),
      power: plotPower[i],
      count: plotCount[i],
      empty: plotEmpty[i],
      threat,
      need: (threat * 2 + PRIOR[i] * 10 + (broken ? 4 : 0)) / (plotPower[i] + 5),
    };
  });
  ga.plants = plants;
  ga.insideZ = insideZ;
  ga.fridgeZ = fridgeZ;
  ga.anyBroken = ga.doors.some((d) => d.broken);
  ga.danger = insideZ.length > 0;
  // the one Gardener who guards the fridge: the nearest to it, kept while the danger lasts
  const smart = [];
  for (const e of game.entities.values()) if (((e.kind === 'bot' && e.isGardener) || e.autopilotPlant) && e.state === 'alive') smart.push(e);
  if (ga.danger) ga.dangerT = game.time;
  if (ga.defender) {
    const d = game.entities.get(ga.defender);
    if (!d || d.state !== 'alive' || game.time - (ga.dangerT ?? -99) > 4) ga.defender = null;
  }
  if (!ga.defender && ga.danger && gc.retreat) {
    let best = null;
    let bd = Infinity;
    for (const e of smart) {
      const d = dist2D(e.x, e.z, STAND.x, STAND.z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (best) ga.defender = best.id;
  }
  ga.smart = smart;
  return ga;
}

// ---- helpers ------------------------------------------------------------------------------------------------------------------

function unlocked(c, tier) {
  return (k) => (c.plantTypes[k]?.tier ?? 0) <= tier;
}

/** The best kind for a role: unlocked and affordable, in preference order; null when none. */
function chooseKind(c, role, tier, sun) {
  const ok = unlocked(c, tier);
  for (const k of PREFS[role]) if (ok(k) && c.plantTypes[k].cost <= sun) return k;
  return null;
}

function emptySlot(game, door, row, col) {
  const i = slotIndex(door, row, col);
  const s = game.slots[i];
  return s && !s.plantId && !s.disabled ? i : -1;
}

function myPots(game, b) {
  return game.cover.buildsOf(b.id, 'pot');
}

function nearestZombieDist(ctx, x, z) {
  let m = Infinity;
  for (const e of ctx.zombieSide) {
    if (e.state !== 'alive') continue;
    const d = dist2D(x, z, e.x, e.z);
    if (d < m) m = d;
  }
  return m;
}

// ---- choosing what to do ------------------------------------------------------------------------------------------------------

/** A planting task: the empty template slot of the given door that suits the money and the unlocked plants. */
function plantTask(game, b, G, gc, door) {
  const c = game.config;
  for (const [row, col, role] of TEMPLATE) {
    const slot = emptySlot(game, door, row, col);
    if (slot < 0) continue;
    const kind = chooseKind(c, role, b.tier, b.sunshine);
    if (kind) return { type: 'plant', slot, kind, door };
  }
  return null;
}

/** Can this build stand on that footprint (map, cover, other builds, people)? A stand-in builder right on it, so range never matters. */
function spotOk(game, def, gx, gz, rot) {
  const w = rot ? def.d : def.w;
  const d = rot ? def.w : def.d;
  return checkBuild(game, { x: gx + w / 2, z: gz + d / 2, y: 0, id: '-', team: 'plant', sunshine: 1e9 }, { ...def, team: 'plant' }, gx, gz, rot, { free: true }).ok;
}

/** A fort task: a free spot across one of the zombies' routes to this door. */
function fortTask(game, b, G, gc, door) {
  const c = game.config;
  const list = c.builds.plant;
  const kind = list.findIndex((x) => x.id === 'fence') + 1;
  const def = list[kind - 1];
  if (!def || b.sunshine < def.cost) return null;
  for (const sp of FORT_SPOTS[door]) {
    const key = `${sp.gx},${sp.gz},${sp.rot}`;
    if ((G.bad.get(key) ?? 0) > game.time) continue;
    if (!spotOk(game, def, sp.gx, sp.gz, sp.rot)) continue;
    return { type: 'fort', kind, gx: sp.gx, gz: sp.gz, rot: sp.rot, key, door };
  }
  return null;
}

function potTask(game, b, G, gc) {
  const c = game.config;
  const kind = c.builds.plant.findIndex((x) => x.pot) + 1;
  const def = c.builds.plant[kind - 1];
  if (!def || b.sunshine < def.cost + 50) return null;
  const rules = rulesOf(c);
  for (const sp of potCells(c)) {
    const key = `p${sp.gx},${sp.gz}`;
    if ((G.bad.get(key) ?? 0) > game.time) continue;
    let crowded = false;
    for (const p of game.cover.pieces.values()) {
      if (p.state === 'alive' && p.build?.kind === 'pot' && Math.hypot(p.x - (sp.gx + 0.5), p.z - (sp.gz + 0.5)) < rules.spacing) {
        crowded = true;
        break;
      }
    }
    if (crowded || !spotOk(game, def, sp.gx, sp.gz, 0)) continue;
    return { type: 'pot', kind, gx: sp.gx, gz: sp.gz, key };
  }
  return null;
}

/** Plant something short-range and strong in an empty pot of ours. */
function potPlantTask(game, b, G, gc) {
  const c = game.config;
  const kind = chooseKind(c, 'pot', b.tier, b.sunshine);
  if (!kind) return null;
  let best = -1;
  let bd = Infinity;
  game.slots.forEach((s, i) => {
    if (!s.pot || s.plantId || s.disabled) return;
    const piece = game.cover.get(s.pot);
    if (!piece || !piece.build || piece.build.by !== b.id) return;
    const d = dist2D(b.x, b.z, s.x, s.z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best >= 0 ? { type: 'plant', slot: best, kind, pot: true } : null;
}

/** Upgrade the plant of the busiest door that gains the most firepower per sunshine, if the money is there. */
function upgradeTask(game, b, G, gc, A, ctx) {
  const c = game.config;
  if (G.upT > 0) return null;
  let best = null;
  let bv = 0;
  for (const g of ctx.gardenPlants) {
    if (g.state !== 'alive') continue;
    const cost = upgradeCost(c, g.plantKind, g.level ?? 1);
    if (cost === null || b.sunshine < cost + gc.upgradeReserve) continue;
    if (c.plantTypes[g.plantKind].noAttack && (g.level ?? 1) >= 2) continue;
    const s = game.slots[g.slot];
    const door = s && s.plot >= 0 ? A.doors[s.plot] : null;
    const need = door ? door.need : 0.05;
    const t = c.plantTypes[g.plantKind];
    const L = g.level ?? 1;
    const s0 = levelScale(c, L);
    const s1 = levelScale(c, L + 1);
    const gain = t.noAttack ? 1.2 : t.damage * t.rate * (s1.damage * s1.rate - s0.damage * s0.rate) * (t.pellets ?? 1);
    const v = ((need + 0.02) * gain) / cost / (1 + dist2D(b.x, b.z, g.x, g.z) / 40);
    if (v > bv) {
      bv = v;
      best = g;
    }
  }
  return best ? { type: 'upgrade', plant: best.id } : null;
}

/** The Gardener tunables of whoever the planner drives: a Gardener bot (the level's), or a scripted kid with its own profile (balance harness). */
export function plannerConfig(game, b) {
  return b.gardenerCfg ? { ...game.config.gardener, ...b.gardenerCfg } : game.gardenerConfig();
}

/** Mend a door that is hurt (below the level's threshold) or broken, when nobody is shooting at it. */
function repairTask(game, b, G, gc, A, ctx) {
  if (!(gc.repair > 0)) return null;
  let best = null;
  let bs = 0;
  const taken = game._ga.repairBy ?? (game._ga.repairBy = {});
  for (const d of A.doors) {
    if (!d.pile) continue;
    const by = taken[d.id];
    if (by && by !== b.id) {
      const other = game.entities.get(by);
      if (other && other.state === 'alive' && other.ai && other.ai.g && other.ai.g.task && other.ai.g.task.type === 'repair' && other.ai.g.task.door === d.id) continue; // someone is on it
    }
    if (d.broken ? !gc.rebuild || A.danger : d.frac >= gc.repair) continue;
    const near = nearestZombieDist(ctx, d.pile.x, d.pile.z);
    const nearFace = nearestZombieDist(ctx, d.face.x, d.face.z);
    if (near < 9 || nearFace < 14) continue; // not while zombies are at the door
    const sc = (d.broken ? 1.2 : 1 - d.frac) * (1 + d.need) / (1 + dist2D(b.x, b.z, d.pile.x, d.pile.z) / 60);
    if (sc > bs) {
      bs = sc;
      best = d;
    }
  }
  return best ? { type: 'repair', door: best.id } : null;
}

function sunTask(game, b, ctx, range) {
  let best = null;
  let bd = range;
  for (const e of game.entities.values()) {
    if (e.kind !== 'sun' || e.state !== 'alive' || e.y > (e.ground ?? 0) + game.config.sunRestHeight + 0.05) continue;
    const d = dist2D(b.x, b.z, e.x, e.z);
    if (d < bd && nearestZombieDist(ctx, e.x, e.z) > 6) {
      bd = d;
      best = e;
    }
  }
  return best ? { type: 'sun', id: best.id } : null;
}

function guardTask(game, b, G, A) {
  const spots = guardSpots();
  let best = G.guard;
  if (!best || game.time - G.guardT > 2) {
    let bs = -Infinity;
    for (const s of spots) {
      let near = Infinity;
      for (const z of A.insideZ) near = Math.min(near, dist2D(s.x, s.z, z.x, z.z));
      const sc = Math.min(near, 12) * 1.0 - Math.abs(s.d - 5) * 1.5 - dist2D(b.x, b.z, s.x, s.z) * 0.1;
      if (sc > bs) {
        bs = sc;
        best = s;
      }
    }
    G.guard = best;
    G.guardT = game.time;
  }
  return best ? { type: 'guard', x: best.x, z: best.z } : { type: 'idle' };
}

/** The money and the work, in order: defend, mend, plant, fortify, pot, upgrade, fetch sun, wait. */
function chooseTask(game, b, ai, G, gc, A, ctx) {
  const c = game.config;
  const mine = A.smart.indexOf(b);
  const quiet = A.insideZ.length === 0;
  // 1. guard the fridge (the Gardener nearest to it, while zombies are inside the house)
  if (gc.retreat && A.defender === b.id) {
    // still useful indoors: a pot and a plant for the last line, when no zombie is within a few metres
    if (nearestZombieDist(ctx, b.x, b.z) > 7 && myPots(game, b) < gc.pots) {
      const t = potPlantTask(game, b, G, gc) ?? (A.fridgeZ.length === 0 ? potTask(game, b, G, gc) : null);
      if (t) return t;
    }
    return guardTask(game, b, G, A);
  }
  // 2. mend doors
  const rep = repairTask(game, b, G, gc, A, ctx);
  if (rep && (rep.door === G.repairDoor || A.doors.find((d) => d.id === rep.door).broken || quiet)) {
    G.repairDoor = rep.door;
    game._ga.repairBy[rep.door] = b.id;
    return rep;
  }
  // 3. sunshine lying close by (what converted zombies leave behind); a kid with nothing to spend goes a long way for it
  if (gc.collect) {
    const t = sunTask(game, b, ctx, !b.isGardener && b.sunshine < 60 ? 45 : Math.min(gc.collect, 9));
    if (t) return t;
  }
  // 4. plant / fortify, door by door, the neediest first (a Gardener prefers the doors of its own half and the door it is at)
  const order = A.doors
    .map((d) => ({ d, v: d.need * (G.door === d.i ? 1.35 : 1) * (mine >= 0 && A.smart.length > 1 && (d.i % 2 === mine % 2) ? 3 : 1) }))
    .sort((p, q) => q.v - p.v);
  for (const { d } of order) {
    if (d.count < 4) {
      const t = plantTask(game, b, G, gc, d.i);
      if (t) return t;
    }
  }
  // a door is down: the last line in the house comes before anything else
  if (gc.pots > 0 && A.anyBroken && myPots(game, b) < gc.pots && b.sunshine >= 75) {
    const t = potPlantTask(game, b, G, gc) ?? potTask(game, b, G, gc);
    if (t) return t;
  }
  const forts = game.cover.buildsOf(b.id, 'fort');
  if (gc.forts > 0 && forts < gc.forts && game.roundTime > 15 && b.sunshine >= 90) {
    const per = Math.ceil(gc.forts / 4);
    for (const { d } of order) {
      if (d.count < 4) continue;
      let have = 0;
      for (const p of game.cover.pieces.values()) if (p.build && p.build.by === b.id && p.state === 'alive' && p.build.kind !== 'pot' && p.door === d.i) have++;
      if (have >= per) continue;
      const t = fortTask(game, b, G, gc, d.i);
      if (t) return t;
    }
  }
  for (const { d } of order) {
    if (d.count < 8) {
      const t = plantTask(game, b, G, gc, d.i);
      if (t) return t;
    }
  }
  // 5. flower pots in the house: when doors have fallen, or the outside is well planted and there is money to spare
  if (gc.pots > 0 && myPots(game, b) < gc.pots && (A.anyBroken || A.plants >= 10) && b.sunshine >= 110) {
    const t = potPlantTask(game, b, G, gc) ?? potTask(game, b, G, gc);
    if (t) return t;
  }
  if (gc.pots > 0) {
    const t = potPlantTask(game, b, G, gc);
    if (t) return t;
  }
  // 6. upgrades
  const up = upgradeTask(game, b, G, gc, A, ctx);
  if (up) return up;
  // 7. the rest of every plot
  for (const { d } of order) {
    const t = plantTask(game, b, G, gc, d.i);
    if (t) return t;
  }
  // 8. sunshine further away (a kid has no income but what falls from the sky: it goes much further for it)
  if (gc.collect) {
    const t = sunTask(game, b, ctx, b.isGardener ? gc.collect : 45);
    if (t) return t;
  }
  void c;
  return { type: 'idle' };
}

// ---- executing a task ----------------------------------------------------------------------------------------------------------

/** Where the Gardener walks for a task, how close it must get, and whether it must stand still there. */
function destOf(game, b, task, ctx) {
  switch (task.type) {
    case 'plant': {
      const s = game.slots[task.slot];
      return s ? { x: s.x, z: s.z, stop: 1.8 } : null;
    }
    case 'upgrade': {
      const g = game.entities.get(task.plant);
      return g ? { x: g.x, z: g.z, stop: 1.8 } : null;
    }
    case 'fort': return { x: task.gx + 1.5, z: task.gz + 1.5, stop: 9 };
    case 'pot': return { x: task.gx + 0.5, z: task.gz + 0.5, stop: 2 };
    case 'repair': {
      const p = WORLD.repair.find((r) => r.door === task.door);
      return { x: p.x, z: p.z, stop: 0.5 };
    }
    case 'sun': {
      const e = game.entities.get(task.id);
      return e ? { x: e.x, z: e.z, stop: 0.3 } : null;
    }
    case 'guard': return { x: task.x, z: task.z, stop: 0.6 };
    default: return { x: 5, z: 12.5, stop: 1.5 }; // the hall: central, indoors, close to every door
  }
}

/** Do the thing when close enough. Returns true when the task is finished. */
function perform(game, b, ai, G, gc, task, ctx) {
  const c = game.config;
  switch (task.type) {
    case 'plant': {
      const s = game.slots[task.slot];
      if (!s || s.plantId || s.disabled) return true;
      if (dist2D(b.x, b.z, s.x, s.z) > 2.6) return false;
      tryPlant(game, b, task.kind, task.slot);
      if (task.door !== undefined) G.door = task.door;
      return true;
    }
    case 'upgrade': {
      const g = game.entities.get(task.plant);
      if (!g || g.state !== 'alive') return true;
      if (dist2D(b.x, b.z, g.x, g.z) > 2.6) return false;
      if (tryUpgrade(game, b, g)) G.upT = gc.upgradeInterval;
      else G.upT = 2;
      return true;
    }
    case 'fort': {
      const d = dist2D(b.x, b.z, task.gx + 1.5, task.gz + 1.5);
      if (d > 11) return false;
      const piece = tryBuild(game, b, task.kind, task.gx, task.gz, task.rot);
      if (piece) piece.door = task.door;
      else G.bad.set(task.key, game.time + 40);
      return true;
    }
    case 'pot': {
      const d = dist2D(b.x, b.z, task.gx + 0.5, task.gz + 0.5);
      if (d > 5.5 || !inRect(WORLD.house, b.x, b.z, 0.4)) return false;
      const piece = tryBuild(game, b, task.kind, task.gx, task.gz, 0);
      if (!piece) G.bad.set(task.key, game.time + 25);
      return true;
    }
    case 'repair': {
      const d = game.cover.get(`door:${task.door}`);
      if (!d) return true;
      const full = d.state === 'alive' && d.hp >= d.maxHp - 0.01;
      const pl = WORLD.repair.find((r) => r.door === task.door);
      const stop = nearestZombieDist(ctx, pl.x, pl.z) < 12;
      if (full || stop) return true;
      if (d.state === 'alive' && d.hp / d.maxHp >= Math.min(0.97, gc.repair + 0.25)) return true; // good enough for now
      const pile = pileNear(c, b.x, b.z);
      if (pile && pile.door === task.door && dist2D(b.x, b.z, pile.x, pile.z) < 1.2) {
        b.input.use = true; // hold E, standing still
        G.working = true;
      }
      return false;
    }
    case 'sun': {
      const e = game.entities.get(task.id);
      return !e || e.state !== 'alive';
    }
    default: return false; // guard / idle: until replaced
  }
}

// ---- aiming and moving -----------------------------------------------------------------------------------------------------------

/** Best living zombie to shoot: the raiders at the fridge first, then whoever is closest, with a clear line. */
function pickTarget(game, b, gc, ctx) {
  const c = game.config;
  const cand = [];
  for (const z of ctx.zombieSide) {
    if (z.state !== 'alive' || game.isHeld(z)) continue;
    const d = dist2D(b.x, b.z, z.x, z.z);
    if (d > gc.shootRange) continue;
    let sc = d;
    const df = dist2D(z.x, z.z, STAND.x, STAND.z);
    if (df < 4) sc -= 30;
    else if (inHouse(z.x, z.z)) sc -= 12;
    if (z.carry) sc -= 5;
    cand.push([sc, z]);
  }
  const m = game.mower;
  if (m && (m.state === 'driving' || m.state === 'starting')) {
    const d = dist2D(b.x, b.z, m.x, m.z);
    if (d <= gc.shootRange) cand.push([d - 8, m]);
  }
  cand.sort((p, q) => p[0] - q[0]);
  for (let i = 0; i < Math.min(5, cand.length); i++) {
    const t = cand[i][1];
    if (game.field.clearLine(b.x, b.y + c.eyeHeight, b.z, t.x, t.y + t.height * 0.6, t.z, 'plant')) return t;
  }
  return null;
}

/** Aim with the level's error, lead and head bias. */
function aim(game, b, ai, G, gc, t, dt) {
  const c = game.config;
  ai.errTimer -= dt;
  if (ai.errTimer <= 0) {
    ai.errTimer = c.botAimRerollInterval;
    ai.errYaw = (game.rng() * 2 - 1) * gc.aimError;
    ai.errPitch = (game.rng() * 2 - 1) * gc.aimError;
    G.head = game.rng() < gc.head;
  }
  const speed = c.plantTypes.peashooter.speed;
  const d = dist2D(b.x, b.z, t.x, t.z);
  const flight = d / 50; // pea blaster speed
  void speed;
  const lx = t.x + (t.vx ?? 0) * flight * gc.lead;
  const lz = t.z + (t.vz ?? 0) * flight * gc.lead;
  const dx = lx - b.x;
  const dz = lz - b.z;
  const hy = G.head && t.height > 1.5 ? 0.92 : 0.6;
  const dy = t.y + t.height * hy - (b.y + c.eyeHeight);
  b.yaw = yawTo(dx, dz) + ai.errYaw;
  b.pitch = Math.atan2(dy, Math.hypot(dx, dz)) + ai.errPitch;
}

function move(game, b, ai, G, gc, dest, stop, target, dt, canMove) {
  const c = game.config;
  const inp = b.input;
  const wp = canMove && dest ? nextPoint(b, ai, stop) : null;
  let dir = { x: 0, z: 0 };
  ai.moving = false;
  ai.dir = null;
  if (wp) {
    const dx = wp.x - b.x;
    const dz = wp.z - b.z;
    const d = Math.hypot(dx, dz) || 1;
    dir = { x: dx / d, z: dz / d };
    ai.moving = true;
    ai.dir = dir;
  }
  // strafing: while a zombie is in sight, drift sideways (and flip now and then) so slow goo shots miss
  if (target && gc.strafe > 0) {
    G.strafeT -= dt;
    if (G.strafeT <= 0) {
      G.strafeT = 0.5 + game.rng() * 0.8;
      G.strafeSide = game.rng() < 0.5 ? -1 : 1;
    }
    const dd = dist2D(b.x, b.z, target.x, target.z);
    if (dd < 24 && dd > 3) {
      const tx = (target.x - b.x) / dd;
      const tz = (target.z - b.z) / dd;
      const k = gc.strafe * 0.9;
      dir = { x: dir.x * (1 - k * 0.5) + -tz * G.strafeSide * k, z: dir.z * (1 - k * 0.5) + tx * G.strafeSide * k };
    }
  }
  if (ai.sideT > 0) {
    ai.sideT -= dt;
    const r = { x: -dir.z, z: dir.x };
    dir = { x: dir.x * 0.4 + r.x * ai.side * 0.9, z: dir.z * 0.4 + r.z * ai.side * 0.9 };
    if (ai.jump) {
      inp.keys.jump = true;
      ai.jump = false;
    }
  }
  // a ledge ahead that is too high to step up (the deck at the back door, a terrace) but low enough to jump: hop up it
  if (ai.moving && b.grounded && dir.x * dir.x + dir.z * dir.z > 0.01) {
    const rise = game.field.groundAt(b.x + dir.x * 0.9, b.z + dir.z * 0.9, b.y + 1.2) - b.y;
    if (rise > 0.55 && rise < 1.3) inp.keys.jump = true;
  }
  const blocker = blockerPiece(game, ai); // a zombie's fort wall across the way: shoot it down
  if (!target && blocker) target = pieceTarget(blocker);
  if (target) {
    aim(game, b, ai, G, gc, target, dt);
    ai.react -= dt;
    inp.fire = ai.react <= 0;
  } else if (ai.moving) {
    b.yaw = yawTo(dir.x, dir.z);
    b.pitch = 0;
  }
  setMoveKeys(b, dir.x, dir.z);
  void c;
}

// ---- the brain ----------------------------------------------------------------------------------------------------------------------

function initG(game, gc) {
  return { t: game.rng() * gc.think, task: null, taskT: 0, bad: new Map(), upT: gc.upgradeInterval * 0.5, door: -1, guard: null, guardT: -99, strafeT: 0, strafeSide: 1, head: false, repairDoor: null, working: false };
}

export function smartGardenerBrain(game, b, ai, ctx, dt) {
  const c = game.config;
  const gc = plannerConfig(game, b);
  const inp = b.input;
  inp.fire = false;
  inp.use = false;
  inp.keys.jump = false;
  if (b.isGardener) {
    // a Gardener has its own sunshine income and unlocks plants with time; a kid on autopilot earns both like any kid
    b.sunshine = Math.min(gc.maxSunshine, (b.sunshine ?? 0) + gc.income * dt);
    b.tier = Math.min(gc.tier, Math.floor(game.roundTime / gc.tierEvery));
    b.collect = gc.collect;
  }
  const G = (ai.g ??= initG(game, gc));
  G.upT -= dt;
  G.working = false;

  G.t -= dt;
  let target = ai.targetId ? game.entities.get(ai.targetId) ?? (game.mower && game.mower.id === ai.targetId ? game.mower : null) : null;
  if (target && target.kind !== 'mower' && target.state !== 'alive') target = null;
  if (target && target.kind === 'mower' && target.state !== 'driving' && target.state !== 'starting') target = null;
  if (G.t <= 0) {
    G.t += gc.think;
    const A = analyse(game, ctx, gc);
    const t = pickTarget(game, b, gc, ctx);
    const id = t ? t.id : null;
    if (id !== ai.targetId) {
      ai.targetId = id;
      ai.react = gc.reaction;
    }
    target = t;
    // keep a running task unless something more urgent shows up
    const cur = G.task;
    const indoors = cur && (cur.type === 'pot' || cur.type === 'guard' || (cur.type === 'plant' && cur.pot));
    const urgentDefend = gc.retreat && A.defender === b.id && cur && !indoors;
    if (!cur || cur.type === 'idle' || cur.type === 'guard' || urgentDefend || game.time - G.taskT > 12) {
      const next = chooseTask(game, b, ai, G, gc, A, ctx);
      if (!cur || next.type !== cur.type || next.slot !== cur.slot || next.door !== cur.door || next.x !== cur.x) {
        G.task = next;
        G.taskT = game.time;
        ai.replan = 0;
      }
    } else if (cur.type === 'repair') {
      // abort a repair when zombies show up at the door
      const p = WORLD.repair.find((r) => r.door === cur.door);
      if (nearestZombieDist(ctx, p.x, p.z) < 12) G.task = null;
    }
    checkStuck(game, b, ai, ai.dir, game.moveSpeedFor(b));
  }
  if (!G.task) G.task = { type: 'idle' };

  // walk to the task and do it
  const dest = destOf(game, b, G.task, ctx);
  let canMove = true;
  if (!dest) G.task = { type: 'idle' };
  else {
    const reachedXZ = dist2D(b.x, b.z, dest.x, dest.z) <= dest.stop;
    const done = perform(game, b, ai, G, gc, G.task, ctx);
    if (done) {
      G.task = null;
      G.t = 0; // decide again at once
    }
    if (G.task && (G.task.type === 'repair' && reachedXZ)) canMove = false;
    if (G.task && G.task.type === 'guard' && reachedXZ) canMove = false;
    ai.replan -= dt;
    if (G.task && (!ai.dest || Math.hypot(ai.dest.x - dest.x, ai.dest.z - dest.z) > 0.6 || ai.replan <= 0)) {
      ai.dest = { x: dest.x, z: dest.z };
      setPath(ai, planRoute(game.field, b.x, b.z, dest.x, dest.z, b.team));
      ai.replan = 1.8;
    }
  }
  const stop = dest ? dest.stop : 1.5;
  // a repair needs a still, quiet Gardener: no shooting, no moving
  const repairing = G.working && G.task && G.task.type === 'repair';
  move(game, b, ai, G, gc, dest, stop, repairing ? null : target, dt, canMove && !repairing);
  if (repairing) {
    inp.fire = false;
    inp.use = true;
    setMoveKeys(b, 0, 0);
  }
  void c;
}
