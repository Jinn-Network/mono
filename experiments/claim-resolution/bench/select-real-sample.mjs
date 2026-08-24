/**
 * Deterministic, mechanical sampling of the ingested real-dispute benchmark
 * down to a target size. Selection uses ONLY protocol-recorded dispute
 * behaviour — no model, no topic judgment, no difficulty guess. The rule was
 * fixed before the population was inspected.
 *
 *   node bench/select-real-sample.mjs [--in-dir bench/real] [--out-dir bench/real-sample]
 *                                     [--target 150] [--family-cap 10]
 *
 * Rule, in priority order (within each tier, order by dispute intensity:
 * n_distinct_answers desc, n_flips desc, n_answers desc, then case id asc for
 * determinism):
 *   1. arbitrated cases;
 *   2. cases whose protocol resolution was INVALID or ANSWERED_TOO_SOON
 *      (the abstention tests), capped at --special-cap;
 *   3. remaining bonded-only contested cases.
 *
 * REVISION (before any solver ran): the first version of this rule admitted
 * ALL of tier 2 before tier 3, which filled the sample with 61%
 * INVALID/TOO_SOON ground truths (population base rate: 7.5%) and zero
 * bonded-only YES/NO cases — a benchmark measuring only abstention. Tier 2 is
 * now capped (default 25 of 150 — still a deliberate ~3x oversample of the
 * base rate so abstention metrics have power) and the remainder is filled
 * with bonded-only contested cases per tier 3. Selection inputs are still
 * exclusively protocol-recorded behaviour.
 *
 * Family cap: questions sharing the same normalized title prefix (first 6
 * words) are capped per family, keeping the most disputed. This prevents one
 * templated question family (e.g. hundreds of near-identical DAO-proposal
 * verifications) from crowding out population diversity. Mechanical, logged,
 * reversible.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const IN_DIR = arg('--in-dir', join(ROOT, 'bench/real'));
const OUT_DIR = arg('--out-dir', join(ROOT, 'bench/real-sample'));
const TARGET = Number(arg('--target', '150'));
const FAMILY_CAP = Number(arg('--family-cap', '10'));
const SPECIAL_CAP = Number(arg('--special-cap', '25'));

const pub = JSON.parse(readFileSync(join(IN_DIR, 'claims.public.json'), 'utf8'));
const tru = JSON.parse(readFileSync(join(IN_DIR, 'truth.json'), 'utf8'));
const truthById = new Map(tru.truth.map((t) => [t.id, t]));

const family = (title) => String(title).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');

const tier = (t) => {
  if (t.strata.dispute_class === 'arbitrated') return 0;
  if (t.resolution_kind !== 'answer') return 1;
  return 2;
};
const intensity = (t) => [t.strata.n_distinct_answers, t.strata.n_flips, t.strata.n_answers];

const rows = pub.claims.map((c) => ({ c, t: truthById.get(c.id) })).filter((r) => r.t);
rows.sort((a, b) => {
  const dt = tier(a.t) - tier(b.t);
  if (dt) return dt;
  const ia = intensity(a.t);
  const ib = intensity(b.t);
  for (let i = 0; i < ia.length; i += 1) if (ib[i] !== ia[i]) return ib[i] - ia[i];
  return a.c.id < b.c.id ? -1 : 1;
});

const famCount = new Map();
const kept = [];
const dropped = [];
let nSpecial = 0;
for (const r of rows) {
  const f = family(r.c.question);
  const n = famCount.get(f) ?? 0;
  if (kept.length >= TARGET) { dropped.push({ id: r.c.id, reason: 'over-target', family: f }); continue; }
  if (n >= FAMILY_CAP) { dropped.push({ id: r.c.id, reason: `family-cap(${FAMILY_CAP})`, family: f }); continue; }
  if (tier(r.t) === 1 && nSpecial >= SPECIAL_CAP) { dropped.push({ id: r.c.id, reason: `special-cap(${SPECIAL_CAP})`, family: f }); continue; }
  if (tier(r.t) === 1) nSpecial += 1;
  famCount.set(f, n + 1);
  kept.push(r);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'claims.public.json'), JSON.stringify({
  note: pub.note,
  source: `${IN_DIR} (deterministic sample: tiers arbitrated > invalid/too-soon > bonded-only, intensity-ordered, family cap ${FAMILY_CAP}, target ${TARGET})`,
  n: kept.length,
  claims: kept.map((r) => r.c),
}, null, 2));
writeFileSync(join(OUT_DIR, 'truth.json'), JSON.stringify({
  note: tru.note,
  source: IN_DIR,
  n: kept.length,
  truth: kept.map((r) => r.t),
}, null, 2));
writeFileSync(join(OUT_DIR, 'sample-log.json'), JSON.stringify({
  target: TARGET,
  family_cap: FAMILY_CAP,
  in_population: rows.length,
  kept: kept.length,
  dropped: dropped.length,
  by_tier: kept.reduce((a, r) => { const k = ['arbitrated', 'invalid_too_soon', 'bonded_only'][tier(r.t)]; a[k] = (a[k] ?? 0) + 1; return a; }, {}),
  dropped_detail: dropped,
}, null, 2));
console.log(`kept ${kept.length}/${rows.length} -> ${OUT_DIR} (dropped ${dropped.length}; see sample-log.json)`);
