/**
 * Scoring — the only place ground truth is ever read.
 *
 *   node src/score.mjs [--split eval|dev|all] [--out results/metrics.json]
 *
 * Emits metrics.json plus a markdown summary on stdout.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MULTI_SOLVERS, SINGLE_BASELINE, SINGLE_MEMBER_ALIAS } from './conditions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SPLIT = arg('--split', 'eval');
const CLAIMS = arg('--claims', join(ROOT, 'bench/claims.public.json'));
const TRUTH = arg('--truth', join(ROOT, 'bench/truth.json'));
const ATTEMPTS = arg('--attempts', join(ROOT, 'results/attempts.jsonl'));
const AGG = arg('--aggregated', join(ROOT, 'results/aggregated.jsonl'));
const OUT = arg('--out', join(ROOT, `results/metrics.${SPLIT}.json`));

const truth = new Map(
  JSON.parse(readFileSync(TRUTH, 'utf8')).truth.map((t) => [t.id, t]),
);
const claims = JSON.parse(readFileSync(CLAIMS, 'utf8')).claims
  .filter((c) => SPLIT === 'all' || c.split === SPLIT);
const ids = new Set(claims.map((c) => c.id));

const attempts = readFileSync(ATTEMPTS, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((a) => ids.has(a.claim_id));
const aggregated = readFileSync(AGG, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((a) => ids.has(a.claim_id));

/** answer + abstain -> outcome against ground truth */
function outcome(answer, abstain, gt) {
  if (abstain || answer === 'UNRESOLVABLE') return 'abstain';
  return answer === gt ? 'correct' : 'wrong';
}

function summarize(rows) {
  const n = rows.length;
  const correct = rows.filter((r) => r.outcome === 'correct').length;
  const wrong = rows.filter((r) => r.outcome === 'wrong').length;
  const abstain = rows.filter((r) => r.outcome === 'abstain').length;
  const answered = correct + wrong;
  return {
    n,
    correct,
    wrong,
    abstain,
    accuracy: n ? correct / n : null,
    abstention_rate: n ? abstain / n : null,
    accuracy_given_answered: answered ? correct / answered : null,
    cost_usd_total: round(sum(rows.map((r) => r.cost_usd ?? 0)), 4),
    cost_usd_per_claim: n ? round(sum(rows.map((r) => r.cost_usd ?? 0)) / n, 4) : null,
    tokens_per_claim: n ? Math.round(sum(rows.map((r) => r.tokens ?? 0)) / n) : null,
    web_searches_per_claim: n ? round(sum(rows.map((r) => r.web_searches ?? 0)) / n, 2) : null,
    wall_s_per_claim_serial: n ? round(sum(rows.map((r) => r.wall_ms_serial ?? 0)) / n / 1000, 1) : null,
    wall_s_per_claim_parallel: n ? round(sum(rows.map((r) => r.wall_ms_parallel ?? 0)) / n / 1000, 1) : null,
  };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (x, d = 4) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(x.toFixed(d)));

// ── per-condition rows ────────────────────────────────────────────────────
const conditions = {};

function singleRows(conditionKey) {
  return claims.map((c) => {
    const a = attempts.filter((x) => x.claim_id === c.id && x.condition_key === conditionKey).at(-1);
    const gt = truth.get(c.id).ground_truth;
    if (!a || !a.ok) return { claim_id: c.id, outcome: 'abstain', missing: true, cost_usd: a?.usage?.cost_usd ?? 0, tokens: 0, web_searches: 0, wall_ms_serial: a?.wall_ms ?? 0, wall_ms_parallel: a?.wall_ms ?? 0, confidence: null };
    return {
      claim_id: c.id,
      outcome: outcome(a.output.answer, a.output.abstain, gt),
      answer: a.output.answer,
      abstain: a.output.abstain,
      confidence: a.output.confidence,
      cost_usd: a.usage?.cost_usd ?? 0,
      tokens: (a.usage?.input_tokens ?? 0) + (a.usage?.output_tokens ?? 0),
      web_searches: a.usage?.web_search_requests ?? 0,
      wall_ms_serial: a.wall_ms ?? 0,
      wall_ms_parallel: a.wall_ms ?? 0,
    };
  });
}

conditions[SINGLE_BASELINE.key] = singleRows(SINGLE_BASELINE.key);
conditions['A_sonnet'] = singleRows(SINGLE_MEMBER_ALIAS);
for (const s of MULTI_SOLVERS) conditions[`member_${s.key}`] = singleRows(s.key);

