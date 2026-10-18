// Headless balance harness (command line). The scripted kids and scenarios live in balance-lib.mjs.
//
//   node scripts/balance.mjs [seeds=20] [scenario ...]
//
// Overrides: BAL_CFG='{"fridge":{"fillSeconds":12},"doorHp":{"front":200}}', BAL_KIDFIRE=0.5 (the zombie autopilot kid's fire-rate scale).
import { SCENARIOS, runRound } from './balance-lib.mjs';

const nSeeds = Number(process.argv[2]) || 20;
const wanted = process.argv.slice(3);
const fmt = (x, d = 1) => x.toFixed(d);
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const rs = [];
  for (let s = 1; s <= nSeeds; s++) rs.push(runRound(s, sc));
  const n = rs.length;
  const sum = (f) => rs.reduce((a, r) => a + f(r), 0);
  const count = (f) => rs.filter(f).length;
  const route = (k) => `${k[0].toUpperCase()}${fmt(sum((r) => r.reached[k]) / Math.max(1, sum((r) => r.spawned[k])) * 100, 0)}%/${fmt(sum((r) => r.spawned[k]) / n, 0)}`;
  const line = [
    name.padEnd(14),
    `zombieWins ${count((r) => r.winner === 'zombie')}/${n}`,
    `endT ${fmt(sum((r) => r.t) / n, 0)}s`,
    `fridgeMax ${fmt(sum((r) => r.fridgeMax) / n, 2)}`,
    `doorsBroken/rd ${fmt(sum((r) => r.doorsBroken) / n)}`,
    `firstDoor ${fmt(sum((r) => r.firstDoorT ?? 0) / Math.max(1, count((r) => r.firstDoorT !== null)), 0)}s`,
    `routes(reach%/spawned) ${route('front')} ${route('left')} ${route('right')}`,
    `garden ${fmt(sum((r) => r.minGarden) / n)}..${fmt(sum((r) => r.maxGarden) / n)}`,
    `planted/rd ${fmt(sum((r) => r.planted) / n)}`,
    `turretsLost/rd ${fmt(sum((r) => r.turretsLost) / n)}`,
    `forts/rd ${fmt(sum((r) => r.forts) / n)}`,
  ];
  if (sc.humans.some((h) => h.team === 'plant' && h.script)) line.push(`kidTier ${fmt(sum((r) => r.kidTier ?? 0) / n)}`, `kidKills ${fmt(sum((r) => r.kidKills) / n)}`);
  console.log(line.join(' | '));
}
