/**
 * Run conditions A and B over the benchmark.
 *
 * Resumable: attempts already present in the output JSONL are skipped, so a
 * killed run can just be restarted.
 *
 *   node src/run-experiment.mjs [--split eval|dev|all] [--limit N]
 *                               [--concurrency N] [--out results/attempts.jsonl]
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSolver } from './solver.mjs';
import { ALL_SPECS } from './conditions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const SPLIT = arg('--split', 'all');
const LIMIT = Number(arg('--limit', '0'));
const CONCURRENCY = Number(arg('--concurrency', '10'));
const CLAIMS = arg('--claims', join(ROOT, 'bench/claims.public.json'));
const OUT = arg('--out', join(ROOT, 'results/attempts.jsonl'));
// Must be absolute: the guard hook runs with the solver subprocess's cwd
// (/tmp), so a relative path would silently write outside the experiment.
const AUDIT = resolve(arg('--audit', join(ROOT, 'results/websearch-audit.jsonl')));

// The runner loads the PUBLIC claim file only. The truth file is never read
// on this path — that is the leakage boundary, enforced by construction.
const claims = JSON.parse(readFileSync(CLAIMS, 'utf8')).claims
  .filter((c) => SPLIT === 'all' || c.split === SPLIT);
const selected = LIMIT > 0 ? claims.slice(0, LIMIT) : claims;

mkdirSync(dirname(OUT), { recursive: true });
const done = new Set();
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.ok) done.add(r.attempt_id); } catch { /* skip */ }
  }
}

const jobs = [];
for (const claim of selected) {
  for (const spec of ALL_SPECS) {
    const attemptId = `${claim.id}::${spec.key}`;
    if (done.has(attemptId)) continue;
    jobs.push({ claim, spec, attemptId });
  }
}

console.log(`[run] ${selected.length} claims x ${ALL_SPECS.length} specs = ${selected.length * ALL_SPECS.length} attempts; ${done.size} already done; ${jobs.length} to run`);

let completed = 0;
let cost = 0;
let failures = 0;
const t0 = Date.now();

async function worker() {
  while (jobs.length) {
    const job = jobs.shift();
    if (!job) return;
    const r = await runSolver({
      claim: job.claim,
      model: job.spec.model,
      strategy: job.spec.strategy,
      attemptId: job.attemptId,
      auditLog: AUDIT,
    });
    const record = { ...r, condition_key: job.spec.key, split: job.claim.split, ts: new Date().toISOString() };
    appendFileSync(OUT, JSON.stringify(record) + '\n');
    completed += 1;
    cost += r.usage?.cost_usd ?? 0;
    if (!r.ok) failures += 1;
    if (completed % 10 === 0 || jobs.length === 0) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`[run] ${completed} done, ${jobs.length} left, $${cost.toFixed(2)}, ${failures} failed, ${mins}m`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`[run] finished: ${completed} attempts, $${cost.toFixed(2)}, ${failures} failures, ${((Date.now() - t0) / 60000).toFixed(1)}m`);
