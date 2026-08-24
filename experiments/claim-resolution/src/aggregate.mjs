/**
 * Condition C — aggregate the independent solver outputs into one answer.
 *
 * Three mechanisms, simplest first:
 *   C_majority — plain majority over non-abstaining answers; tie => abstain.
 *   C_conf     — confidence-weighted vote (reported, but only meaningful if
 *                confidence turns out to be calibrated; see the report).
 *   C_judge    — unanimous answers pass through untouched; on ANY disagreement
 *                or abstention an evidence-aware judge reads the solver outputs
 *                and their cited evidence and decides. The judge never sees the
 *                ground truth and does not search the web — it arbitrates the
 *                evidence the network already produced.
 *
 *   node src/aggregate.mjs [--attempts results/attempts.jsonl]
 *                          [--out results/aggregated.jsonl]
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MULTI_SOLVERS } from './conditions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = readFileSync(join(ROOT, 'schema/judge.schema.json'), 'utf8');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ATTEMPTS = arg('--attempts', join(ROOT, 'results/attempts.jsonl'));
const OUT = arg('--out', join(ROOT, 'results/aggregated.jsonl'));
const CLAIMS = arg('--claims', join(ROOT, 'bench/claims.public.json'));
const JUDGE_MODEL = arg('--judge-model', 'claude-opus-5');
const CONCURRENCY = Number(arg('--concurrency', '8'));

const B_KEYS = new Set(MULTI_SOLVERS.map((s) => s.key));
const claims = JSON.parse(readFileSync(CLAIMS, 'utf8')).claims;
const byId = new Map(claims.map((c) => [c.id, c]));

const attempts = readFileSync(ATTEMPTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const groups = new Map();
for (const a of attempts) {
  if (!a.ok || !B_KEYS.has(a.condition_key)) continue;
  if (!groups.has(a.claim_id)) groups.set(a.claim_id, new Map());
  groups.get(a.claim_id).set(a.condition_key, a);
}

const JUDGE_SYSTEM = `You are the aggregation stage of a claim-resolution network.

Several independent solvers researched the same claim and returned answers,
confidences, reasoning and cited evidence. They did not agree. Your job is to
produce the network's single final answer.

You have no web access. Decide from the solvers' evidence and reasoning:
- Weigh cited evidence over assertion. A solver that names a specific
  authoritative source beats one that gestures at consensus.
- Check each solver's reasoning against the resolution criteria as written.
  Solvers frequently answer the spirit of the claim rather than its criteria.
- Confidence is self-reported and often miscalibrated. Do not defer to it.
- A minority position with better evidence should win.
- If the solvers' combined evidence genuinely does not settle the claim, set
  abstain=true and answer UNRESOLVABLE. Do not split the difference.

which_solvers_were_right: the solver ids whose answer you are adopting.`;

function callJudge(claim, solvers) {
  const body = solvers.map((s) => [
    `--- SOLVER ${s.condition_key} (${s.model}, strategy=${s.strategy}) ---`,
    `answer: ${s.output.answer}`,
    `confidence: ${s.output.confidence}`,
    `abstain: ${s.output.abstain}`,
    `reasoning: ${s.output.reasoning_summary}`,
    'evidence:',
    ...(s.output.evidence ?? []).map((e) => `  - ${e.url} :: ${e.claim_supported} :: ${e.relevance}`),
  ].join('\n')).join('\n\n');

  // Both dataset shapes: synthetic {claim, criteria, deadline} and
  // real-dispute {question, resolution_criteria, cutoff_time}.
  const criteria = claim.resolution_criteria ?? claim.criteria;
  const prompt = [
    `CLAIM: ${claim.question ?? claim.claim}`, '',
    `RESOLUTION CRITERIA: ${String(criteria ?? '').trim() || '(none were published beyond the question itself)'}`, '',
    `RESOLUTION DEADLINE: ${claim.cutoff_time ?? claim.deadline}`, '',
    'SOLVER OUTPUTS:', '', body, '',
    'Produce the network answer.',
  ].join('\n');

  const args = [
    '-p', '--model', JUDGE_MODEL,
    '--system-prompt', JUDGE_SYSTEM,
    '--tools', '',
    '--setting-sources', '', '--no-session-persistence',
    '--json-schema', SCHEMA, '--output-format', 'json', prompt,
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_CODE_CHILD_SESSION;
    const child = spawn('claude', args, { cwd: '/tmp', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', () => {});
    const t = setTimeout(() => child.kill('SIGKILL'), 600_000);
    child.on('close', () => {
      clearTimeout(t);
      try {
        const meta = JSON.parse(out);
        resolve({ ...JSON.parse(meta.result), cost_usd: meta.total_cost_usd ?? 0, wall_ms: Date.now() - started, model: JUDGE_MODEL });
      } catch {
        resolve(null);
      }
    });
  });
}

function majority(solvers) {
  const votes = solvers.filter((s) => !s.output.abstain && s.output.answer !== 'UNRESOLVABLE');
  const tally = {};
  for (const s of votes) tally[s.output.answer] = (tally[s.output.answer] ?? 0) + 1;
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { answer: 'UNRESOLVABLE', abstain: true, tally, votes: 0, margin: 0 };
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return { answer: 'UNRESOLVABLE', abstain: true, tally, votes: votes.length, margin: 0 };
  return { answer: ranked[0][0], abstain: false, tally, votes: votes.length, margin: ranked[0][1] - (ranked[1]?.[1] ?? 0) };
}

function confWeighted(solvers) {
  const w = {};
  for (const s of solvers) {
    if (s.output.abstain || s.output.answer === 'UNRESOLVABLE') continue;
    w[s.output.answer] = (w[s.output.answer] ?? 0) + (s.output.confidence ?? 0);
  }
  const ranked = Object.entries(w).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { answer: 'UNRESOLVABLE', abstain: true, weights: w };
  return { answer: ranked[0][0], abstain: false, weights: w };
}

function avg(xs) { const v = xs.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

mkdirSync(dirname(OUT), { recursive: true });
const alreadyDone = new Set();
if (existsSync(OUT)) {
  for (const l of readFileSync(OUT, 'utf8').split('\n').filter(Boolean)) {
    try { alreadyDone.add(JSON.parse(l).claim_id); } catch { /* skip */ }
  }
}

