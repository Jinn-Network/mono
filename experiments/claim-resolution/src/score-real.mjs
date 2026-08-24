/**
 * Scoring for the REAL-DISPUTE benchmark (bench/real/) — the only place its
 * ground truth is read.
 *
 *   node src/score-real.mjs [--claims bench/real/claims.public.json]
 *                           [--truth bench/real/truth.json]
 *                           [--attempts results/attempts-real.jsonl]
 *                           [--aggregated results/aggregated-real.jsonl]
 *                           [--out results/metrics.real.json]
 *
 * Scoring rule (fixed before any results were inspected):
 *   - ground truth YES/NO:      match => correct; mismatch => wrong;
 *                               abstain/UNRESOLVABLE => abstain (not scored
 *                               correct or wrong; reported separately)
 *   - ground truth INVALID or ANSWERED_TOO_SOON: the protocol itself refused a
 *     YES/NO, so abstention IS the correct resolution => abstain scores
 *     correct; a forced YES/NO scores wrong (the "inappropriate answer" rate
 *     of the brief).
 * `accuracy` uses that rule over all claims. `accuracy_given_answered` is
 * restricted to YES/NO ground truths, conditional on answering.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MULTI_SOLVERS, SINGLE_BASELINE, SINGLE_MEMBER_ALIAS } from './conditions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const CLAIMS = arg('--claims', join(ROOT, 'bench/real/claims.public.json'));
const TRUTH = arg('--truth', join(ROOT, 'bench/real/truth.json'));
const ATTEMPTS = arg('--attempts', join(ROOT, 'results/attempts-real.jsonl'));
const AGG = arg('--aggregated', join(ROOT, 'results/aggregated-real.jsonl'));
const OUT = arg('--out', join(ROOT, 'results/metrics.real.json'));

const truth = new Map(JSON.parse(readFileSync(TRUTH, 'utf8')).truth.map((t) => [t.id, t]));
const claims = JSON.parse(readFileSync(CLAIMS, 'utf8')).claims.filter((c) => truth.has(c.id));
const ids = new Set(claims.map((c) => c.id));

const attempts = readFileSync(ATTEMPTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => ids.has(a.claim_id));
const aggregated = readFileSync(AGG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => ids.has(a.claim_id));

function outcome(answer, abstain, t) {
  const abstained = abstain || answer === 'UNRESOLVABLE';
  if (t.resolution_kind !== 'answer') return abstained ? 'correct' : 'wrong'; // INVALID / TOO_SOON
  if (abstained) return 'abstain';
  return answer === t.final_resolution ? 'correct' : 'wrong';
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (x, d = 4) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(x.toFixed(d)));

function summarize(rows) {
  const n = rows.length;
  const correct = rows.filter((r) => r.outcome === 'correct').length;
  const wrong = rows.filter((r) => r.outcome === 'wrong').length;
  const abstain = rows.filter((r) => r.outcome === 'abstain').length;
  const yn = rows.filter((r) => r.gt_kind === 'answer');
  const ynAnswered = yn.filter((r) => r.outcome !== 'abstain');
  const special = rows.filter((r) => r.gt_kind !== 'answer');
  return {
    n,
    correct,
    wrong,
    abstain,
    accuracy: n ? round(correct / n) : null,
    abstention_rate: n ? round(rows.filter((r) => r.abstained).length / n) : null,
    yn_n: yn.length,
    yn_accuracy: yn.length ? round(yn.filter((r) => r.outcome === 'correct').length / yn.length) : null,
    accuracy_given_answered: ynAnswered.length ? round(ynAnswered.filter((r) => r.outcome === 'correct').length / ynAnswered.length) : null,
    special_n: special.length,
    inappropriate_answer_rate: special.length ? round(special.filter((r) => r.outcome === 'wrong').length / special.length) : null,
    cost_usd_total: round(sum(rows.map((r) => r.cost_usd ?? 0)), 4),
    cost_usd_per_claim: n ? round(sum(rows.map((r) => r.cost_usd ?? 0)) / n, 4) : null,
    tokens_per_claim: n ? Math.round(sum(rows.map((r) => r.tokens ?? 0)) / n) : null,
    web_searches_per_claim: n ? round(sum(rows.map((r) => r.web_searches ?? 0)) / n, 2) : null,
    wall_s_per_claim_serial: n ? round(sum(rows.map((r) => r.wall_ms_serial ?? 0)) / n / 1000, 1) : null,
    wall_s_per_claim_parallel: n ? round(sum(rows.map((r) => r.wall_ms_parallel ?? 0)) / n / 1000, 1) : null,
  };
}

// ── per-condition rows ────────────────────────────────────────────────────
const conditions = {};

function rowBase(c, t) {
  return { claim_id: c.id, gt_kind: t.resolution_kind, gt: t.final_resolution };
}

function singleRows(conditionKey) {
  return claims.map((c) => {
    const t = truth.get(c.id);
    const a = attempts.filter((x) => x.claim_id === c.id && x.condition_key === conditionKey).at(-1);
    if (!a || !a.ok) return { ...rowBase(c, t), outcome: 'abstain', abstained: true, missing: true, cost_usd: a?.usage?.cost_usd ?? 0, tokens: 0, web_searches: 0, wall_ms_serial: a?.wall_ms ?? 0, wall_ms_parallel: a?.wall_ms ?? 0, confidence: null };
    return {
      ...rowBase(c, t),
      outcome: outcome(a.output.answer, a.output.abstain, t),
      abstained: a.output.abstain || a.output.answer === 'UNRESOLVABLE',
      answer: a.output.answer,
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
conditions.A_sonnet = singleRows(SINGLE_MEMBER_ALIAS);
for (const s of MULTI_SOLVERS) conditions[`member_${s.key}`] = singleRows(s.key);

const aggById = new Map(aggregated.map((a) => [a.claim_id, a]));
function aggRows(field) {
  return claims.map((c) => {
    const t = truth.get(c.id);
    const a = aggById.get(c.id);
    if (!a) return { ...rowBase(c, t), outcome: 'abstain', abstained: true, missing: true, cost_usd: 0, tokens: 0, web_searches: 0, wall_ms_serial: 0, wall_ms_parallel: 0, confidence: null };
    const r = a[field];
    const extraCost = field === 'C_judge' ? (r.cost_usd ?? 0) : 0;
    return {
      ...rowBase(c, t),
      outcome: outcome(r.answer, r.abstain, t),
      abstained: r.abstain || r.answer === 'UNRESOLVABLE',
      answer: r.answer,
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

// ── strata: actual dispute intensity, from the protocol record ────────────
const claimById = new Map(claims.map((c) => [c.id, c]));
const strata = {
  all: () => true,
  arbitrated: (t) => t.strata.dispute_class === 'arbitrated',
  bonded_only: (t) => t.strata.dispute_class !== 'arbitrated',
  two_distinct_answers: (t) => t.strata.n_distinct_answers === 2,
  three_plus_distinct: (t) => t.strata.n_distinct_answers >= 3,
  short_ladder: (t) => t.strata.n_answers <= 3,
  long_ladder: (t) => t.strata.n_answers >= 4,
  many_flips: (t) => t.strata.n_flips >= 2,
  gt_yes_no: (t) => t.resolution_kind === 'answer',
  gt_invalid: (t) => t.resolution_kind === 'invalid',
  gt_too_soon: (t) => t.resolution_kind === 'too_soon',
  with_criteria: (t) => String(claimById.get(t.id)?.resolution_criteria ?? '').trim() !== '',
  no_criteria: (t) => String(claimById.get(t.id)?.resolution_criteria ?? '').trim() === '',
  mainnet: (t) => String(t.ground_truth_source).includes(':1:'),
  gnosis: (t) => String(t.ground_truth_source).includes(':100:'),
};

const results = { n_claims: claims.length, scoring_rule: 'INVALID/ANSWERED_TOO_SOON ground truth: abstain=correct, forced answer=wrong; YES/NO: match=correct, abstain tracked separately', conditions: {}, strata: {} };
for (const [k, rows] of Object.entries(conditions)) results.conditions[k] = summarize(rows);
for (const [sname, pred] of Object.entries(strata)) {
  const keep = new Set(claims.filter((c) => pred(truth.get(c.id))).map((c) => c.id));
  results.strata[sname] = { n: keep.size };
  for (const k of ['A_opus', 'A_sonnet', 'C_majority', 'C_judge']) {
    results.strata[sname][k] = summarize(conditions[k].filter((r) => keep.has(r.claim_id)));
  }
}

// ── disagreement ──────────────────────────────────────────────────────────
const disagreementRate = aggregated.length ? aggregated.filter((a) => !a.unanimous).length / aggregated.length : null;
function splitByUnanimity(rows) {
  return {
    unanimous: summarize(rows.filter((r) => r.unanimous === true)),
    disagreed: summarize(rows.filter((r) => r.unanimous === false)),
  };
}
const uSet = new Set(aggregated.filter((a) => a.unanimous).map((a) => a.claim_id));
const dSet = new Set(aggregated.filter((a) => !a.unanimous).map((a) => a.claim_id));
results.disagreement = {
  rate: round(disagreementRate),
  mean_pairwise_disagreement: round(meanPairwise(aggregated)),
  C_judge: splitByUnanimity(conditions.C_judge),
  C_majority: splitByUnanimity(conditions.C_majority),
  A_opus_by_network_unanimity: {
    unanimous: summarize(conditions.A_opus.filter((r) => uSet.has(r.claim_id))),
    disagreed: summarize(conditions.A_opus.filter((r) => dSet.has(r.claim_id))),
  },
  // does network disagreement predict dispute intensity / difficulty?
  disagreed_claims: [...dSet],
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

// ── escalation policy analysis (§13 of the brief) ─────────────────────────
// Route: take A_opus everywhere the network was unanimous; escalate to the
// aggregate only where the network disagreed. Cost = A_opus everywhere +
// (B members + judge) on the disagreement set only.
{
  const judgeRows = new Map(conditions.C_judge.map((r) => [r.claim_id, r]));
  const rows = conditions.A_opus.map((r) => {
    if (!dSet.has(r.claim_id)) return r;
    const j = judgeRows.get(r.claim_id);
    return { ...j, cost_usd: (r.cost_usd ?? 0) + (j.cost_usd ?? 0) };
  });
  results.escalation = {
    policy: 'A_opus everywhere; on network disagreement adopt C_judge (cost counts A + full B + judge on escalated claims)',
    summary: summarize(rows),
    n_escalated: dSet.size,
  };
}

// ── paired comparison (McNemar, exact binomial) ───────────────────────────
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
  A_opus_vs_C_judge: mcnemar(conditions.A_opus, conditions.C_judge),
  A_opus_vs_C_majority: mcnemar(conditions.A_opus, conditions.C_majority),
  A_sonnet_vs_C_judge: mcnemar(conditions.A_sonnet, conditions.C_judge),
  A_opus_vs_escalation: null, // filled below
};
{
  const judgeRows = new Map(conditions.C_judge.map((r) => [r.claim_id, r]));
  const escRows = conditions.A_opus.map((r) => (dSet.has(r.claim_id) ? judgeRows.get(r.claim_id) : r));
  results.paired.A_opus_vs_escalation = mcnemar(conditions.A_opus, escRows);
}

// ── calibration ───────────────────────────────────────────────────────────
function calibration(rows) {
  const bins = [[0, 0.6], [0.6, 0.8], [0.8, 0.9], [0.9, 0.97], [0.97, 1.01]];
  const answered = rows.filter((r) => !r.abstained && typeof r.confidence === 'number' && r.gt_kind === 'answer');
  const out = bins.map(([lo, hi]) => {
    const inBin = answered.filter((r) => r.confidence >= lo && r.confidence < hi);
    return {
      bin: `${lo}-${hi === 1.01 ? 1.0 : hi}`,
      n: inBin.length,
      mean_confidence: inBin.length ? round(sum(inBin.map((r) => r.confidence)) / inBin.length, 3) : null,
      empirical_accuracy: inBin.length ? round(inBin.filter((r) => r.outcome === 'correct').length / inBin.length, 3) : null,
    };
  });
  const brier = answered.length ? round(sum(answered.map((r) => (r.confidence - (r.outcome === 'correct' ? 1 : 0)) ** 2)) / answered.length, 4) : null;
  return { bins: out, brier, n_answered: answered.length };
}
results.calibration = {
  A_opus: calibration(conditions.A_opus),
  A_sonnet: calibration(conditions.A_sonnet),
  C_judge: calibration(conditions.C_judge),
};

// ── failure inspection payload ────────────────────────────────────────────
results.failures = {
  A_opus_wrong: conditions.A_opus.filter((r) => r.outcome === 'wrong').map((r) => r.claim_id),
  C_judge_wrong: conditions.C_judge.filter((r) => r.outcome === 'wrong').map((r) => r.claim_id),
  A_opus_wrong_C_judge_right: conditions.A_opus.filter((r) => r.outcome === 'wrong').filter((r) => conditions.C_judge.find((x) => x.claim_id === r.claim_id)?.outcome === 'correct').map((r) => r.claim_id),
  C_judge_wrong_A_opus_right: conditions.C_judge.filter((r) => r.outcome === 'wrong').filter((r) => conditions.A_opus.find((x) => x.claim_id === r.claim_id)?.outcome === 'correct').map((r) => r.claim_id),
  both_wrong: conditions.A_opus.filter((r) => r.outcome === 'wrong').filter((r) => conditions.C_judge.find((x) => x.claim_id === r.claim_id)?.outcome === 'wrong').map((r) => r.claim_id),
};

writeFileSync(OUT, JSON.stringify(results, null, 2));

// ── markdown summary ──────────────────────────────────────────────────────
const order = ['A_opus', 'A_sonnet', 'member_B1', 'member_B2', 'member_B3', 'member_B4', 'member_B5', 'C_majority', 'C_conf', 'C_judge'];
console.log(`\n## real disputes  n=${claims.length}\n`);
console.log('| condition | acc | abstain | acc|answered (Y/N gt) | inappropriate | $/claim | searches | wall s |');
console.log('|---|---|---|---|---|---|---|---|');
for (const k of order) {
  const s = results.conditions[k];
  if (!s) continue;
  console.log(`| ${k} | ${pct(s.accuracy)} | ${pct(s.abstention_rate)} | ${pct(s.accuracy_given_answered)} | ${pct(s.inappropriate_answer_rate)} | $${s.cost_usd_per_claim} | ${s.web_searches_per_claim} | ${s.wall_s_per_claim_serial} |`);
}
const e = results.escalation.summary;
console.log(`| escalation | ${pct(e.accuracy)} | ${pct(e.abstention_rate)} | ${pct(e.accuracy_given_answered)} | ${pct(e.inappropriate_answer_rate)} | $${e.cost_usd_per_claim} | ${e.web_searches_per_claim} | ${e.wall_s_per_claim_serial} |`);
console.log(`\ndisagreement rate: ${pct(results.disagreement.rate)}  mean pairwise: ${pct(results.disagreement.mean_pairwise_disagreement)}`);
console.log(`C_judge acc | unanimous: ${pct(results.disagreement.C_judge.unanimous.accuracy)} (n=${results.disagreement.C_judge.unanimous.n})  | disagreed: ${pct(results.disagreement.C_judge.disagreed.accuracy)} (n=${results.disagreement.C_judge.disagreed.n})`);
console.log(`A_opus  acc | unanimous: ${pct(results.disagreement.A_opus_by_network_unanimity.unanimous.accuracy)}  | disagreed: ${pct(results.disagreement.A_opus_by_network_unanimity.disagreed.accuracy)}`);
console.log(`\nMcNemar A_opus vs C_judge: ${JSON.stringify(results.paired.A_opus_vs_C_judge)}`);
console.log(`McNemar A_opus vs escalation: ${JSON.stringify(results.paired.A_opus_vs_escalation)}`);
console.log(`\nwrote ${OUT}`);
function pct(x) { return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`; }
