import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AutopilotAdoptionReceiptSchema,
  AutopilotCorrelationSchema,
  AutopilotMutationResultSchema,
  AutopilotReviewResultSchema,
  AutopilotSessionCapsuleSchema,
  autopilotCorrelationMatches,
} from '../src/autopilot-session.js';

const fixtureDirectory = fileURLToPath(
  new URL('./fixtures/autopilot-session/', import.meta.url),
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureDirectory}${name}.json`, 'utf8')) as unknown;
}

describe('AutopilotSessionCapsuleSchema', () => {
  for (const workflow of ['implement', 'fix-child', 'reconcile', 'ci-failure']) {
    it(`parses the ${workflow} workflow fixture`, () => {
      expect(AutopilotSessionCapsuleSchema.parse(fixture(`session-${workflow}`)))
        .toEqual(fixture(`session-${workflow}`));
    });
  }

  it('rejects unknown fields at the capsule and nested object boundaries', () => {
    const value = fixture('session-implement') as Record<string, unknown>;
    expect(() => AutopilotSessionCapsuleSchema.parse({ ...value, surprise: true }))
      .toThrow();

    const taskSnapshot = value.taskSnapshot as Record<string, unknown>;
    expect(() => AutopilotSessionCapsuleSchema.parse({
      ...value,
      taskSnapshot: { ...taskSnapshot, surprise: true },
    })).toThrow();
  });

  it('rejects malformed authority identifiers, timestamps, and issue numbers', () => {
    const value = fixture('session-implement') as Record<string, unknown>;
    for (const patch of [
      { claimOid: 'A'.repeat(40) },
      { expectedHead: 'abc' },
      { v2AttemptId: 'attempt-1' },
      { deadline: 'tomorrow' },
      { issueNumber: 0 },
      { prNumber: -1 },
    ]) {
      expect(() => AutopilotSessionCapsuleSchema.parse({ ...value, ...patch }))
        .toThrow();
    }
  });
});

describe('Autopilot result schemas', () => {
  for (const outcome of ['complete', 'human']) {
    it(`parses the mutation ${outcome} fixture`, () => {
      expect(AutopilotMutationResultSchema.parse(fixture(`mutation-${outcome}`)))
        .toEqual(fixture(`mutation-${outcome}`));
    });
  }

  for (const outcome of ['approve', 'request-changes', 'human']) {
    it(`parses the review ${outcome} fixture`, () => {
      expect(AutopilotReviewResultSchema.parse(fixture(`review-${outcome}`)))
        .toEqual(fixture(`review-${outcome}`));
    });
  }

  it('rejects unknown fields inside result branches and nested evidence', () => {
    const value = fixture('mutation-complete') as Record<string, unknown>;
    expect(() => AutopilotMutationResultSchema.parse({ ...value, surprise: true }))
      .toThrow();

    const evidence = value.evidence as Record<string, unknown>;
    expect(() => AutopilotMutationResultSchema.parse({
      ...value,
      evidence: { ...evidence, surprise: true },
    })).toThrow();
  });

  it('enforces the 2 MiB patch limit by UTF-8 bytes, not code points', () => {
    const value = fixture('mutation-complete') as Record<string, unknown>;
    expect(() => AutopilotMutationResultSchema.parse({
      ...value,
      patch: 'é'.repeat(1_048_577),
    })).toThrow();
  });
});

describe('AutopilotCorrelationSchema', () => {
  it('rejects a mismatch in any member of the complete correlation tuple', () => {
    const pair = fixture('correlation-mismatch') as {
      expected: unknown;
      actual: unknown;
    };
    const expected = AutopilotCorrelationSchema.parse(pair.expected);
    const actual = AutopilotCorrelationSchema.parse(pair.actual);

    expect(autopilotCorrelationMatches(expected, expected)).toBe(true);
    expect(autopilotCorrelationMatches(expected, actual)).toBe(false);
  });

  it('is strict', () => {
    const value = (fixture('correlation-mismatch') as { expected: object }).expected;
    expect(() => AutopilotCorrelationSchema.parse({ ...value, surprise: true }))
      .toThrow();
  });

  it('rejects negative attempt indexes and non-printable chain identifiers', () => {
    const value = (fixture('correlation-mismatch') as { expected: object }).expected;
    expect(() => AutopilotCorrelationSchema.parse({
      ...value,
      attemptIndex: -1,
    })).toThrow();
    expect(() => AutopilotCorrelationSchema.parse({
      ...value,
      deliveryEnvelopeCid: 'bafy\ninjected',
    })).toThrow();
  });
});

describe('AutopilotAdoptionReceiptSchema', () => {
  for (const role of ['solution', 'verdict']) {
    for (const disposition of ['accepted', 'rejected']) {
      it(`parses the ${disposition} ${role} receipt fixture`, () => {
        const value = fixture(`receipt-${role}-${disposition}`);
        expect(AutopilotAdoptionReceiptSchema.parse(value)).toEqual(value);
      });
    }
  }

  it('accepts every stable rejection reason and rejects unknown reasons', () => {
    const value = fixture('receipt-solution-rejected') as Record<string, unknown>;
    const reasons = [
      'correlation-mismatch',
      'untrusted-operator',
      'stale-claim',
      'stale-head',
      'stale-review-generation',
      'invalid-artifact',
      'patch-does-not-apply',
      'verification-failed',
      'policy-human',
      'receipt-contradiction',
      'internal-adoption-failure',
    ];
    for (const reason of reasons) {
      expect(AutopilotAdoptionReceiptSchema.parse({ ...value, reason }).reason)
        .toBe(reason);
    }
    expect(() => AutopilotAdoptionReceiptSchema.parse({
      ...value,
      reason: 'try-again-later',
    })).toThrow();
  });

  it('rejects unknown fields', () => {
    const value = fixture('receipt-verdict-accepted') as Record<string, unknown>;
    expect(() => AutopilotAdoptionReceiptSchema.parse({ ...value, surprise: true }))
      .toThrow();
  });

  it('rejects malformed receipt timestamps and review identifiers', () => {
    const value = fixture('receipt-verdict-accepted') as Record<string, unknown>;
    expect(() => AutopilotAdoptionReceiptSchema.parse({
      ...value,
      recordedAt: 'not-a-timestamp',
    })).toThrow();
    expect(() => AutopilotAdoptionReceiptSchema.parse({
      ...value,
      reviewGeneration: 'generation-1',
    })).toThrow();
  });
});