const work = [...groups.entries()].filter(([id]) => !alreadyDone.has(id));
console.log(`[agg] ${groups.size} claims with B attempts; ${work.length} to aggregate`);

let judgeCalls = 0;
let judgeCost = 0;
let i = 0;
async function worker() {
  while (i < work.length) {
    const [claimId, map] = work[i++];
    const claim = byId.get(claimId);
    const solvers = MULTI_SOLVERS.map((s) => map.get(s.key)).filter(Boolean);
    if (!claim || !solvers.length) continue;
    const answers = new Set(solvers.map((s) => (s.output.abstain ? 'ABSTAIN' : s.output.answer)));
    const unanimous = answers.size === 1;
    const maj = majority(solvers);
    const conf = confWeighted(solvers);

    let judge = null;
    if (!unanimous) {
      judge = await callJudge(claim, solvers);
      judgeCalls += 1;
      judgeCost += judge?.cost_usd ?? 0;
    }
    const cJudge = unanimous
      ? { answer: solvers[0].output.answer, abstain: solvers[0].output.abstain, confidence: avg(solvers.map((s) => s.output.confidence)), source: 'unanimous', cost_usd: 0, wall_ms: 0 }
      : judge
        ? { ...judge, source: 'judge' }
        : { answer: maj.answer, abstain: maj.abstain, confidence: null, source: 'judge_failed_fallback_majority', cost_usd: 0, wall_ms: 0 };

    appendFileSync(OUT, JSON.stringify({
      claim_id: claimId,
      split: solvers[0]?.split ?? null,
      n_solvers: solvers.length,
      unanimous,
      distinct_answers: [...answers],
      n_abstain: solvers.filter((s) => s.output.abstain).length,
      per_solver: solvers.map((s) => ({ key: s.condition_key, answer: s.output.answer, abstain: s.output.abstain, confidence: s.output.confidence })),
      C_majority: maj,
      C_conf: conf,
      C_judge: cJudge,
      solver_cost_usd: solvers.reduce((a, s) => a + (s.usage?.cost_usd ?? 0), 0),
      solver_wall_ms_sum: solvers.reduce((a, s) => a + (s.wall_ms ?? 0), 0),
      solver_wall_ms_max: Math.max(0, ...solvers.map((s) => s.wall_ms ?? 0)),
      solver_web_searches: solvers.reduce((a, s) => a + (s.usage?.web_search_requests ?? 0), 0),
      solver_tokens: solvers.reduce((a, s) => a + (s.usage?.input_tokens ?? 0) + (s.usage?.output_tokens ?? 0), 0),
    }) + '\n');
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`[agg] done. judge invoked on ${judgeCalls}/${work.length} claims, $${judgeCost.toFixed(2)}`);
