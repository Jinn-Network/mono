import { describe, it, expect } from 'vitest';
import { classify, ALL_BUCKETS } from '../../scripts/classify-failure.js';
import type { Bucket } from '../../scripts/classify-failure.js';

// Representative `failure_reason` strings sampled verbatim from the live
// ~/.jinn-client/jinn.db FAILED task_runs corpus (issue #577). Each case asserts
// BOTH the bucket and the firing rule id — the rule id proves the *intended*
// rule won, which is the whole point of the four ordering invariants.

describe('classify — one representative reason per bucket', () => {
  it('provider_api_error — bare OpenRouter/hermes 403 budget limit (r01)', () => {
    const c = classify('Error code: 403 - Budget limit exceeded (monthly limit).');
    expect(c.bucket).toBe<Bucket>('provider_api_error');
    expect(c.ruleId).toBe('r01');
  });

  it('provider_api_error — IPFS registry 413 (r03)', () => {
    const c = classify(
      'IPFS registry upload failed with status 413: <html><title>413 Request Entity Too Large</title>',
    );
    expect(c.bucket).toBe<Bucket>('provider_api_error');
    expect(c.ruleId).toBe('r03');
  });

  it('provider_api_error — HuggingFace / substrate-pool data-provider fetch (r04)', () => {
    // Real corpus string with no embedded HTTP status number, so r04 (`substrate_pool_load_failed`)
    // is the firing rule. NOTE the `hf_fetch_failed … returned 429` variant fires r02 first
    // (also provider_api_error) — same bucket, earlier rule; the bucket count is unaffected.
    const c = classify(
      'impl skipped: substrate_pool_load_failed — cannot verify substrate (pool load failed): Unexpected token',
    );
    expect(c.bucket).toBe<Bucket>('provider_api_error');
    expect(c.ruleId).toBe('r04');
  });

  it('lease_expired_no_delivery — standalone claim expiry (r06)', () => {
    const c = classify('TCAttemptClaimExpired(77, 1)');
    expect(c.bucket).toBe<Bucket>('lease_expired_no_delivery');
    expect(c.ruleId).toBe('r06');
  });

  it('daemon_restart_mid_attempt — recovery artifact missing (r07)', () => {
    const c = classify('recovery: Required artifact missing in work dir');
    expect(c.bucket).toBe<Bucket>('daemon_restart_mid_attempt');
    expect(c.ruleId).toBe('r07');
  });

  it('daemon_restart_mid_attempt — residual recovery path with no inner signature (r08)', () => {
    // The bare r08 catch-all: a `recovery:` envelope that carries neither a claim-expiry
    // (r06), an artifact-missing (r07), nor a provider signature (r04). NOTE the real
    // `recovery: HF datasets-server returned 502 …` row instead lands in provider_api_error
    // (r04 — `datasets-server` — beats r08 by the verbatim cascade ordering); see the DR.
    const c = classify('recovery: failed to reconstruct in-flight attempt after restart');
    expect(c.bucket).toBe<Bucket>('daemon_restart_mid_attempt');
    expect(c.ruleId).toBe('r08');
  });

  it('ordering: a recovery-wrapped HF 502 lands in provider_api_error via r04, not r08', () => {
    // Real corpus string. `datasets-server` (r04) precedes the recovery catch (r08) in the
    // verbatim cascade, so this is scored provider, not restart. Documented in the DR.
    const c = classify('recovery: HF datasets-server returned 502 for nebius/SWE-rebench-leaderboard/2026_02');
    expect(c.bucket).toBe<Bucket>('provider_api_error');
    expect(c.ruleId).toBe('r04');
  });

  it('harness_subprocess_crash — adapter child exit code=1 (r10)', () => {
    const c = classify('claude-code adapter: child exited with code=1 signal=null:');
    expect(c.bucket).toBe<Bucket>('harness_subprocess_crash');
    expect(c.ruleId).toBe('r10');
  });

  it('harness_subprocess_crash — session-start hook failure (r10)', () => {
    const c = classify(
      'codex-code adapter: session-start hook failed: bash: /…/hooks/session-start: No such file or directory',
    );
    expect(c.bucket).toBe<Bucket>('harness_subprocess_crash');
    expect(c.ruleId).toBe('r10');
  });

  it('daemon_restart_mid_attempt — AbortController fired (r11)', () => {
    const c = classify('This operation was aborted');
    expect(c.bucket).toBe<Bucket>('daemon_restart_mid_attempt');
    expect(c.ruleId).toBe('r11');
  });

  it('rpc_outage — bare transport failure (r12)', () => {
    const c = classify('fetch failed');
    expect(c.bucket).toBe<Bucket>('rpc_outage');
    expect(c.ruleId).toBe('r12');
  });

  it('solver_produced_wrong_answer — patch_corrupt (r14)', () => {
    const c = classify(
      'impl skipped: eval_not_gradeable:patch_corrupt — swe-rebench-v2 eval could not grade the solution (patch_corrupt)',
    );
    expect(c.bucket).toBe<Bucket>('solver_produced_wrong_answer');
    expect(c.ruleId).toBe('r14');
  });

  it('unknown — admission missing/unscorable (r16)', () => {
    const c = classify(
      'impl skipped: admission_missing_or_unscorable — no scorable admission for BerriAI__litellm-16429 under semanticsVersion=3',
    );
    expect(c.bucket).toBe<Bucket>('unknown');
    expect(c.ruleId).toBe('r16');
  });

  it('solver_produced_wrong_answer — evaluator produced no verdictPayload (r17)', () => {
    const c = classify(
      'pack: evaluator impl for 0x96e2…ad2 did not produce verdictPayload on Solution; ensure the impl populates it',
    );
    expect(c.bucket).toBe<Bucket>('solver_produced_wrong_answer');
    expect(c.ruleId).toBe('r17');
  });

  it('rpc_outage — Safe execTransaction GS0xx revert (r18)', () => {
    const c = classify(
      'The contract function "execTransaction" reverted with the following reason: GS013  Contract Call:',
    );
    expect(c.bucket).toBe<Bucket>('rpc_outage');
    expect(c.ruleId).toBe('r18');
  });

  it('race_loss_misclassified — superseded by single-flight (r19)', () => {
    const c = classify('operator cleanup after swe generator burst; superseded by single-flight retry');
    expect(c.bucket).toBe<Bucket>('race_loss_misclassified');
    expect(c.ruleId).toBe('r19');
  });
});

