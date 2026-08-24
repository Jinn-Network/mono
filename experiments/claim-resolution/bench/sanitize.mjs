/**
 * Stage 1b — sanitize and triage candidates before verification.
 *
 * Two problems the curator leaves behind:
 *   1. Criteria that say "resolves according to the Polymarket contract X".
 *      That names the settlement venue inside the solver prompt, which is both
 *      a leakage pointer and not a self-contained question.
 *   2. Claims that are really a single structured lookup — sports results
 *      above all — which the experiment brief excludes.
 *
 * The sanitizer rewrites (1) into substantive, self-contained criteria and
 * flags (2). It never sees the ground truth, so it cannot shade the wording
 * toward the answer; and because verification runs AFTER this pass, any rewrite
 * that shifted the semantics shows up as curator/verifier disagreement and the
 * item is dropped.
 *
 *   node bench/sanitize.mjs --in bench/candidates.json --out bench/sanitized.json
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'schema/sanitize.schema.json'), 'utf8');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in', join(ROOT, 'bench/candidates.json'));
const OUT = arg('--out', join(ROOT, 'bench/sanitized.json'));
const MODEL = arg('--model', 'claude-sonnet-5');
const CONCURRENCY = Number(arg('--concurrency', '10'));

const SYSTEM = `You prepare benchmark items for a claim-resolution experiment.

You are given a claim and its resolution criteria. Do three things.

1. REWRITE if the text names the venue that settled the question — a prediction
   market, an oracle, an arbitration system, or a specific contract ("resolves
   according to the Polymarket contract X", "per UMA's final ruling", "as ruled
   by Kleros case #N"). Replace that with the substantive test the venue was
   applying, stated in plain terms: what has to have been true in the world, by
   when, evidenced how. Preserve the meaning exactly — same question, same
   thresholds, same dates, same edge cases. Do not make it easier, do not make
   it vaguer, and do not resolve it. Also strip any other reference to "this
   market", "this question", or "the contract".
   If no such rewrite is needed, return the claim and criteria unchanged and set
   rewritten=false.

2. FLAG is_trivial_lookup=true if the item is settled by one structured lookup
   with no research or interpretation: the result or score of a sporting fixture
   or tournament, an award at a sporting event, the closing price of a liquid
   asset on a named date, a scheduled calendar fact. Compound sports claims
   ("won the group AND reached the quarterfinals") still count as trivial.

3. FLAG gives_away_answer=true if the claim or criteria as written let a reader
   infer the resolution without any research — leading wording, an embedded
   outcome, or criteria phrased so only one answer is coherent.

You do not know how this resolved and must not speculate. Output the structured
object only.`;

function sanitize(c, idx) {
  const prompt = [`CLAIM: ${c.claim}`, '', `RESOLUTION CRITERIA: ${c.criteria}`, '', `DEADLINE: ${c.deadline}`].join('\n');
  const args = [
    '-p', '--model', MODEL, '--system-prompt', SYSTEM,
    '--tools', '', '--setting-sources', '', '--no-session-persistence',
    '--json-schema', SCHEMA, '--output-format', 'json', prompt,
  ];
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_CODE_CHILD_SESSION;
    const child = spawn('claude', args, { cwd: '/tmp', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (x) => { out += x; });
    child.stderr.on('data', () => {});
    const t = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('close', () => {
      clearTimeout(t);
      try {
        const meta = JSON.parse(out);
        const s = JSON.parse(meta.result);
        if (idx % 20 === 0) console.log(`[sanitize] ${idx}`);
        resolve({ ...c, claim: s.claim, criteria: s.criteria, sanitize: { rewritten: s.rewritten, is_trivial_lookup: s.is_trivial_lookup, gives_away_answer: s.gives_away_answer, notes: s.notes, original_claim: c.claim, original_criteria: c.criteria, cost_usd: meta.total_cost_usd ?? 0 } });
      } catch {
        resolve({ ...c, sanitize: { rewritten: false, is_trivial_lookup: false, gives_away_answer: false, notes: 'sanitizer failed', failed: true, cost_usd: 0 } });
      }
    });
  });
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const src = JSON.parse(readFileSync(IN, 'utf8'));
const done = await pool(src.candidates, CONCURRENCY, sanitize);

// Drop the two disqualifying classes here so we never pay to verify them.
const keep = done.filter((c) => !c.sanitize.is_trivial_lookup && !c.sanitize.gives_away_answer);
const dropped = done.filter((c) => c.sanitize.is_trivial_lookup || c.sanitize.gives_away_answer)
  .map((c) => ({ claim: c.claim, bucket: c.bucket, trivial: c.sanitize.is_trivial_lookup, gives_away: c.sanitize.gives_away_answer }));

const cost = done.reduce((a, c) => a + (c.sanitize.cost_usd ?? 0), 0);
writeFileSync(OUT, JSON.stringify({ ...src, sanitize_model: MODEL, sanitize_cost_usd: cost, dropped_at_sanitize: dropped, candidates: keep }, null, 2));
console.log(`[sanitize] ${done.length} in, ${done.filter((c) => c.sanitize.rewritten).length} rewritten, ${dropped.length} dropped (${dropped.filter((d) => d.trivial).length} trivial, ${dropped.filter((d) => d.gives_away).length} gives-away), ${keep.length} kept, $${cost.toFixed(2)}`);
