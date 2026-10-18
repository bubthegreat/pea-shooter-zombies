// Bot navigation: a hand-placed waypoint graph (map.js NODES / EDGES) with all-pairs shortest paths, and a planner that
// turns "I am here, I want to be there" into a short list of points to walk through.
import { MAP } from './map.js';

const ids = Object.keys(MAP.nodes);
const index = new Map(ids.map((id, i) => [id, i]));
const N = ids.length;
const px = ids.map((id) => MAP.nodes[id][0]);
const pz = ids.map((id) => MAP.nodes[id][1]);

// Floyd-Warshall (N is ~70): dist[a][b] and nextHop[a][b]
const dist = Array.from({ length: N }, () => new Float64Array(N).fill(Infinity));
const nextHop = Array.from({ length: N }, () => new Int16Array(N).fill(-1));
for (let i = 0; i < N; i++) {
  dist[i][i] = 0;
  nextHop[i][i] = i;
}
for (const [a, b] of MAP.edges) {
  const i = index.get(a);
  const j = index.get(b);
  if (i === undefined || j === undefined) throw new Error(`nav edge ${a}-${b} has an unknown node`);
  const d = Math.hypot(px[i] - px[j], pz[i] - pz[j]);
  dist[i][j] = dist[j][i] = d;
  nextHop[i][j] = j;
  nextHop[j][i] = i;
}
for (let k = 0; k < N; k++) {
  for (let i = 0; i < N; i++) {
    if (dist[i][k] === Infinity) continue;
    for (let j = 0; j < N; j++) {
      const d = dist[i][k] + dist[k][j];
      if (d < dist[i][j]) {
        dist[i][j] = d;
        nextHop[i][j] = nextHop[i][k];
      }
    }
  }
}

export const NAV_IDS = ids;

export function nodePos(id) {
  const i = index.get(id);
  return i === undefined ? null : { x: px[i], z: pz[i] };
}

/** Graph distance between two named nodes (Infinity if disconnected). */
export function nodeDistance(a, b) {
  return dist[index.get(a)][index.get(b)];
}

/** Node names on the shortest path a -> b (inclusive). */
export function nodePath(a, b) {
  let i = index.get(a);
  const j = index.get(b);
  const out = [ids[i]];
  while (i !== j) {
    i = nextHop[i][j];
    if (i < 0) return null;
    out.push(ids[i]);
  }
  return out;
}

/** Nodes within `range` of (x, z) with an unobstructed walk line. */
function visibleNodes(field, x, z, team, range) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const d = Math.hypot(px[i] - x, pz[i] - z);
    if (d > range) continue;
    if (d < 1.2 || field.walkLine(x, z, px[i], pz[i], team)) out.push([i, d]);
  }
  return out;
}

/**
 * Points to walk through from (fx, fz) to (tx, tz), ending at the target. A straight line if one is free; otherwise
 * through the cheapest pair of visible waypoints. `team` decides which doors count as walls.
 * Returns [{x, z}, ...] (never empty).
 */
export function planRoute(field, fx, fz, tx, tz, team = null) {
  const goal = { x: tx, z: tz };
  if (field.walkLine(fx, fz, tx, tz, team)) return [goal];
  let starts = visibleNodes(field, fx, fz, team, 26);
  let ends = visibleNodes(field, tx, tz, team, 26);
  if (!starts.length) starts = visibleNodes(field, fx, fz, team, 60);
  if (!ends.length) ends = visibleNodes(field, tx, tz, team, 60);
  if (!starts.length || !ends.length) {
    // boxed in (a fresh build, say): head for the nearest waypoint anyway
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(px[i] - fx, pz[i] - fz);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return [{ x: px[best], z: pz[best] }, goal];
  }
  let bi = -1;
  let bj = -1;
  let bc = Infinity;
  for (const [i, di] of starts) {
    for (const [j, dj] of ends) {
      const c = di + dist[i][j] + dj;
      if (c < bc) {
        bc = c;
        bi = i;
        bj = j;
      }
    }
  }
  const pts = [];
  let i = bi;
  pts.push({ x: px[i], z: pz[i] });
  while (i !== bj) {
    i = nextHop[i][bj];
    if (i < 0) break;
    pts.push({ x: px[i], z: pz[i] });
  }
  pts.push(goal);
  return pts;
}

/** Pick a route family and door itinerary by weight with a uniform random draw r in [0, 1). */
export function chooseItinerary(rng) {
  const fams = Object.entries(MAP.routes);
  let r = rng() * fams.reduce((a, [, f]) => a + f.weight, 0);
  let fam = fams[fams.length - 1];
  for (const f of fams) {
    r -= f[1].weight;
    if (r < 0) {
      fam = f;
      break;
    }
  }
  const [name, family] = fam;
  let v = rng() * family.variants.reduce((a, x) => a + x.weight, 0);
  let variant = family.variants[family.variants.length - 1];
  for (const x of family.variants) {
    v -= x.weight;
    if (v < 0) {
      variant = x;
      break;
    }
  }
  return { route: name, door: variant.door, nodes: variant.nodes.map((n) => nodePos(n)) };
}

/** The itinerary of one specific route + door (tests, scripted kids), or null. */
export function itineraryFor(route, door) {
  const v = MAP.routes[route]?.variants.find((x) => x.door === door);
  return v ? { route, door, nodes: v.nodes.map((n) => nodePos(n)) } : null;
}
