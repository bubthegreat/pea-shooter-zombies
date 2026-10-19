// Runs seeded balance rounds on a pool of worker threads (every round is independent and pure).
//   const rs = await playMany([{ name: 'good-hard', seed: 3 }, ...]);   // -> [{ job, result }]
// `name` is a key of SCENARIOS in balance-lib.mjs (or pass `kind` + `level`).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, scenarioFor, runRound } from './balance-lib.mjs';

if (!isMainThread && workerData && workerData.balanceWorker) {
  parentPort.on('message', (job) => {
    const sc = job.name ? SCENARIOS[job.name] : scenarioFor(job.kind, job.level);
    const r = runRound(job.seed, sc);
    delete r.seen; // Sets do not matter outside
    delete r.at;
    parentPort.postMessage({ id: job.id, result: r });
  });
}

/** Play every job; returns the results in the same order as the jobs. */
export function playMany(jobs, workers = Math.max(1, Math.min(os.cpus().length - 1, 16))) {
  return new Promise((resolve, reject) => {
    const out = new Array(jobs.length);
    let next = 0;
    let done = 0;
    if (!jobs.length) return resolve(out);
    const pool = [];
    const feed = (w) => {
      if (next >= jobs.length) {
        w.terminate();
        return;
      }
      const id = next++;
      w.postMessage({ ...jobs[id], id });
    };
    for (let i = 0; i < Math.min(workers, jobs.length); i++) {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { balanceWorker: true } });
      pool.push(w);
      w.on('message', ({ id, result }) => {
        out[id] = { job: jobs[id], result };
        done++;
        if (done === jobs.length) {
          for (const p of pool) p.terminate();
          resolve(out);
        } else feed(w);
      });
      w.on('error', reject);
      feed(w);
    }
  });
}

/** Summary of finished rounds: zombie win share, mean round length (s), mean fridge meter, doors broken per round. */
export function summarize(results) {
  const n = results.length;
  const sum = (f) => results.reduce((a, x) => a + f(x.result), 0);
  return {
    n,
    zombieWins: results.filter((x) => x.result.winner === 'zombie').length,
    zombieRate: results.filter((x) => x.result.winner === 'zombie').length / n,
    meanT: sum((r) => r.t) / n,
    meanFridge: sum((r) => r.fridgeMax) / n,
    doorsBroken: sum((r) => r.doorsBroken) / n,
  };
}