const aggById = new Map(aggregated.map((a) => [a.claim_id, a]));
function aggRows(field) {
  return claims.map((c) => {
    const a = aggById.get(c.id);
    const gt = truth.get(c.id).ground_truth;
    if (!a) return { claim_id: c.id, outcome: 'abstain', missing: true, cost_usd: 0, tokens: 0, web_searches: 0, wall_ms_serial: 0, wall_ms_parallel: 0, confidence: null };
    const r = a[field];
    const extraCost = field === 'C_judge' ? (r.cost_usd ?? 0) : 0;
    return {
      claim_id: c.id,
      outcome: outcome(r.answer, r.abstain, gt),
      answer: r.answer,
      abstain: r.abstain,
      confidence: r.confidence ?? null,
      unanimous: a.unanimous,
      cost_usd: a.solver_cost_usd + extraCost,
      tokens: a.solver_tokens,
      web_searches: a.solver_web_searches,
      wall_ms_serial: a.solver_wall_ms_sum + (field === 'C_judge' ? (r.wall_ms ?? 0) : 0),
      wall_ms_parallel: a.solver_wall_ms_max + (field === 'C_judge' ? (r.wall_ms ?? 0) : 0),
    };
  });
}
conditions.C_majority = aggRows('C_majority');
conditions.C_conf = aggRows('C_conf');
conditions.C_judge = aggRows('C_judge');

// ── headline + strata ─────────────────────────────────────────────────────
const strata = {
  all: () => true,
  hard: (c) => truth.get(c.id).difficulty === 'hard',
  medium: (c) => truth.get(c.id).difficulty === 'medium',
  disputed: (c) => truth.get(c.id).disputed === true,
  post_cutoff: (c) => truth.get(c.id).contamination_risk === 'low',
  pre_cutoff: (c) => truth.get(c.id).contamination_risk !== 'low',
};

const results = { split: SPLIT, n_claims: claims.length, conditions: {}, strata: {} };
for (const [k, rows] of Object.entries(conditions)) results.conditions[k] = summarize(rows);
for (const [sname, pred] of Object.entries(strata)) {
  const keep = new Set(claims.filter(pred).map((c) => c.id));
  results.strata[sname] = { n: keep.size };
  for (const [k, rows] of Object.entries(conditions)) {
    results.strata[sname][k] = summarize(rows.filter((r) => keep.has(r.claim_id)));
  }
}

// ── disagreement ──────────────────────────────────────────────────────────
const disagreementRate = aggregated.length ? aggregated.filter((a) => !a.unanimous).length / aggregated.length : null;
function splitByUnanimity(rows) {
  const u = rows.filter((r) => r.unanimous === true);
  const d = rows.filter((r) => r.unanimous === false);
  return { unanimous: summarize(u), disagreed: summarize(d) };
}
results.disagreement = {
  rate: round(disagreementRate),
  mean_pairwise_disagreement: round(meanPairwise(aggregated)),
  C_judge: splitByUnanimity(conditions.C_judge),
  C_majority: splitByUnanimity(conditions.C_majority),
  // Does a single solver's error rate rise when the network disagreed?
  A_opus_by_network_unanimity: (() => {
    const u = new Set(aggregated.filter((a) => a.unanimous).map((a) => a.claim_id));
    const d = new Set(aggregated.filter((a) => !a.unanimous).map((a) => a.claim_id));
    return {
      unanimous: summarize(conditions.A_opus.filter((r) => u.has(r.claim_id))),
      disagreed: summarize(conditions.A_opus.filter((r) => d.has(r.claim_id))),
    };
  })(),
};

function meanPairwise(aggs) {
  if (!aggs.length) return null;
  const vals = aggs.map((a) => {
    const ans = (a.per_solver ?? []).map((s) => (s.abstain ? 'ABSTAIN' : s.answer));
    let pairs = 0; let diff = 0;
    for (let i = 0; i < ans.length; i += 1) for (let j = i + 1; j < ans.length; j += 1) { pairs += 1; if (ans[i] !== ans[j]) diff += 1; }
    return pairs ? diff / pairs : 0;
  });
  return sum(vals) / vals.length;
}

// ── paired comparison: A_opus vs C_judge (McNemar) ────────────────────────
function mcnemar(rowsA, rowsB) {
  const a = new Map(rowsA.map((r) => [r.claim_id, r.outcome === 'correct']));
  const b = new Map(rowsB.map((r) => [r.claim_id, r.outcome === 'correct']));
  let b01 = 0; let b10 = 0;
  for (const [id, ok] of a) {
    const okB = b.get(id);
    if (ok && okB === false) b10 += 1;
    if (!ok && okB === true) b01 += 1;
  }
  const n = b01 + b10;
  // exact two-sided binomial p under H0: p=0.5
  let p = 1;
  if (n > 0) {
    const k = Math.min(b01, b10);
    let cum = 0;
    for (let i = 0; i <= k; i += 1) cum += binom(n, i) * 0.5 ** n;
    p = Math.min(1, 2 * cum);
  }
  return { only_first_correct: b10, only_second_correct: b01, discordant: n, p_two_sided: round(p, 5) };
}
function binom(n, k) { let r = 1; for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i; return r; }

