/**
 * Convert a delivered oracle-dispute export into the benchmark's two-file form.
 *
 *   node bench/ingest-disputes.mjs --in <export.jsonl> [--out-dir bench/real]
 *                                  [--report-only]
 *
 * Design constraints, from the experiment brief:
 *
 *  - Ground truth comes ONLY from the protocol's recorded resolution. Nothing in
 *    this file asks a model anything. Decoding is mechanical; topic exclusion is
 *    keyword-based and every decision is logged so it can be audited or reversed.
 *  - The protocol's own wording is preserved. We split reality.eth's raw question
 *    string on its documented delimiter and use those fields verbatim; we never
 *    paraphrase.
 *  - Cases we cannot score, cannot replay cleanly, or cannot classify are
 *    excluded from the primary set and written to a review file rather than
 *    silently dropped.
 *
 * There is deliberately no fallback that invents data. If the export is absent
 * this exits non-zero.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const IN = arg('--in', '');
const OUT_DIR = arg('--out-dir', join(ROOT, 'bench/real'));
const REPORT_ONLY = argv.includes('--report-only');

if (!IN) {
  console.error('usage: node bench/ingest-disputes.mjs --in <export.jsonl>');
  console.error('No export file supplied. See DATA_REQUEST.md — this experiment does not');
  console.error('run on substitute or model-generated data.');
  process.exit(2);
}
if (!existsSync(IN)) {
  console.error(`export not found: ${IN}`);
  process.exit(2);
}

// ── reality.eth answer decoding ───────────────────────────────────────────
const INVALID = 'f'.repeat(64);
const TOO_SOON = `${'f'.repeat(63)}e`;
const hexBody = (h) => String(h ?? '').replace(/^0x/, '').toLowerCase().padStart(64, '0');

/**
 * Built-in template tables, verbatim from @reality.eth/contracts
 * config/templates.json (contracts < 3.2) and config/templates_3.2.json (>= 3.2).
 *
 * The same template_id means DIFFERENT things across versions — field 2 of the
 * bool template is `category` before 3.2 and `description` from 3.2 — and ids
 * >= 6 are custom templates registered via LogNewTemplate. Hardcoding ids would
 * therefore mislabel question text. We parse the template format string instead
 * and only fall back to these tables when the export omits it.
 */
const BUILTIN_TEMPLATES = {
  legacy: {
    0: '{"title": "%s", "type": "bool", "category": "%s", "lang": "%s"}',
    1: '{"title": "%s", "type": "uint", "decimals": 18, "category": "%s", "lang": "%s"}',
    2: '{"title": "%s", "type": "single-select", "outcomes": [%s], "category": "%s", "lang": "%s"}',
    3: '{"title": "%s", "type": "multiple-select", "outcomes": [%s], "category": "%s", "lang": "%s"}',
    4: '{"title": "%s", "type": "datetime", "category": "%s", "lang": "%s"}',
  },
  v32: {
    0: '{"title": "%s", "type": "bool", "description": "%s", "lang": "%s"}',
    1: '{"title": "%s", "type": "uint", "decimals": 18, "description": "%s", "lang": "%s"}',
    2: '{"title": "%s", "type": "single-select", "outcomes": [%s], "description": "%s", "lang": "%s"}',
    3: '{"title": "%s", "type": "multiple-select", "outcomes": [%s], "description": "%s", "lang": "%s"}',
    4: '{"title": "%s", "type": "datetime", "description": "%s", "lang": "%s"}',
    5: '{"title": "%s", "type": "hash", "description": "%s", "lang": "%s"}',
  },
};