describe('classify — the four ordering invariants (must never be reshuffled)', () => {
  // Invariant 1: provider-error rules (r01–r05) beat the generic child-exit crash (r10).
  it('403 nested inside a hermes child-exit is provider_api_error, NOT harness_subprocess_crash', () => {
    const c = classify(
      "hermes-agent: child exited code=1 signal=null: Error: Error code: 403 - {'error': {'message': 'Budget limit exceeded'}}",
    );
    expect(c.bucket).toBe<Bucket>('provider_api_error');
    expect(c.ruleId).toBe('r01');
  });

  // Finding 1 (#577 review): r05 must match ONLY the precise `Error code: 5xx` form. A real provider
  // 5xx still lands in provider_api_error via r05 …
  it('a precise `Error code: 502` is provider_api_error via r05', () => {
    const c = classify(
      "hermes-agent: child exited code=1 signal=null: Error: Error code: 502 - {'error': {'message': 'Bad gateway'}}",
    );
    expect(c.bucket).toBe<Bucket>('provider_api_error');
    expect(c.ruleId).toBe('r05');
  });

  // … but a harness crash that merely carries a standalone 50x token before the word "error"
  // (the dropped loose `\b50[023]\b.*error` alternative) must NOT be skimmed into provider — it is
  // a real subprocess crash and belongs in r10.
  it('a child-exit crash with a stray 502 token before "error" is harness_subprocess_crash (r10), NOT provider', () => {
    const c = classify('claude-code adapter: child exited code=1 signal=null: 502 tokens, fatal error');
    expect(c.bucket).toBe<Bucket>('harness_subprocess_crash');
    expect(c.ruleId).toBe('r10');
  });

  // Finding 2 (#577 review): a supersede reason that happens to carry a bare 429 token must NOT be
  // pre-empted by r02 (provider 429); the `superseded`/`single-flight` guard lets it reach r19.
  it('a superseded supersede reason carrying a stray 429 is race_loss_misclassified (r19), NOT provider', () => {
    const c = classify('operator cleanup after swe generator burst; superseded by single-flight retry (queue depth 429)');
    expect(c.bucket).toBe<Bucket>('race_loss_misclassified');
    expect(c.ruleId).toBe('r19');
  });

  // Invariant 2: claim-expiry (r06) beats recovery (r07/r08) and the Safe-revert catch (r18).
  it('claim-expiry inside a recovery / Safe inner-revert envelope is lease_expired_no_delivery, NOT restart or rpc', () => {
    const c = classify('recovery: Safe execTransaction inner revert (estimate): TCAttemptClaimExpired(126, 0)');
    expect(c.bucket).toBe<Bucket>('lease_expired_no_delivery');
    expect(c.ruleId).toBe('r06');
  });

  // Invariant 3: SIGTERM/143 (r09) beats the generic child-exit crash (r10).
  it('child exited code=143 (SIGTERM) is daemon_restart_mid_attempt, NOT harness_subprocess_crash', () => {
    const c = classify('claude-code adapter: child exited with code=143 signal=null:');
    expect(c.bucket).toBe<Bucket>('daemon_restart_mid_attempt');
    expect(c.ruleId).toBe('r09');
  });

  // Invariant 4: patch_* (r14) split from pytest_missing/docker/timeout (r15).
  it('eval_not_gradeable:pytest_missing is unknown (r15), NOT solver_produced_wrong_answer', () => {
    const c = classify(
      'impl skipped: eval_not_gradeable:pytest_missing — swe-rebench-v2 eval could not grade the solution (pytest_missing)',
    );
    expect(c.bucket).toBe<Bucket>('unknown');
    expect(c.ruleId).toBe('r15');
  });
});

describe('classify — fallthrough and totality', () => {
  it('an unmatched reason falls through to unknown via the explicit r21 catch-all', () => {
    const c = classify('some never-before-seen packaging error with no known signature');
    expect(c.bucket).toBe<Bucket>('unknown');
    expect(c.ruleId).toBe('r21');
  });

  it('is total over null / undefined / empty input (all → unknown r21)', () => {
    for (const input of [null, undefined, '']) {
      const c = classify(input);
      expect(c.bucket).toBe<Bucket>('unknown');
      expect(c.ruleId).toBe('r21');
    }
  });

  it('exposes exactly the 8 prescribed buckets in canonical order', () => {
    expect(ALL_BUCKETS).toEqual([
      'harness_subprocess_crash',
      'provider_api_error',
      'rpc_outage',
      'daemon_restart_mid_attempt',
      'lease_expired_no_delivery',
      'solver_produced_wrong_answer',
      'race_loss_misclassified',
      'unknown',
    ]);
  });
});
