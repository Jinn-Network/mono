/**
 * Stage 4 — assemble the benchmark from verified + probed candidates.
 *
 * Emits two files, and the split between them is the leakage boundary:
 *
 *   bench/claims.public.json — id, claim, criteria, deadline, split. This is
 *     the ONLY file the solver execution path reads.
 *   bench/truth.json — ground truth, provenance, difficulty, dispute and
 *     contamination metadata. Read only by bench/ tooling and src/score.mjs.
 *
 * Admission rules (all must hold):
 *   - independent verifier agrees with the curator's ground truth
 *   - verifier confidence >= 0.85
 *   - verifier judged the criteria unambiguous
 *   - the claim is not a near-duplicate of one already admitted
 *
 *   node bench/build-dataset.mjs [--in bench/closed-book.json] [--target 100]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in', join(ROOT, 'bench/closed-book.json'));
const TARGET = Number(arg('--target', '100'));
const DEV_N = Number(arg('--dev', '20'));
const MIN_CONF = Number(arg('--min-conf', '0.85'));
const OUT_DIR = arg('--out-dir', join(ROOT, 'bench'));

const src = JSON.parse(readFileSync(IN, 'utf8'));
const rejected = [];
const admitted = [];

function tokens(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
}
function jaccard(a, b) {
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni ? inter / uni : 0;
}

for (const c of src.candidates) {
  const v = c.verification ?? {};
  const reasons = [];
  if (v.answer === 'UNVERIFIABLE') reasons.push('verifier could not establish the resolution');
  else if (v.answer !== c.ground_truth) reasons.push(`verifier disagreed (curator=${c.ground_truth}, verifier=${v.answer})`);
  if ((v.confidence ?? 0) < MIN_CONF) reasons.push(`verifier confidence ${v.confidence} < ${MIN_CONF}`);
  if (v.criteria_are_unambiguous === false) reasons.push('criteria judged ambiguous');
  if (!c.source_urls || c.source_urls.length < 2) reasons.push('fewer than two provenance URLs');

  if (reasons.length) { rejected.push({ claim: c.claim, bucket: c.bucket, reasons }); continue; }

  const tk = tokens(c.claim);
  const dup = admitted.find((a) => jaccard(a._tokens, tk) > 0.6);
  if (dup) { rejected.push({ claim: c.claim, bucket: c.bucket, reasons: [`near-duplicate of "${dup.claim.slice(0, 70)}..."`] }); continue; }

  admitted.push({ ...c, _tokens: tk });
}

// Cap class imbalance at 65/35 by dropping the least interesting items of the
// over-represented class (keep hard and disputed items preferentially).
function priority(c) {
  return (c.disputed ? 4 : 0) + (c.difficulty === 'hard' ? 2 : 0) + (c.closed_book?.correct ? 0 : 1);
}
let pool = [...admitted].sort((a, b) => priority(b) - priority(a));
const cap = Math.floor(TARGET * 0.65);
const kept = [];
const counts = { YES: 0, NO: 0 };
for (const c of pool) {
  if (kept.length >= TARGET) { rejected.push({ claim: c.claim, bucket: c.bucket, reasons: ['surplus beyond target'] }); continue; }
  if (counts[c.ground_truth] >= cap) { rejected.push({ claim: c.claim, bucket: c.bucket, reasons: ['dropped to cap YES/NO imbalance'] }); continue; }
  counts[c.ground_truth] += 1;
  kept.push(c);
}

// Deterministic ids and a deterministic dev/eval split (hash of the claim text,
// so the split does not depend on run order and cannot be reshuffled to taste).
const withIds = kept.map((c) => {
  const id = `cr-${createHash('sha256').update(c.claim).digest('hex').slice(0, 10)}`;
  return { ...c, id };
});
const sorted = [...withIds].sort((a, b) => a.id.localeCompare(b.id));
const devIds = new Set(sorted.slice(0, DEV_N).map((c) => c.id));

const publicClaims = withIds.map((c) => ({
  id: c.id,
  claim: c.claim,
  criteria: c.criteria,
  deadline: c.deadline,
  split: devIds.has(c.id) ? 'dev' : 'eval',
}));

const truth = withIds.map((c) => ({
  id: c.id,
  ground_truth: c.ground_truth,
  resolution_source: c.resolution_source,
  settlement_record: c.verification.settlement_record,
  source_urls: c.source_urls,
  verifier_sources: c.verification.sources,
  verifier_confidence: c.verification.confidence,
  verifier_model: c.verification.model,
  curator_model: c.curator_model,
  bucket: c.bucket,
  difficulty: c.difficulty,
  disputed: c.disputed,
  why_nontrivial: c.why_nontrivial,
  contamination_risk: c.deadline >= '2026-06-01' ? 'low' : 'high',
  closed_book: c.closed_book,
  verifier_notes: c.verification.notes,
}));

writeFileSync(join(OUT_DIR, 'claims.public.json'), JSON.stringify({
  note: 'Solver-visible fields ONLY. Ground truth lives in bench/truth.json and is never read on the solver path.',
  generated_at: new Date().toISOString(),
  n: publicClaims.length,
  claims: publicClaims,
}, null, 2));

writeFileSync(join(OUT_DIR, 'truth.json'), JSON.stringify({
  note: 'GROUND TRUTH — read only by bench/ tooling and src/score.mjs.',
  generated_at: new Date().toISOString(),
  n: truth.length,
  truth,
}, null, 2));

writeFileSync(join(OUT_DIR, 'rejected.json'), JSON.stringify({ n: rejected.length, rejected }, null, 2));

const by = (f) => truth.reduce((a, t) => { const k = f(t); a[k] = (a[k] ?? 0) + 1; return a; }, {});
console.log(`admitted ${truth.length} / ${src.candidates.length} candidates (${rejected.length} rejected)`);
console.log('ground truth:', by((t) => t.ground_truth));
console.log('difficulty:', by((t) => t.difficulty));
console.log('disputed:', by((t) => String(t.disputed)));
console.log('contamination_risk:', by((t) => t.contamination_risk));
console.log('closed-book correct:', truth.filter((t) => t.closed_book?.correct).length);
console.log('split:', by((t) => (devIds.has(t.id) ? 'dev' : 'eval')));
console.log('buckets:', by((t) => t.bucket));
