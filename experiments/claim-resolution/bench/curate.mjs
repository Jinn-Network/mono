/**
 * Stage 1 — harvest candidate claims.
 *
 * One unrestricted `claude -p` subprocess per bucket. The curator MAY read
 * prediction-market and oracle pages; that is the point — it is looking for
 * questions that were externally settled. The leakage guard is deliberately
 * absent here and present in the solver path.
 *
 *   node bench/curate.mjs [--model <id>] [--out <path>]
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const BUCKETS_MODULE = (() => {
  const i = process.argv.indexOf('--buckets');
  return i >= 0 ? process.argv[i + 1] : './buckets.mjs';
})();
const { BUCKETS } = await import(BUCKETS_MODULE);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'schema/candidate.schema.json'), 'utf8');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MODEL = arg('--model', 'claude-sonnet-5');
const OUT = arg('--out', join(ROOT, 'bench/candidates.json'));
const CONCURRENCY = Number(arg('--concurrency', '5'));
const ONLY = arg('--only', '');
const RETRIES = Number(arg('--retries', '3'));

const SYSTEM = `You assemble a benchmark of externally-resolved claims for an
oracle-resolution experiment.

You are looking for questions that a public resolution system has already
settled definitively — Reality.eth/Kleros, UMA/Polymarket, Omen, Augur or a
comparable system — or, where you cannot tie a question to a specific market,
real-world events whose outcome is unambiguously and publicly documented.

Every candidate must satisfy ALL of:
1. Already definitively resolved. No open questions, no partial outcomes.
2. Resolvable from public web evidence. No private data, no insider knowledge.
3. Requires actual research or interpretation. REJECT anything a single
   structured lookup settles: sports scores and results, closing prices of
   liquid assets on a given day, scheduled calendar facts, "did the sun rise".
4. Resolution criteria clear enough that the final answer is safely ground truth.
5. The claim text and criteria must be self-contained. Someone reading only the
   claim, criteria and deadline must know exactly what is being asked. Do not
   refer to "the market", "this question" or any external document.

Hard requirements on the output:
- ground_truth is what actually happened, verified from the sources you cite.
- criteria must be written so that ground_truth follows from them mechanically.
- deadline is an ISO date (YYYY-MM-DD).
- source_urls: at least two URLs you actually opened via search results.
- Do NOT put the answer, the outcome, or any resolution hint into claim or
  criteria. Phrase the claim as a proposition, and the criteria as the test.
  A reader of claim+criteria alone must not be able to infer the answer.
- Aim for a roughly even split of YES and NO ground truths. Do not make every
  claim resolve YES.
- why_nontrivial: one sentence on what research the claim actually demands.
- difficulty: "hard" if the resolution turned on a close call, contested
  wording, conflicting sources, or several assembled facts; otherwise "medium".

Search the web extensively before proposing anything. Accuracy of ground_truth
matters far more than the number of candidates. It is better to return five
solid candidates than twelve shaky ones.`;

function curateBucket(bucket) {
  const prompt = [
    `Assemble up to ${bucket.n} candidate claims.`,
    '',
    `TOPIC: ${bucket.brief}`,
    '',
    `WINDOW: each candidate must have ${bucket.window}.`,
    '',
    `Today is 2026-08-19, so everything in that window has already resolved.`,
    bucket.id === 'historical-hard'
      ? 'For this bucket, prioritise documented disputes: set disputed=true and explain the dispute in why_nontrivial.'
      : 'Set disputed=true only where you found evidence of an actual resolution dispute.',
    '',
    'Search first. Then output the structured object.',
  ].join('\n');

  const args = [
    '-p', '--model', MODEL,
    '--system-prompt', SYSTEM,
    '--tools', 'WebSearch',
    '--allowed-tools', 'WebSearch',
    '--setting-sources', '',
    '--no-session-persistence',
    '--json-schema', SCHEMA,
    '--output-format', 'json',
    prompt,
  ];

  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_CODE_CHILD_SESSION;
    const child = spawn('claude', args, { cwd: '/tmp', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 1_500_000);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const meta = JSON.parse(out);
        const payload = JSON.parse(meta.result);
        const cands = (payload.candidates ?? []).map((c, i) => ({
          ...c, bucket: bucket.id, curator_model: MODEL, curator_index: i,
        }));
        console.log(`[curate] ${bucket.id}: ${cands.length} candidates, $${(meta.total_cost_usd ?? 0).toFixed(3)}`);
        resolve({ bucket: bucket.id, cost: meta.total_cost_usd ?? 0, candidates: cands });
      } catch (e) {
        console.log(`[curate] ${bucket.id}: FAILED (${e.message})`);
        resolve({ bucket: bucket.id, cost: 0, candidates: [] });
      }
    });
  });
}

async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k]); }
  }));
  return results;
}

/** Transient API errors are common at concurrency; retry with backoff. */
async function curateWithRetry(bucket) {
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    const r = await curateBucket(bucket);
    if (r.candidates.length) return r;
    if (attempt < RETRIES) {
      const wait = 15_000 * attempt;
      console.log(`[curate] ${bucket.id}: retry ${attempt}/${RETRIES - 1} in ${wait / 1000}s`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  return { bucket: bucket.id, cost: 0, candidates: [] };
}

const selectedBuckets = ONLY
  ? BUCKETS.filter((b) => ONLY.split(',').includes(b.id))
  : BUCKETS;
const runs = await pool(selectedBuckets, CONCURRENCY, curateWithRetry);
const all = runs.flatMap((r) => r.candidates);
const cost = runs.reduce((a, r) => a + r.cost, 0);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), curator_model: MODEL, curation_cost_usd: cost, candidates: all }, null, 2));
console.log(`[curate] total ${all.length} candidates, $${cost.toFixed(2)} -> ${OUT}`);
