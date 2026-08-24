/**
 * Dump failures with enough context to diagnose them by hand.
 *
 *   node src/inspect-failures.mjs [--split eval] [--which C_judge|A_opus|divergent]
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MULTI_SOLVERS } from './conditions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SPLIT = arg('--split', 'eval');
const WHICH = arg('--which', 'all');
const LIMIT = Number(arg('--limit', '50'));
const CLAIMS = arg('--claims', join(ROOT, 'bench/claims.public.json'));
const TRUTH = arg('--truth', join(ROOT, 'bench/truth.json'));
const ATTEMPTS_F = arg('--attempts', join(ROOT, 'results/attempts.jsonl'));
const AGG_F = arg('--aggregated', join(ROOT, 'results/aggregated.jsonl'));

const truth = new Map(JSON.parse(readFileSync(TRUTH, 'utf8')).truth.map((t) => [t.id, t]));
const claims = JSON.parse(readFileSync(CLAIMS, 'utf8')).claims
  .filter((c) => SPLIT === 'all' || c.split === SPLIT);
const byId = new Map(claims.map((c) => [c.id, c]));
const attempts = readFileSync(ATTEMPTS_F, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const agg = new Map(readFileSync(AGG_F, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((a) => [a.claim_id, a]));

const wrong = (ans, ab, gt) => !ab && ans !== 'UNRESOLVABLE' && ans !== gt;

let n = 0;
for (const c of claims) {
  const t = truth.get(c.id);
  const a = agg.get(c.id);
  const opus = attempts.filter((x) => x.claim_id === c.id && x.condition_key === 'A_opus' && x.ok).at(-1);
  if (!a) continue;
  const jWrong = wrong(a.C_judge.answer, a.C_judge.abstain, t.ground_truth);
  const oWrong = opus ? wrong(opus.output.answer, opus.output.abstain, t.ground_truth) : true;

  const include = WHICH === 'all' ? (jWrong || oWrong)
    : WHICH === 'C_judge' ? jWrong
      : WHICH === 'A_opus' ? oWrong
        : WHICH === 'divergent' ? (jWrong !== oWrong) : false;
  if (!include) continue;
  if (n++ >= LIMIT) break;

  console.log('='.repeat(100));
  console.log(`${c.id}  [${t.bucket} | ${t.difficulty}${t.disputed ? ' | DISPUTED' : ''} | contamination=${t.contamination_risk}]`);
  console.log(`CLAIM:    ${c.claim}`);
  console.log(`CRITERIA: ${c.criteria}`);
  console.log(`DEADLINE: ${c.deadline}`);
  console.log(`GROUND TRUTH: ${t.ground_truth}  (record: ${t.settlement_record})`);
  console.log(`  truth sources: ${(t.source_urls ?? []).slice(0, 3).join(' , ')}`);
  console.log(`  closed-book probe: ${JSON.stringify(t.closed_book)}`);
  console.log(`A_opus:   ${opus ? `${opus.output.answer} conf=${opus.output.confidence} abstain=${opus.output.abstain}${oWrong ? '  << WRONG' : ''}` : 'MISSING'}`);
  if (opus) console.log(`  reasoning: ${opus.output.reasoning_summary}`);
  if (opus) for (const e of opus.output.evidence ?? []) console.log(`  ev: ${e.url} :: ${e.claim_supported}`);
  console.log(`network:  unanimous=${a.unanimous} answers=${JSON.stringify(a.per_solver)}`);
  console.log(`C_major:  ${a.C_majority.answer} (tally ${JSON.stringify(a.C_majority.tally)})`);
  console.log(`C_judge:  ${a.C_judge.answer} conf=${a.C_judge.confidence} abstain=${a.C_judge.abstain} via ${a.C_judge.source}${jWrong ? '  << WRONG' : ''}`);
  if (a.C_judge.reasoning_summary) console.log(`  judge: ${a.C_judge.reasoning_summary}`);
  for (const s of MULTI_SOLVERS) {
    const at = attempts.filter((x) => x.claim_id === c.id && x.condition_key === s.key && x.ok).at(-1);
    if (!at) continue;
    console.log(`  ${s.key} (${s.model.replace('claude-', '')}/${s.strategy}): ${at.output.answer} conf=${at.output.confidence} :: ${at.output.reasoning_summary.slice(0, 220)}`);
  }
  console.log();
}
console.log(`\n${n} failure cases shown (which=${WHICH}, split=${SPLIT})`);
