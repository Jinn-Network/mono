/**
 * Pure, dependency-free failure-cause classifier for FAILED `task_runs` rows
 * (issue #577). Importable by both the audit script and its vitest unit test —
 * NO DB, NO I/O, NO `process` access.
 *
 * The only error-carrying column in `task_runs` is `failure_reason` (there is no
 * `last_error`/`stderr`/`log`/`trace` column — confirmed via `PRAGMA table_info`),
 * so this is a deterministic, priority-ordered string-matching cascade over that
 * single field. Rules are evaluated top-to-bottom; the FIRST match wins; each row
 * gets exactly one bucket. Rule r21 is an explicit always-true `unknown` catch-all
 * so the drilldown can always print which rule fired.
 *
 * Design spec: spec/.../issue-577 design note — the 21-rule cascade is verbatim
 * from there. Four ordering invariants must never be reshuffled:
 *   1. provider-error rules (r01–r05) BEFORE the generic `child exited` crash (r10)
 *   2. claim-expiry (r06) BEFORE recovery (r07–r08) and the Safe-revert catch (r18)
 *   3. SIGTERM/143 (r09) BEFORE the generic `child exited` crash (r10)
 *   4. patch_* (r14) split from pytest_missing/docker_unavailable/eval_timeout (r15)
 */

/** The 8 prescribed failure buckets (issue #577), in canonical order. */
export type Bucket =
  | 'harness_subprocess_crash'
  | 'provider_api_error'
  | 'rpc_outage'
  | 'daemon_restart_mid_attempt'
  | 'lease_expired_no_delivery'
  | 'solver_produced_wrong_answer'
  | 'race_loss_misclassified'
  | 'unknown';

/** All buckets in canonical order — used by the audit script for stable output. */
export const ALL_BUCKETS: Bucket[] = [
  'harness_subprocess_crash',
  'provider_api_error',
  'rpc_outage',
  'daemon_restart_mid_attempt',
  'lease_expired_no_delivery',
  'solver_produced_wrong_answer',
  'race_loss_misclassified',
  'unknown',
];

export interface Classification {
  bucket: Bucket;
  /** 'r01'..'r21' — the rule that fired; load-bearing for the audit drilldown. */
  ruleId: string;
}

interface Rule {
  id: string;
  bucket: Bucket;
  /**
   * Receives BOTH the original-case reason (for regex/word-boundary tests) and a
   * pre-lowercased copy (for cheap case-insensitive substring tests). Keeps the
   * rule table flat and re-readable.
   */
  test: (raw: string, lower: string) => boolean;
}

const has = (lower: string, needle: string): boolean => lower.includes(needle.toLowerCase());

function hasProvider429Context(raw: string, lower: string): boolean {
  if (/error code:\s*429/i.test(raw) || /\b(?:http\s+)?status\s*[:=]?\s*429\b/i.test(raw)) return true;
  if (!/\b429\b/.test(raw)) return false;
  return (
    /\b(?:rate[-\s]?limit(?:ed|ing)?|too many requests)\b/i.test(raw) ||
    /\b(?:returned|returning|response|responded|failed with)\s+(?:with\s+)?429\b/i.test(raw) ||
    /\b(?:openrouter|provider|api)\b.{0,80}\b(?:returned|returning|status|error[-\s]?code|rate[-\s]?limit|too many requests)\b.{0,80}\b429\b/i.test(
      raw,
    ) ||
    /\b429\b.{0,80}\b(?:from|by|via)\b.{0,80}\b(?:openrouter|provider|api)\b/i.test(raw)
  );
}

/**
 * The ordered rule table. Evaluated top-to-bottom; first match wins. Each row is
 * `{ id, bucket, test }` with a one-line rationale comment. DO NOT reorder without
 * checking the four ordering invariants above.
 */
