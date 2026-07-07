import { describe, it, expect } from 'vitest';
import { evaluateEligibility, redactionHealth } from '../src/gate.js';
import { parseTraceEnvelopeV0, type TraceEnvelopeV0 } from '../src/envelope.js';

/** A valid, clean, evaluator-verified pass trace; override any slice. */
function env(over: {
  status?: 'completed' | 'failed' | 'abandoned';
  tier?: 'user-accepted' | 'tests-passed' | 'evaluator-verified';
  provenance?: 'contributed' | 'imported';
  patch?: string;
  summary?: string;
  outcomeSummary?: string;
} = {}): TraceEnvelopeV0 {
  return parseTraceEnvelopeV0({
    schemaVersion: 'jinn.trace-envelope.v0',
    session: { sessionId: 's1', capturedAt: '2026-07-06T00:00:00.000Z' },
    task: { summary: over.summary ?? 'Fix duplicate rows', distributionTags: ['coding'] },
    environment: { harness: { name: 'jinn-execution-ledger-bridge', version: '0.1.0' }, model: 'm', tools: [] },
    steps: [
      {
        spanId: 'patch',
        parentSpanId: null,
        name: 'tool:apply_patch',
        startTimeUnixNano: '1751452882000000000',
        endTimeUnixNano: '1751452882000000000',
        attributes: { patch: over.patch ?? 'diff --git a/models.py b/models.py\n+ qs = qs.distinct()' },
        redactedKeys: [],
      },
    ],
    outcome: {
      status: over.status ?? 'completed',
      verifiabilityTier: over.tier ?? 'evaluator-verified',
      ...(over.outcomeSummary !== undefined ? { summary: over.outcomeSummary } : {}),
    },
    cost: { durationMs: 0 },
    consent: { contributionConsent: true, scrubCompleted: true },
    provenance: over.provenance ?? 'contributed',
  });
}

describe('evaluateEligibility (tiered — pattern / lesson, §6/D10)', () => {
  it('completed + evaluator-verified + contributed + clean → pattern', () => {
    const r = evaluateEligibility(env({ status: 'completed' }));
    expect(r.eligible).toBe(true);
    expect(r.tier).toBe('pattern');
  });

  it('failed + evaluator-verified → lesson', () => {
    const r = evaluateEligibility(env({ status: 'failed' }));
    expect(r.eligible).toBe(true);
    expect(r.tier).toBe('lesson');
  });

  it('completed + user-accepted → ineligible (not evaluator-verified)', () => {
    const r = evaluateEligibility(env({ status: 'completed', tier: 'user-accepted' }));
    expect(r.eligible).toBe(false);
    expect(r.tier).toBeNull();
    expect(r.reasons.join(' ')).toMatch(/evaluator-verified/);
  });

  it('abandoned → ineligible', () => {
    expect(evaluateEligibility(env({ status: 'abandoned', tier: 'evaluator-verified' })).eligible).toBe(false);
  });

  it('imported → ineligible (seeds are already layer-2)', () => {
    const r = evaluateEligibility(env({ provenance: 'imported' }));
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/contributed|imported/);
  });

  it('held-out → ineligible', () => {
    const r = evaluateEligibility(env(), { heldOut: true });
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/held-out/);
  });
});

describe('redaction-health guard (§6 — intra-value depth, all placeholder shapes)', () => {
  it('flags a long value shredded into placeholder tokens (#1409 defacement)', () => {
    const defaced = '[AIRPORT_2765] [AUTH_5211] '.repeat(20); // long, ~all placeholder
    const r = evaluateEligibility(env({ patch: defaced }));
    expect(r.redactionHealth.defaced).toBe(true);
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/defaced/);
  });

  it('does NOT flag a long patch with a single genuine secret redaction', () => {
    const patch = 'diff --git a/config.py b/config.py\n' + 'x'.repeat(600) + '\nKEY=[SECRET:high-entropy]\n';
    const r = evaluateEligibility(env({ patch }));
    expect(r.redactionHealth.defaced).toBe(false);
    expect(r.eligible).toBe(true);
  });

  it('does NOT flag a short fully-redacted value (legit single-secret redaction)', () => {
    const rh = redactionHealth(env({ patch: '[SECRET:high-entropy]' }));
    expect(rh.defaced).toBe(false);
  });

  it('detects the union of placeholder shapes (SECRET / PII / EMAIL / openredaction)', () => {
    for (const token of ['[SECRET:x]', '[PII:name]', '[EMAIL]', '[AIRPORT_2765]']) {
      const long = `${token} `.repeat(30);
      expect(redactionHealth(env({ patch: long })).defaced).toBe(true);
    }
  });

  it('flags a defaced task.summary — the field the distiller reads first (not just step attributes)', () => {
    // long, ~all placeholder, ≤500; trimmed — the envelope's TrimmedString
    // rejects surrounding whitespace, and the fixture must be a VALID envelope
    // so the failure it exercises is the density guard, not schema parse.
    const defacedSummary = '[AIRPORT_2765] [AUTH_5211] '.repeat(10).slice(0, 480).trim();
    const r = evaluateEligibility(env({ patch: 'diff --git a/x b/x\n+ ok', summary: defacedSummary }));
    expect(r.redactionHealth.defaced).toBe(true);
    expect(r.eligible).toBe(false);
  });

  it('flags a defaced outcome.summary (lesson free-text is also scrubbed prose)', () => {
    const defaced = '[SECRET:x] [PII:y] '.repeat(15).slice(0, 480).trim();
    const r = evaluateEligibility(env({ status: 'failed', outcomeSummary: defaced }));
    expect(r.redactionHealth.defaced).toBe(true);
    expect(r.eligible).toBe(false);
  });

  it('a clean summary + clean patch stays eligible (no false positive from the added surfaces)', () => {
    const r = evaluateEligibility(env({ summary: 'Deduplicate queryset rows after the join before returning', outcomeSummary: 'evaluator-confirmed pass' }));
    expect(r.redactionHealth.defaced).toBe(false);
    expect(r.eligible).toBe(true);
  });

  it('density strictly above the threshold is defaced; at-or-below is not (boundary + custom override)', () => {
    // A value that is 50% placeholder chars by construction.
    const token = '[SECRET:x]'; // 10 chars
    const filler = 'y'.repeat(token.length); // equal-length non-placeholder run
    const half = (token + filler).repeat(6); // length 120 ≥ MIN_CONTENT_LEN, density = 0.5
    expect(redactionHealth(env({ patch: half })).maxValueDensity).toBeCloseTo(0.5, 5);
    // Default 0.4: 0.5 > 0.4 → defaced.
    expect(redactionHealth(env({ patch: half })).defaced).toBe(true);
    // Override the threshold to exactly 0.5: strict `>` means 0.5 is NOT defaced.
    expect(evaluateEligibility(env({ patch: half }), { maxPlaceholderDensity: 0.5 }).redactionHealth.defaced).toBe(false);
    // Override to 0.6: comfortably clean.
    expect(evaluateEligibility(env({ patch: half }), { maxPlaceholderDensity: 0.6 }).eligible).toBe(true);
  });
});