/** Version >= 3.2 uses the description-flavoured table. */
function templateTableFor(version) {
  const m = /(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 3 || (major === 3 && minor >= 2) ? BUILTIN_TEMPLATES.v32 : BUILTIN_TEMPLATES.legacy;
}

function resolveTemplateText(rec) {
  if (rec.template_text) return { text: rec.template_text, provenance: 'export' };
  const table = templateTableFor(rec.contract_version);
  if (!table) return { text: null, provenance: 'unknown-version' };
  const text = table[rec.template_id];
  return text ? { text, provenance: 'builtin' } : { text: null, provenance: 'custom-template-not-supplied' };
}

/**
 * Field names, in order, taken from the template's %s placeholders.
 * '{"title": "%s", "type": "bool", "description": "%s", "lang": "%s"}'
 *   -> ['title', 'description', 'lang']
 * Literal values ("type": "bool", "decimals": 18) carry no placeholder and are
 * correctly skipped, so custom templates work without special-casing.
 */
function templateFieldNames(templateText) {
  const names = [];
  const re = /"([^"]+)"\s*:\s*(\[\s*%s\s*\]|"%s")/g;
  let m;
  while ((m = re.exec(templateText))) names.push(m[1]);
  return names;
}

/** Answer type comes from the template, not the id, for the same reason. */
function templateType(templateText) {
  const m = /"type"\s*:\s*"([^"]+)"/.exec(String(templateText ?? ''));
  return m ? m[1] : null;
}

/**
 * Returns { kind, value } — kind is 'answer' | 'invalid' | 'too_soon'.
 * `yesNoOutcomes`: for a single-select question whose outcome list is exactly
 * a Yes/No pair, the positional outcome labels — so OPTION_n maps to YES/NO
 * mechanically, by the protocol's own outcome order.
 */
function decodeAnswer(raw, type, yesNoOutcomes = null) {
  const b = hexBody(raw);
  if (b === INVALID) return { kind: 'invalid', value: 'INVALID' };
  if (b === TOO_SOON) return { kind: 'too_soon', value: 'ANSWERED_TOO_SOON' };
  const n = BigInt(`0x${b}`);
  if (type === 'bool') {
    if (n === 0n) return { kind: 'answer', value: 'NO' };
    if (n === 1n) return { kind: 'answer', value: 'YES' };
    return { kind: 'answer', value: `BOOL_${n}` };
  }
  if (type === 'single-select') {
    if (yesNoOutcomes && n < BigInt(yesNoOutcomes.length)) {
      return { kind: 'answer', value: yesNoOutcomes[Number(n)].toUpperCase() };
    }
    return { kind: 'answer', value: `OPTION_${n}` };
  }
  if (type === 'multiple-select') return { kind: 'answer', value: `BITFIELD_${n.toString(2)}` };
  return { kind: 'answer', value: n.toString() };
}

/**
 * Outcome labels for a single-select question when and only when they form a
 * Yes/No pair (any order, any case). Such a question is mechanically a
 * boolean: the option set IS {yes, no}, so mapping OPTION_n through the
 * outcome list is the protocol's own semantics, not an interpretation. The
 * dominant real-dispute population (Omen markets) has this shape.
 */
function yesNoSelectOutcomes(type, outcomesRaw) {
  if (type !== 'single-select') return null;
  let outs;
  try { outs = JSON.parse(`[${outcomesRaw}]`).map((s) => String(s).trim()); } catch { return null; }
  if (outs.length !== 2) return null;
  const lower = outs.map((s) => s.toLowerCase());
  if (lower.includes('yes') && lower.includes('no')) return outs;
  return null;
}

/**
 * reality.eth packs the question fields into one string separated by U+241F
 * (SYMBOL FOR UNIT SEPARATOR), positionally matching the template placeholders.
 * We keep every part and label it by the template's own field name rather than
 * reformatting or guessing.
 */
const SEP = '\u241f';
function splitQuestion(raw, templateText) {
  const parts = String(raw ?? '').split(SEP);
  const names = templateText ? templateFieldNames(templateText) : [];
  const fields = {};
  names.forEach((name, i) => { fields[name] = parts[i] ?? ''; });
  return {
    parts,
    fields,
    title: fields.title ?? parts[0] ?? '',
    description: fields.description ?? '',
    category: fields.category ?? '',
    lang: fields.lang ?? '',
    outcomes: fields.outcomes ?? '',
  };
}

