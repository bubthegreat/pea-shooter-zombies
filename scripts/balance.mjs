// Headless balance harness (command line). The scripted kids and scenarios live in balance-lib.mjs, the worker pool in balance-pool.mjs.
//
//   node scripts/balance.mjs [seeds=24]                  the difficulty ladder: every scenario kind at all seven levels (a table)
//   node scripts/balance.mjs [seeds=24] zraid-insane ...   detail lines (win rates, doors, routes, turrets...) for named scenarios
//
// The level toughens the team the kids are fighting (game.recomputeScaling): afk / decent / good scale the zombie bots, zraid / zpro / zsolo the
// plant side (the kid's own zombie allies stay at Normal), versus both (the plant side at half toughness).
// Kinds: afk (a plant kid who never plants), decent (the scripted kid), good (a plant kid played by the Gardener's planner: a much
// better kid), versus (decent kid vs the zombie autopilot kid), zraid (zombie autopilot kid + bots vs the Gardener(s)), zsolo (a
// strong zombie kid alone vs the Gardener(s), no bots; zpro: a superhuman kid + Normal bots vs the Gardener(s)). Levels: easy normal hard veryhard expert nightmare insane.
//
// Overrides: BAL_CFG='{"fridge":{"fillSeconds":12},"doorHp":{"front":200}}' (top level shallow-merged; nested objects merged
// one level deep), BAL_KIDFIRE=0.5 (the zombie autopilot kid's fire-rate scale). Everything here is simulated time.
import { SCENARIOS, LEVEL_IDS } from './balance-lib.mjs';
import { playMany, summarize } from './balance-pool.mjs';

const nSeeds = Number(process.argv[2]) || 24;
const wanted = process.argv.slice(3);
const fmt = (x, d = 1) => x.toFixed(d);

async function ladder() {
  const kinds = ['afk', 'decent', 'good', 'versus', 'zraid', 'zpro', 'zsolo'];
  const jobs = [];
  for (const kind of kinds) for (const level of LEVEL_IDS) for (let seed = 1; seed <= nSeeds; seed++) jobs.push({ kind, level, seed });
  const rs = await playMany(jobs);
  const head = `${'zombie win % (mean round s)'.padEnd(28)}${LEVEL_IDS.map((l) => l.padStart(12)).join('')}`;
  console.log(head);
  for (const kind of kinds) {
    const cells = LEVEL_IDS.map((level) => {
      const s = summarize(rs.filter((x) => x.job.kind === kind && x.job.level === level));
      return `${Math.round(s.zombieRate * 100)}% (${Math.round(s.meanT)}s)`.padStart(12);
    });
    console.log(`${kind.padEnd(28)}${cells.join('')}`);
  }
  console.log(`\n${nSeeds} seeds per cell. afk/decent/good/versus: plant kid vs bots (versus: a zombie kid too); zraid/zpro/zsolo: zombie kid vs the Gardener(s).\nThe level toughens the team the kids are fighting: plants-only kids -> zombie bots; zombie-only kids -> doors, plants, pots, Gardeners (their allies stay Normal); versus -> both.`);
}

async function detail() {
  for (const name of wanted) {
    const sc = SCENARIOS[name];
    if (!sc) {
      console.log(`${name}: unknown scenario (try afk-easy, decent-hard, good-insane, zraid-normal, zsolo-expert, versus-insane, clumsy-normal)`);
      continue;
    }
    const jobs = [];
    for (let seed = 1; seed <= nSeeds; seed++) jobs.push({ name, seed });
    const done = await playMany(jobs);
    const rs = done.map((x) => x.result);
    const n = rs.length;
    const sum = (f) => rs.reduce((a, r) => a + f(r), 0);
    const count = (f) => rs.filter(f).length;
    const route = (k) => `${k[0].toUpperCase()}${fmt(sum((r) => r.reached[k]) / Math.max(1, sum((r) => r.spawned[k])) * 100, 0)}%/${fmt(sum((r) => r.spawned[k]) / n, 0)}`;
    const line = [
      name.padEnd(16),
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
}

if (wanted.length) await detail();
else await ladder();