results.paired = {
  'A_opus_vs_C_judge': mcnemar(conditions.A_opus, conditions.C_judge),
  'A_opus_vs_C_majority': mcnemar(conditions.A_opus, conditions.C_majority),
  'A_sonnet_vs_C_judge': mcnemar(conditions.A_sonnet, conditions.C_judge),
};

// ── calibration ───────────────────────────────────────────────────────────
function calibration(rows) {
  const bins = [[0, 0.6], [0.6, 0.8], [0.8, 0.9], [0.9, 0.97], [0.97, 1.01]];
  const answered = rows.filter((r) => r.outcome !== 'abstain' && typeof r.confidence === 'number');
  const out = bins.map(([lo, hi]) => {
    const inBin = answered.filter((r) => r.confidence >= lo && r.confidence < hi);
    return {
      bin: `${lo}-${hi === 1.01 ? 1.0 : hi}`,
      n: inBin.length,
      mean_confidence: inBin.length ? round(sum(inBin.map((r) => r.confidence)) / inBin.length, 3) : null,
      empirical_accuracy: inBin.length ? round(inBin.filter((r) => r.outcome === 'correct').length / inBin.length, 3) : null,
    };
  });
  const brier = answered.length
    ? round(sum(answered.map((r) => (r.confidence - (r.outcome === 'correct' ? 1 : 0)) ** 2)) / answered.length, 4)
    : null;
  return { bins: out, brier, n_answered: answered.length };
}
results.calibration = {
  A_opus: calibration(conditions.A_opus),
  A_sonnet: calibration(conditions.A_sonnet),
  C_judge: calibration(conditions.C_judge),
};

// ── failure inspection payload ────────────────────────────────────────────
results.failures = {
  C_judge_wrong: conditions.C_judge.filter((r) => r.outcome === 'wrong').map((r) => r.claim_id),
  A_opus_wrong: conditions.A_opus.filter((r) => r.outcome === 'wrong').map((r) => r.claim_id),
  A_opus_wrong_C_judge_right: conditions.A_opus.filter((r) => r.outcome === 'wrong')
    .filter((r) => conditions.C_judge.find((x) => x.claim_id === r.claim_id)?.outcome === 'correct').map((r) => r.claim_id),
  C_judge_wrong_A_opus_right: conditions.C_judge.filter((r) => r.outcome === 'wrong')
    .filter((r) => conditions.A_opus.find((x) => x.claim_id === r.claim_id)?.outcome === 'correct').map((r) => r.claim_id),
};

writeFileSync(OUT, JSON.stringify(results, null, 2));

// ── markdown summary ──────────────────────────────────────────────────────
const order = ['A_opus', 'A_sonnet', 'member_B1', 'member_B2', 'member_B3', 'member_B4', 'member_B5', 'C_majority', 'C_conf', 'C_judge'];
console.log(`\n## split=${SPLIT}  n=${claims.length}\n`);
console.log('| condition | acc | abstain | acc|answered | $/claim | tok/claim | searches | wall s (serial) |');
console.log('|---|---|---|---|---|---|---|---|');
for (const k of order) {
  const s = results.conditions[k];
  if (!s) continue;
  console.log(`| ${k} | ${pct(s.accuracy)} | ${pct(s.abstention_rate)} | ${pct(s.accuracy_given_answered)} | $${s.cost_usd_per_claim} | ${s.tokens_per_claim} | ${s.web_searches_per_claim} | ${s.wall_s_per_claim_serial} |`);
}
console.log(`\ndisagreement rate: ${pct(results.disagreement.rate)}  mean pairwise: ${pct(results.disagreement.mean_pairwise_disagreement)}`);
console.log(`C_judge acc | unanimous: ${pct(results.disagreement.C_judge.unanimous.accuracy)} (n=${results.disagreement.C_judge.unanimous.n})`);
console.log(`C_judge acc | disagreed: ${pct(results.disagreement.C_judge.disagreed.accuracy)} (n=${results.disagreement.C_judge.disagreed.n})`);
console.log(`A_opus acc | network unanimous: ${pct(results.disagreement.A_opus_by_network_unanimity.unanimous.accuracy)}`);
console.log(`A_opus acc | network disagreed: ${pct(results.disagreement.A_opus_by_network_unanimity.disagreed.accuracy)}`);
console.log(`\nMcNemar A_opus vs C_judge: ${JSON.stringify(results.paired.A_opus_vs_C_judge)}`);
console.log(`\nwrote ${OUT}`);
function pct(x) { return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`; }