// ── mechanical topic exclusion ────────────────────────────────────────────
// Keyword-based on purpose: an LLM classifier here would put a model back in the
// selection loop. Everything matched is logged with the term that matched, so the
// filter can be audited and tuned by hand against the delivered data.
const EXCLUDE = [
  { tag: 'sports', terms: ['premier league', 'la liga', 'serie a', 'bundesliga', 'champions league', 'world cup match', 'super bowl', 'nba ', 'nfl ', 'mlb ', 'nhl ', 'ufc ', 'grand prix', 'formula 1', 'f1 ', 'tennis', 'atp ', 'wta ', 'cricket', 'rugby', 'olympic medal', ' vs ', ' v. ', 'final score', 'who will win the match'] },
  { tag: 'price', terms: ['price of', 'closing price', 'trade above', 'trade below', 'reach $', 'exceed $', 'market cap of', 'usd price', 'price be on', 'all-time high', 'ath '] },
  { tag: 'trivial-election-count', terms: ['how many seats', 'number of electoral votes', 'popular vote total', 'vote share percentage'] },
];

function classifyExclusion(title) {
  const t = ` ${String(title).toLowerCase()} `;
  for (const group of EXCLUDE) {
    const hit = group.terms.find((term) => t.includes(term));
    if (hit) return { tag: group.tag, term: hit };
  }
  // No researchable proposition: single-token/two-token titles in the real
  // population are usernames, IPFS CIDs, hex addresses, module ids and
  // greetings ("clesaege", "QmV7…", "HELLO") — protocol-genuine disputes, but
  // no resolver of any architecture can investigate them from the text.
  // CJK-script titles are exempt (no whitespace segmentation).
  const words = String(title).trim().split(/\s+/).filter(Boolean);
  const hasCjk = /[　-鿿가-힯぀-ヿ]/.test(String(title));
  if (words.length < 3 && !hasCjk) return { tag: 'no-researchable-proposition', term: `<3 words` };
  return null;
}

// ── stratification, computed from the bond ladder ─────────────────────────
function strata(rec) {
  const hist = rec.answer_history ?? [];
  const distinct = new Set(hist.map((h) => hexBody(h.answer_raw)));
  let flips = 0;
  for (let i = 1; i < hist.length; i += 1) {
    if (hexBody(hist[i].answer_raw) !== hexBody(hist[i - 1].answer_raw)) flips += 1;
  }
  const bonds = hist.map((h) => { try { return BigInt(h.bond ?? '0'); } catch { return 0n; } });
  const peak = bonds.reduce((a, b) => (b > a ? b : a), 0n);
  const total = bonds.reduce((a, b) => a + b, 0n);
  const arb = rec.arbitration;
  return {
    n_answers: hist.length,
    n_distinct_answers: distinct.size,
    n_flips: flips,
    peak_bond: peak.toString(),
    total_bonded: total.toString(),
    bond_token: rec.bond_token?.symbol ?? (rec.bond_token?.kind === 'native' ? 'native' : null),
    arbitrated: Boolean(arb && !arb.cancelled),
    arbitration_cancelled: Boolean(arb?.cancelled),
    n_arbitration_rounds: arb?.rounds?.length ?? 0,
    appealed: Boolean(arb?.rounds?.some((r) => r.appealed)),
    n_evidence: arb?.evidence?.length ?? 0,
    dispute_class: arb && !arb.cancelled ? 'arbitrated' : 'bonded-only',
  };
}

/**
 * Replay cutoff: the moment the dispute existed but was not yet settled. Solvers
 * see the claim as of this instant, so later "the oracle resolved X" coverage is
 * out of bounds. Prefer the arbitration request; fall back to the last competing
 * answer before finalization.
 */
function cutoffTs(rec) {
  const arbTs = rec.arbitration?.requested_ts;
  if (arbTs) return arbTs;
  const hist = [...(rec.answer_history ?? [])].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const last = hist.at(-1);
  return last?.ts ?? rec.finalize_ts ?? null;
}

// ── ingest ────────────────────────────────────────────────────────────────
const lines = readFileSync(IN, 'utf8').split('\n').filter((l) => l.trim());
const problems = [];
const excluded = [];
const review = [];
const claims = [];
const truth = [];