const RULES: Rule[] = [
  // r01 — OpenRouter/hermes 403 budget-limit, even wrapped inside a child-exit crash.
  //       MUST beat r10. (Invariant 1.)
  {
    id: 'r01',
    bucket: 'provider_api_error',
    test: (raw, lower) => /error code:\s*403/i.test(raw) || (/\b403\b/.test(raw) && has(lower, 'budget limit')),
  },
  // r02 — provider rate-limit (429), incl. nested inside a subprocess exit. Requires
  //       provider/rate-limit/status context so a bare token count or queue depth of
  //       `429` does not pre-empt the more specific downstream rules.
  {
    id: 'r02',
    bucket: 'provider_api_error',
    test: (raw, lower) =>
      !has(lower, 'superseded') && !has(lower, 'single-flight') && hasProvider429Context(raw, lower),
  },
  // r03 — IPFS registry (Autonolas) rejected the upload — provider/gateway error.
  {
    id: 'r03',
    bucket: 'provider_api_error',
    test: (_raw, lower) => has(lower, '413 request entity too large') || has(lower, 'status 413'),
  },
  // r04 — HuggingFace datasets-server / substrate pool fetch failure — external data provider.
  {
    id: 'r04',
    bucket: 'provider_api_error',
    test: (_raw, lower) =>
      has(lower, 'hf_fetch_failed') || has(lower, 'substrate_pool_load_failed') || has(lower, 'datasets-server'),
  },
  // r05 — provider 5xx (incl. nested in a child-exit), distinct from chain RPC. Matches ONLY the
  //       precise `Error code: 5xx` form (mirrors the 403/429 rules); the loose
  //       `\b50[023]\b.*error` alternative was dropped post-review (#577) because it greedily
  //       claimed any child-exit crash carrying a standalone 500/502/503 token before "error"
  //       (e.g. `…: 502 tokens, fatal error`), masking real harness crashes that belong in r10.
  {
    id: 'r05',
    bucket: 'provider_api_error',
    test: (raw) => /error code:\s*5\d\d/i.test(raw),
  },
  // r06 — on-chain claim/verdict lease expired before delivery, true even when wrapped
  //       in a `recovery:` or Safe inner-revert envelope. MUST beat r07/r08 and r18.
  //       (Invariant 2.)
  {
    id: 'r06',
    bucket: 'lease_expired_no_delivery',
    test: (_raw, lower) => has(lower, 'tcattemptclaimexpired') || has(lower, 'tcverdictclaimexpired'),
  },
  // r07 — in-flight recovery on restart found a work-dir artifact gone — attempt was
  //       interrupted by a daemon bounce.
  {
    id: 'r07',
    bucket: 'daemon_restart_mid_attempt',
    test: (_raw, lower) => has(lower, 'recovery:') && has(lower, 'required artifact missing'),
  },
  // r08 — residual recovery-path failures are by definition restart-time reconstruction
  //       failures. Lower priority than r06 so a recovery-wrapped claim-expiry is lease.
  {
    id: 'r08',
    bucket: 'daemon_restart_mid_attempt',
    test: (_raw, lower) => has(lower, 'recovery:'),
  },
  // r09 — exit 143 = 128+15 = SIGTERM: the daemon terminated the child on shutdown/restart,
  //       not a solver crash. Bare SIGKILL is not an orderly restart marker; let r10 catch
  //       child-exit crashes or r21 leave non-child SIGKILL text unknown. MUST beat r10.
  //       (Invariant 3.)
  {
    id: 'r09',
    bucket: 'daemon_restart_mid_attempt',
    test: (raw, lower) =>
      /child exited.*code=143/i.test(raw) || has(lower, 'signal=sigterm'),
  },
  // r10 — codex/claude/hermes adapter subprocess died non-zero (code=1) or its session-start
  //       bash hook errored — harness-side crash. Catches the residual code=1 rows after the
  //       provider-error rules skimmed off 1–5.
  {
    id: 'r10',
    bucket: 'harness_subprocess_crash',
    test: (_raw, lower) => has(lower, 'child exited') || has(lower, 'session-start hook failed'),
  },
  // r11 — AbortController fired with no provider/HTTP signature attached — in this corpus these
  //       track daemon shutdown mid-attempt. Heuristic (see caveats).
  {
    id: 'r11',
    bucket: 'daemon_restart_mid_attempt',
    test: (_raw, lower) => has(lower, 'this operation was aborted'),
  },
  // r12 — bare transport failures with no provider-API body — in a chain-RPC-heavy daemon these
  //       are the JSON-RPC fallback chain exhausting. Best-guess (caveat).
  {
    id: 'r12',
    bucket: 'rpc_outage',
    test: (_raw, lower) =>
      has(lower, 'fetch failed') ||
      has(lower, 'econnrefused') ||
      has(lower, 'etimedout') ||
      has(lower, 'enotfound') ||
      has(lower, 'socket hang up'),
  },
  // r13 — nonce-desync from a stale RPC view / concurrent signer — a chain-interaction/RPC fault.
  {
    id: 'r13',
    bucket: 'rpc_outage',
    test: (_raw, lower) =>
      has(lower, 'nonce provided for the transaction') && has(lower, 'lower than the current nonce'),
  },
  // r14 — the solver's *patch itself* failed to apply / was corrupt / conflicted — a wrong /
  //       unusable answer, attributable to the solver. Split from r15. (Invariant 4.)
  {
    id: 'r14',
    bucket: 'solver_produced_wrong_answer',
    test: (_raw, lower) =>
      has(lower, 'eval_not_gradeable:patch_does_not_apply') ||
      has(lower, 'eval_not_gradeable:patch_corrupt') ||
      has(lower, 'eval_not_gradeable:patch_merge_conflict'),
  },
  // r15 — task-side / eval-infra ungradeable (harness env, not the solver and not a clean
  //       provider call). Honestly unattributable → unknown rather than force-fit.
  {
    id: 'r15',
    bucket: 'unknown',
    test: (_raw, lower) =>
      has(lower, 'eval_not_gradeable:pytest_missing') ||
      has(lower, 'eval_not_gradeable:docker_unavailable') ||
      has(lower, 'eval_not_gradeable:eval_timeout'),
  },
  // r16 — no scorable admission produced; could be solver, task spec, or pool — ambiguous.
  {
    id: 'r16',
    bucket: 'unknown',
    test: (_raw, lower) => has(lower, 'admission_missing_or_unscorable'),
  },
  // r17 — evaluator impl ran but emitted no verdict payload — the (evaluator) solver produced
  //       an unusable result.
  {
    id: 'r17',
    bucket: 'solver_produced_wrong_answer',
    test: (_raw, lower) => has(lower, 'pack:') && has(lower, 'did not produce verdictpayload'),
  },
  // r18 — Safe `execTransaction` revert / `GS0xx` signature error with no claim-expiry inside —
  //       a chain-interaction failure surfaced through the RPC; lowest-confidence on-chain
  //       bucket. Below r06 so claim-expiry reverts are scored correctly. (Invariant 2.)
  {
    id: 'r18',
    bucket: 'rpc_outage',
    test: (raw) => /\bGS0\d\d\b/i.test(raw) || /execTransaction.*reverted/i.test(raw) || /unknown error.*execTransaction/i.test(raw),
  },
  // r19 — operator cleanup after a generator burst deliberately superseded a duplicate attempt;
  //       should have been RACE_LOST (#896) but was written FAILED — not a real failure.
  {
    id: 'r19',
    bucket: 'race_loss_misclassified',
    test: (_raw, lower) => has(lower, 'single-flight') || has(lower, 'superseded'),
  },
  // r20 — learner harness failed to harvest its typed payload — harness-internal crash.
  {
    id: 'r20',
    bucket: 'harness_subprocess_crash',
    test: (_raw, lower) => has(lower, '[claude-code-learner]') && has(lower, 'harvestoutput'),
  },
  // r21 — explicit catch-all. Every unmatched reason is surfaced verbatim in the drilldown so
  //       future rules can be added.
  {
    id: 'r21',
    bucket: 'unknown',
    test: () => true,
  },
];

/**
 * Classify a single `failure_reason` string into one of the 8 buckets. Total over
 * null / undefined / empty (all → `{ unknown, r21 }`). First-match-wins over RULES.
 */
export function classify(reason: string | null | undefined): Classification {
  const raw = (reason ?? '').toString();
  const lower = raw.toLowerCase();
  for (const rule of RULES) {
    if (rule.test(raw, lower)) return { bucket: rule.bucket, ruleId: rule.id };
  }
  // RULES ends in r21 (always-true), so this is unreachable — guard for totality.
  return { bucket: 'unknown', ruleId: 'r21' };
}
