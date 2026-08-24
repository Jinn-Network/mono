/**
 * Dump real-dispute failures with full context for manual case studies.
 *
 *   node src/inspect-failures-real.mjs [--which all|C_judge|A_opus|divergent|disagreed]
 *                                      [--limit 60]
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MULTI_SOLVERS } from './conditions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const WHICH = arg('--which', 'all');
const LIMIT = Number(arg('--limit', '60'));
const CLAIMS = arg('--claims', join(ROOT, 'bench/real-sample/claims.public.json'));
const TRUTH = arg('--truth', join(ROOT, 'bench/real-sample/truth.json'));
const ATTEMPTS_F = arg('--attempts', join(ROOT, 'results/attempts-real.jsonl'));
const AGG_F = arg('--aggregated', join(ROOT, 'results/aggregated-real.jsonl'));

const truth = new Map(JSON.parse(readFileSync(TRUTH, 'utf8')).truth.map((t) => [t.id, t]));
const claims = JSON.parse(readFileSync(CLAIMS, 'utf8')).claims;
const attempts = readFileSync(ATTEMPTS_F, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const agg = new Map(readFileSync(AGG_F, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((a) => [a.claim_id, a]));

// same rule as score-real.mjs
function outcome(answer, abstain, t) {
  const abstained = abstain || answer === 'UNRESOLVABLE';
  if (t.resolution_kind !== 'answer') return abstained ? 'correct' : 'wrong';
  if (abstained) return 'abstain';
  return answer === t.final_resolution ? 'correct' : 'wrong';
}

let n = 0;
for (const c of claims) {
  const t = truth.get(c.id);
  const a = agg.get(c.id);
  const opus = attempts.filter((x) => x.claim_id === c.id && x.condition_key === 'A_opus' && x.ok).at(-1);
  if (!a || !t) continue;
  const jOut = outcome(a.C_judge.answer, a.C_judge.abstain, t);
  const oOut = opus ? outcome(opus.output.answer, opus.output.abstain, t) : 'abstain';

  const include = WHICH === 'all' ? (jOut === 'wrong' || oOut === 'wrong')
    : WHICH === 'C_judge' ? jOut === 'wrong'
      : WHICH === 'A_opus' ? oOut === 'wrong'
        : WHICH === 'divergent' ? ((jOut === 'wrong') !== (oOut === 'wrong'))
          : WHICH === 'disagreed' ? !a.unanimous : false;
  if (!include) continue;
  if (n++ >= LIMIT) break;

  console.log('='.repeat(100));
  console.log(`${c.id}  [${t.strata.dispute_class} | distinct=${t.strata.n_distinct_answers} flips=${t.strata.n_flips} answers=${t.strata.n_answers}]`);
  console.log(`QUESTION: ${c.question}`);
  console.log(`CUTOFF:   ${c.cutoff_time}   opening: ${c.public_metadata?.opening_time ?? '?'}`);
  console.log(`GROUND TRUTH: ${t.final_resolution} (${t.resolution_kind})  finalized ${t.resolution_timestamp}  src ${t.ground_truth_source}`);
  console.log(`  bond ladder: ${t.dispute_history.map((h) => `${h.answer}@${h.bond}`).join(' -> ')}`);
  if (t.arbitration_metadata) console.log(`  arbitration: requested ${t.arbitration_metadata.requested_ts} cancelled=${t.arbitration_metadata.cancelled}`);
  console.log(`A_opus:   ${opus ? `${opus.output.answer} conf=${opus.output.confidence} abstain=${opus.output.abstain} [${oOut}]` : 'MISSING'}`);
  if (opus) console.log(`  reasoning: ${String(opus.output.reasoning_summary).slice(0, 400)}`);
  if (opus) for (const e of (opus.output.evidence ?? []).slice(0, 4)) console.log(`  ev: ${e.url}`);
  console.log(`network:  unanimous=${a.unanimous} n_abstain=${a.n_abstain}`);
  console.log(`C_judge:  ${a.C_judge.answer} conf=${a.C_judge.confidence} abstain=${a.C_judge.abstain} via ${a.C_judge.source} [${jOut}]`);
  if (a.C_judge.reasoning_summary) console.log(`  judge: ${String(a.C_judge.reasoning_summary).slice(0, 400)}`);
  for (const s of MULTI_SOLVERS) {
    const at = attempts.filter((x) => x.claim_id === c.id && x.condition_key === s.key && x.ok).at(-1);
    if (!at) continue;
    console.log(`  ${s.key} (${s.model.replace('claude-', '')}/${s.strategy}): ${at.output.answer} conf=${at.output.confidence} :: ${String(at.output.reasoning_summary).slice(0, 200)}`);
  }
  console.log();
}
console.log(`\n${n} cases shown (which=${WHICH})`);