lines.forEach((line, i) => {
  let rec;
  try { rec = JSON.parse(line); } catch (e) { problems.push({ line: i + 1, error: `unparseable JSON: ${e.message}` }); return; }

  const missing = ['source_protocol', 'case_id', 'question_raw', 'final_answer_raw', 'answer_history', 'finalize_ts']
    .filter((k) => rec[k] === undefined || rec[k] === null);
  if (missing.length) { problems.push({ line: i + 1, case_id: rec.case_id ?? null, error: `missing required fields: ${missing.join(', ')}` }); return; }
  if (!Array.isArray(rec.answer_history) || !rec.answer_history.length) {
    problems.push({ line: i + 1, case_id: rec.case_id, error: 'answer_history empty — cannot establish that this case was disputed' });
    return;
  }

  const tid = rec.template_id ?? 0;
  const tmpl = resolveTemplateText(rec);
  if (!tmpl.text) {
    review.push({ case_id: rec.case_id, reason: `cannot resolve template (${tmpl.provenance}); export must supply template_text for template_id ${tid}`, title: null });
    return;
  }
  const type = templateType(tmpl.text);
  const q = splitQuestion(rec.question_raw, tmpl.text);
  const yesNo = yesNoSelectOutcomes(type, q.outcomes);
  const final = decodeAnswer(rec.final_answer_raw, type, yesNo);
  const st = strata(rec);
  const cutoff = cutoffTs(rec);

  // Cases that cannot serve as scoreable ground truth stay out of the primary set.
  if (st.n_distinct_answers < 2 && !st.arbitrated && !st.arbitration_cancelled) {
    excluded.push({ case_id: rec.case_id, reason: 'not disputed: single answer, no arbitration', title: q.title });
    return;
  }
  // The solver output schema is YES / NO / UNRESOLVABLE, which scores exactly
  // for boolean templates AND for single-select questions whose outcome list
  // is a Yes/No pair (the dominant real-dispute shape — Omen markets). Other
  // templates need an answer-matching rule we have not designed, so they are
  // held back for a secondary set rather than admitted on a guess.
  if (type !== 'bool' && !yesNo) {
    review.push({ case_id: rec.case_id, reason: `non-boolean template (${type}) — held for secondary set; solver schema is YES/NO/UNRESOLVABLE`, title: q.title });
    return;
  }
  // A decoded final answer outside YES/NO/INVALID/TOO_SOON (e.g. an
  // out-of-range option index) cannot be scored against the solver schema.
  if (!['YES', 'NO', 'INVALID', 'ANSWERED_TOO_SOON'].includes(final.value)) {
    review.push({ case_id: rec.case_id, reason: `unscoreable final answer ${final.value}`, title: q.title });
    return;
  }
  if (!cutoff) {
    review.push({ case_id: rec.case_id, reason: 'no usable replay cutoff timestamp', title: q.title });
    return;
  }
  if (!q.title.trim()) {
    problems.push({ line: i + 1, case_id: rec.case_id, error: 'question_raw did not split into a title — was it pre-processed?' });
    return;
  }

  const ex = classifyExclusion(q.title);
  if (ex) { excluded.push({ case_id: rec.case_id, reason: `topic:${ex.tag}`, matched: ex.term, title: q.title }); return; }

  const id = `rd-${String(rec.source_protocol).replace(/\W/g, '')}-${String(rec.case_id).replace(/^0x/, '').slice(0, 12)}`;

  claims.push({
    id,
    question: q.title,
    // The protocol's own words. `description` is reality.eth's criteria field
    // (>= 3.2); older contracts carry only a category, in which case the title
    // is the whole question and there is nothing further to show.
    resolution_criteria: rec.uma?.resolution_source_text ?? q.description ?? '',
    cutoff_time: new Date(cutoff * 1000).toISOString(),
    source_protocol: rec.source_protocol,
    public_metadata: {
      template_type: type ?? `template_${tid}`,
      outcomes: q.outcomes || null,
      category: q.category || null,
      lang: q.lang || null,
      opening_time: rec.opening_ts ? new Date(rec.opening_ts * 1000).toISOString() : null,
    },
  });

  truth.push({
    id,
    final_resolution: final.value,
    final_resolution_raw: rec.final_answer_raw,
    resolution_kind: final.kind,
    resolution_timestamp: new Date(rec.finalize_ts * 1000).toISOString(),
    dispute_history: (rec.answer_history ?? []).map((h) => ({
      answer: decodeAnswer(h.answer_raw, type, yesNo).value,
      answer_raw: h.answer_raw,
      bond: h.bond,
      ts: h.ts ? new Date(h.ts * 1000).toISOString() : null,
      user: h.user ?? null,
    })),
    bond_history: { peak_bond: st.peak_bond, total_bonded: st.total_bonded, token: st.bond_token },
    arbitration_metadata: rec.arbitration
      ? {
          arbitrator: rec.arbitration.arbitrator ?? null,
          arbitrator_name: rec.arbitration.arbitrator_name ?? null,
          requested_ts: rec.arbitration.requested_ts ? new Date(rec.arbitration.requested_ts * 1000).toISOString() : null,
          cancelled: Boolean(rec.arbitration.cancelled),
          kleros_dispute_id: rec.arbitration.kleros_dispute_id ?? null,
          court_id: rec.arbitration.court_id ?? null,
          jurors: rec.arbitration.jurors ?? null,
          rounds: rec.arbitration.rounds ?? [],
          ruling_raw: rec.arbitration.ruling_raw ?? null,
          n_evidence: st.n_evidence,
        }
      : null,
    ground_truth_source: `${rec.source_protocol}:${rec.chain_id ?? '?'}:${rec.contract_address ?? '?'}:${rec.case_id}`,
    template: { id: tid, type, text: tmpl.text, provenance: tmpl.provenance },
    strata: st,
  });
});

