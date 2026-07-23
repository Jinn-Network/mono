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

function withoutKey(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
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

  it('binds each mutation workflow to its canonical skill and result schema', () => {
    const cases = [
      ['implement', 'fix-child'],
      ['fix-child', 'reconcile'],
      ['reconcile', 'implement-issue'],
      ['ci-failure', 'implement-issue'],
    ] as const;

    for (const [workflow, wrongSkill] of cases) {
      const value = fixture(`session-${workflow}`) as Record<string, unknown>;
      const workflowContract = value.workflowContract as Record<string, unknown>;

      expect(() => AutopilotSessionCapsuleSchema.parse({
        ...value,
        workflowContract: { ...workflowContract, skill: wrongSkill },
      })).toThrow();
      expect(() => AutopilotSessionCapsuleSchema.parse({
        ...value,
        workflowContract: {
          ...workflowContract,
          resultSchema: 'jinn-autopilot-review-result.v1',
        },
      })).toThrow();
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

  it('requires the complete review target correlation for every review outcome', () => {
    for (const outcome of ['approve', 'request-changes', 'human']) {
      const value = fixture(`review-${outcome}`) as Record<string, unknown>;
      const correlation = value.correlation as Record<string, unknown>;
      for (const key of ['reviewedHead', 'reviewGeneration', 'reviewRefOid']) {
        expect(() => AutopilotReviewResultSchema.parse({
          ...value,
          correlation: withoutKey(correlation, key),
        })).toThrow();
      }
    }
  });
});

describe('AutopilotCorrelationSchema', () => {
  it('rejects a mismatch in every required member of the correlation tuple', () => {
    const pair = fixture('correlation-mismatch') as {
      expected: unknown;
      actual: unknown;
    };
    const expected = AutopilotCorrelationSchema.parse(pair.expected);
    expect(autopilotCorrelationMatches(expected, expected)).toBe(true);

    const mutations = {
      taskId: '502',
      attemptIndex: 1,
      requestId: '0xother-request',
      deliveryEnvelopeCid: 'bafy-other-envelope',
      v2AttemptId: '123e4567-e89b-42d3-a456-426614174099',
      claimOid: '9'.repeat(40),
      prNumber: 2102,
      expectedHead: '8'.repeat(40),
    } satisfies Record<string, unknown>;

    for (const [key, value] of Object.entries(mutations)) {
      const actual = AutopilotCorrelationSchema.parse({ ...expected, [key]: value });
      expect(autopilotCorrelationMatches(expected, actual), key).toBe(false);
    }
  });

  it('treats every optional missing-vs-present correlation field as a mismatch', () => {
    const base = AutopilotCorrelationSchema.parse(
      (fixture('correlation-mismatch') as { expected: unknown }).expected,
    );
    const optionalValues = {
      resultingHead: '4'.repeat(40),
      reviewedHead: '5'.repeat(40),
      reviewGeneration: '123e4567-e89b-42d3-a456-426614174010',
      reviewRefOid: '6'.repeat(40),
    } satisfies Record<string, unknown>;

    for (const [key, value] of Object.entries(optionalValues)) {
      const present = AutopilotCorrelationSchema.parse({ ...base, [key]: value });
      expect(autopilotCorrelationMatches(base, present), `${key}: missing/present`)
        .toBe(false);
      expect(autopilotCorrelationMatches(present, base), `${key}: present/missing`)
        .toBe(false);
    }
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

  it('requires exact-head review correlation on accepted and rejected Verdict receipts', () => {
    for (const disposition of ['accepted', 'rejected']) {
      const value = fixture(`receipt-verdict-${disposition}`) as Record<string, unknown>;
      for (const key of ['reviewedHead', 'reviewGeneration', 'reviewRefOid']) {
        expect(() => AutopilotAdoptionReceiptSchema.parse(withoutKey(value, key)))
          .toThrow();
      }
    }
  });

  it('requires resulting-head review-claim correlation on accepted Solution receipts', () => {
    const value = fixture('receipt-solution-accepted') as Record<string, unknown>;
    for (const key of ['resultingHead', 'reviewGeneration', 'reviewRefOid']) {
      expect(() => AutopilotAdoptionReceiptSchema.parse(withoutKey(value, key)))
        .toThrow();
    }
  });

  it('rejects role-inapplicable known correlation fields in every receipt branch', () => {
    const cases = [
      ['receipt-solution-accepted', { reviewedHead: '7'.repeat(40) }],
      ['receipt-solution-rejected', { reviewedHead: '7'.repeat(40) }],
      ['receipt-verdict-accepted', { resultingHead: '7'.repeat(40) }],
      ['receipt-verdict-rejected', { resultingHead: '7'.repeat(40) }],
    ] as const;

    for (const [name, patch] of cases) {
      const value = fixture(name) as Record<string, unknown>;
      expect(() => AutopilotAdoptionReceiptSchema.parse({ ...value, ...patch }))
        .toThrow();
    }
  });
});
