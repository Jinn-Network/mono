// Scored matrix runner: all (instance, trial) cells with bounded concurrency
// and resume-on-rerun (a cell with an existing result.json is skipped).
// Usage:
//   tsx src/run-matrix.ts <runLabel> --instances ../instances/scored \
//       [--trials 3] [--concurrency 2] [--filter substr] [--model <model>]
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTrial, RUNS_ROOT } from './lib/trial.js';
import type { TrialResult } from './lib/types.js';

interface Cell {
  instanceDir: string;
  trial: number;
}

function parseArgs(argv: string[]) {
  const runLabel = argv[0];
  if (!runLabel || runLabel.startsWith('--')) throw new Error('first arg must be runLabel');
  let instances = '';
  let trials = 3;
  let concurrency = 2;
  let filter = '';
  let model: string | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--instances') instances = argv[++i];
    else if (a === '--trials') trials = Number(argv[++i]);
    else if (a === '--concurrency') concurrency = Number(argv[++i]);
    else if (a === '--filter') filter = argv[++i];
    else if (a === '--model') model = argv[++i];
    else throw new Error(`unknown arg ${a}`);
  }
  if (!instances) throw new Error('need --instances');
  return { runLabel, instances, trials, concurrency, filter, model };
}

async function main() {
  const { runLabel, instances, trials, concurrency, filter, model } = parseArgs(process.argv.slice(2));

  const root = resolve(instances);
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.includes(filter))
    .map((d) => join(root, d.name))
    .sort();

  const cells: Cell[] = [];
  for (const dir of dirs) {
    for (let t = 1; t <= trials; t += 1) cells.push({ instanceDir: dir, trial: t });
  }

  // Resume: skip cells that already have a SCORED result. A result carrying an
  // `error` is an infra failure (anvil/upstream/API rate limit) — never a score,
  // so it is re-run rather than skipped.
  const pending = cells.filter((c) => {
    const id = c.instanceDir.split('/').pop()!;
    const p = join(RUNS_ROOT, runLabel, id, `t${c.trial}`, 'result.json');
    if (!existsSync(p)) return true;
    try {
      const prev = JSON.parse(readFileSync(p, 'utf8')) as TrialResult;
      return Boolean(prev.error);
    } catch {
      return true;
    }
  });
  console.log(`[matrix] ${cells.length} cells total, ${cells.length - pending.length} already done, ${pending.length} to run, concurrency=${concurrency}`);

  let idx = 0;
  let done = 0;
  const results: TrialResult[] = [];
  async function worker(w: number) {
    for (;;) {
      const i = idx;
      idx += 1;
      if (i >= pending.length) return;
      const cell = pending[i];
      const id = cell.instanceDir.split('/').pop()!;
      console.log(`[matrix][w${w}] ${id} t${cell.trial} start (${done}/${pending.length} done)`);
      try {
        const r = await runTrial({ instanceDir: cell.instanceDir, trial: cell.trial, runLabel, model });
        results.push(r);
        done += 1;
        console.log(`[matrix][w${w}] ${id} t${cell.trial} score=${r.score.toFixed(2)} sev=${r.severity} cost=$${r.tokenCostUsd?.toFixed(2) ?? '?'}${r.error ? ' ERROR' : ''}`);
      } catch (err) {
        done += 1;
        console.error(`[matrix][w${w}] ${id} t${cell.trial} CRASH ${(err as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_v, w) => worker(w)));
  console.log(`[matrix] complete: ${done} cells run. Results under ${join(RUNS_ROOT, runLabel)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
