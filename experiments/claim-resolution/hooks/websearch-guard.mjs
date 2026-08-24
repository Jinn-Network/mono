#!/usr/bin/env node
/**
 * PreToolUse guard for solver subprocesses (leakage control).
 *
 * Two jobs:
 *   1. Deny any WebSearch whose query reaches for an oracle / prediction-market
 *      resolution page. The benchmark's ground truth is the *external*
 *      resolution; a solver that reads the resolution page off Polymarket or
 *      Kleros has not researched anything.
 *   2. Append every query (allowed or denied) to an audit log so the run can be
 *      inspected after the fact for contamination.
 *
 * Enabled per-solver-process via --settings; env:
 *   JINN_CR_AUDIT_LOG  path to a JSONL audit file (required)
 */
import { appendFileSync } from 'node:fs';

const BANNED = [
  // venues that publish the settled answer
  'polymarket', 'kleros', 'reality.eth', 'realitio', 'reality eth', 'augur',
  'omen.eth', 'omen prediction', 'gnosis prediction', 'metaculus',
  'presagio', 'aiomen', 'seer.pm', 'seer markets', 'gnosis market',
  'manifold market', 'manifold.markets', 'prediction market', 'predictionmarket',
  'kalshi', 'insight prediction', 'predictit', 'smarkets', 'betfair',
  'oddschecker', 'pinnacle odds', 'betting odds', 'election betting odds',
  // oracle machinery and dispute records
  'uma oracle', 'uma protocol', 'umip', 'optimistic oracle', 'data verification mechanism',
  'dvm vote', 'arbitrator answer', 'bond escalation', 'question id 0x',
  'dispute id', 'subgraph', 'etherscan', 'gnosisscan', 'blockscout',
  // phrasings that go looking for the outcome rather than the facts
  'resolution source', 'market resolved', 'resolved to yes', 'resolved to no',
  'final ruling was', 'jurors ruled', 'oracle resolved', 'how did it resolve',
  'was resolved as',
];

/**
 * Near-verbatim title search. Pasting the question's exact wording into a search
 * engine is the fastest way to surface the settlement record itself, so a query
 * that reproduces a long consecutive run of the question's own words is refused.
 * The threshold is deliberately high: paraphrase, keyword and entity searches all
 * pass, which is what genuine research looks like.
 */
const TITLE_SHINGLE_WORDS = 8;

function normalizeWords(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function verbatimTitleRun(query, title) {
  const t = normalizeWords(title);
  if (t.length < TITLE_SHINGLE_WORDS) return null;
  const q = ` ${normalizeWords(query).join(' ')} `;
  for (let i = 0; i + TITLE_SHINGLE_WORDS <= t.length; i += 1) {
    const shingle = t.slice(i, i + TITLE_SHINGLE_WORDS).join(' ');
    if (q.includes(` ${shingle} `)) return shingle;
  }
  return null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* fall through to allow */ }
  const input = payload.tool_input ?? {};
  const query = String(input.query ?? '');
  const domains = []
    .concat(input.allowed_domains ?? [])
    .concat(input.blocked_domains ?? [])
    .join(' ');
  const haystack = `${query} ${domains}`.toLowerCase();
  let hit = BANNED.find((term) => haystack.includes(term));
  let reason = hit ? `matched banned term "${hit}"` : null;

  if (!hit) {
    const run = verbatimTitleRun(query, process.env.JINN_CR_QUESTION_TITLE);
    if (run) {
      hit = 'verbatim-title';
      reason = `reproduced ${TITLE_SHINGLE_WORDS}+ consecutive words of the question verbatim ("${run}")`;
    }
  }

  const log = process.env.JINN_CR_AUDIT_LOG;
  if (log) {
    try {
      appendFileSync(log, JSON.stringify({
        ts: new Date().toISOString(),
        tool: payload.tool_name ?? null,
        query,
        allowed_domains: input.allowed_domains ?? null,
        decision: hit ? 'deny' : 'allow',
        banned_term: hit ?? null,
        reason,
        cutoff: process.env.JINN_CR_CUTOFF ?? null,
      }) + '\n');
    } catch { /* audit is best-effort; never block the run */ }
  }

  if (hit) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Query blocked by benchmark leakage guard: ${reason}. ` +
          `Prediction-market, betting and oracle resolution records are out of ` +
          `scope, and searching the question's exact wording surfaces them. ` +
          `Research the underlying facts from primary and news sources instead, ` +
          `using your own phrasing.`,
      },
    }));
  }
  process.exit(0);
});