const summary = {
  export_file: IN,
  lines_read: lines.length,
  admitted: claims.length,
  excluded: excluded.length,
  needs_review: review.length,
  malformed: problems.length,
  by_dispute_class: truth.reduce((a, t) => { a[t.strata.dispute_class] = (a[t.strata.dispute_class] ?? 0) + 1; return a; }, {}),
  by_resolution_kind: truth.reduce((a, t) => { a[t.resolution_kind] = (a[t.resolution_kind] ?? 0) + 1; return a; }, {}),
  distinct_answer_counts: truth.reduce((a, t) => { const k = `${t.strata.n_distinct_answers}`; a[k] = (a[k] ?? 0) + 1; return a; }, {}),
  // reality.eth contracts before 3.2 have no description field — the title IS
  // the whole question. Those cases reach the solver with empty criteria, which
  // is faithful to what the bonders saw but worth knowing before scoring.
  admitted_without_criteria: claims.filter((c) => !String(c.resolution_criteria).trim()).length,
};

console.log(JSON.stringify(summary, null, 2));
if (problems.length) {
  console.log('\nMalformed records (first 20) — these indicate an export-shape mismatch:');
  for (const p of problems.slice(0, 20)) console.log(`  line ${p.line}${p.case_id ? ` (${p.case_id})` : ''}: ${p.error}`);
}
if (claims.length < 50) {
  console.log(`\nWARNING: ${claims.length} usable cases. The brief targets 50-200; below 50 the`);
  console.log('comparison will not have the power to separate the conditions.');
}

if (REPORT_ONLY) process.exit(problems.length ? 1 : 0);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'claims.public.json'), JSON.stringify({
  note: 'Solver-visible fields ONLY. Ground truth lives in truth.json and is never read on the solver path.',
  source: IN,
  n: claims.length,
  claims,
}, null, 2));
writeFileSync(join(OUT_DIR, 'truth.json'), JSON.stringify({
  note: 'GROUND TRUTH — the protocol\'s own recorded resolution. Read only by bench/ tooling and src/score.mjs.',
  source: IN,
  n: truth.length,
  truth,
}, null, 2));
writeFileSync(join(OUT_DIR, 'ingest-log.json'), JSON.stringify({ summary, excluded, review, problems }, null, 2));
console.log(`\nwrote ${OUT_DIR}/{claims.public.json,truth.json,ingest-log.json}`);
