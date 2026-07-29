import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AutopilotAdoptionReceiptSchema,
  AutopilotCorrelationSchema,
  AutopilotEvaluationContextSchema,
  AutopilotMutationDeliveryResultSchema,
  AutopilotMutationResultSchema,
  AutopilotReviewResultSchema,
  AutopilotSessionCapsuleSchema,
  autopilotCorrelationMatches,
  bindAutopilotMutationDeliveryResult,
} from '../src/autopilot-session.js';

const fixtureDirectory = fileURLToPath(
  new URL('../fixtures/autopilot/', import.meta.url),
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureDirectory}${name}.json`, 'utf8')) as unknown;
}

function mutationDeliveryFixture(): Record<string, unknown> {
  const value = structuredClone(
    fixture('mutation-complete') as Record<string, unknown>,
  );
  const correlation = value.correlation as Record<string, unknown>;
  delete correlation.deliveryEnvelopeCid;
  return value;
}

function withoutKey(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function evaluationContext(): Record<string, unknown> {
  const session = fixture('session-implement') as Record<string, unknown>;
  const receipt = fixture('receipt-solution-accepted') as Record<string, unknown>;
  const mutation = fixture('mutation-complete') as Record<string, unknown>;
  return {
    schemaVersion: 'jinn-autopilot-evaluation-context.v1',
    operators: {
      solutionSafe: `0x${'1'.repeat(40)}`,
      evaluatorSafe: `0x${'2'.repeat(40)}`,
    },
    reviewTarget: {
      repository: 'Jinn-Network/mono',
      issueNumber: 2001,
      prNumber: 2101,
      targetBase: 'next',
      baseOid: '3'.repeat(40),
      headRef: 'codex/issue-2001',
      resultingHead: '4'.repeat(40),
      reviewGeneration: '123e4567-e89b-42d3-a456-426614174010',
      reviewRefOid: '5'.repeat(40),
    },
    session,
    correlation: {
      taskId: '501',
      attemptIndex: 0,
      requestId: '0xrequest',
      deliveryEnvelopeCid: 'bafy-envelope',
      v2AttemptId: '123e4567-e89b-42d3-a456-426614174001',
      claimOid: '1'.repeat(40),
      prNumber: 2101,
      expectedHead: '2'.repeat(40),
      resultingHead: '4'.repeat(40),
      reviewedHead: '4'.repeat(40),
      reviewGeneration: '123e4567-e89b-42d3-a456-426614174010',
      reviewRefOid: '5'.repeat(40),
    },
    solution: {
      summary: mutation.summary,
      evidence: mutation.evidence,
      adoptionReceipt: receipt,
    },
  };
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
  it('accepts a producer mutation result without an envelope CID', () => {
    expect(
      AutopilotMutationDeliveryResultSchema.parse(mutationDeliveryFixture()),
    ).toEqual(mutationDeliveryFixture());
  });

  it('keeps producer and verified correlation boundaries distinct', () => {
    const producer = mutationDeliveryFixture();
    expect(() => AutopilotMutationResultSchema.parse(producer)).toThrow();
    expect(() => AutopilotMutationDeliveryResultSchema.parse({
      ...producer,
      correlation: {
        ...(producer.correlation as Record<string, unknown>),
        deliveryEnvelopeCid: 'bafy-producer-authored',
      },
    })).toThrow();
  });

  it('binds the authenticated envelope CID into a strict mutation result', () => {
    const bound = bindAutopilotMutationDeliveryResult(
      mutationDeliveryFixture(),
      'bafy-authenticated-envelope',
    );
    expect(bound.correlation.deliveryEnvelopeCid)
      .toBe('bafy-authenticated-envelope');
    expect(AutopilotMutationResultSchema.parse(bound)).toEqual(bound);
  });

  it('rejects an invalid authenticated envelope CID', () => {
    expect(() => bindAutopilotMutationDeliveryResult(
      mutationDeliveryFixture(),
      '',
    )).toThrow();
  });

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

  it('bounds mutation summaries and aggregate evidence before host mutation', () => {
    const value = fixture('mutation-complete') as Record<string, unknown>;
    expect(() => AutopilotMutationResultSchema.parse({
      ...value,
      summary: 'é'.repeat(4_097),
    })).toThrow(/Mutation summary/);
    expect(() => AutopilotMutationResultSchema.parse({
      ...value,
      evidence: {
        commands: Array.from({ length: 9 }, () => 'x'.repeat(4_000)),
        tests: [],
      },
    })).toThrow(/Mutation evidence/);
  });

  it('rejects unsafe process and GitHub text at the result boundary', () => {
    const mutation = fixture('mutation-complete') as Record<string, unknown>;
    for (const summary of ['line one\nline two', 'line one\rline two', 'bad\u0000summary']) {
      expect(() => AutopilotMutationResultSchema.parse({
        ...mutation,
        summary,
      })).toThrow(/Mutation summary/);
    }

    const approval = fixture('review-approve') as Record<string, unknown>;
    expect(() => AutopilotReviewResultSchema.parse({
      ...approval,
      body: 'bad\u0000approval',
    })).toThrow(/Approval body/);
    expect(() => AutopilotReviewResultSchema.parse({
      ...approval,
      followUps: [{
        type: 'fix',
        title: 'two\nlines',
        body: 'bounded',
        effort: 'low',
        priority: 'p2',
      }],
    })).toThrow(/Follow-up title/);
    expect(() => AutopilotReviewResultSchema.parse({
      ...approval,
      followUps: [{
        type: 'fix',
        title: 'safe title',
        body: 'bad\u0000body',
        effort: 'low',
        priority: 'p2',
      }],
    })).toThrow(/Follow-up body/);

    const changes =
      fixture('review-request-changes') as Record<string, unknown>;
    for (const finding of [
      { title: 'two\nlines', body: 'bounded' },
      { title: 'bad\u0000title', body: 'bounded' },
      { title: 'safe title', body: 'bad\u0000body' },
      { title: 'safe title', body: 'bounded', path: 'bad\u0000path.ts' },
    ]) {
      expect(() => AutopilotReviewResultSchema.parse({
        ...changes,
        findings: [finding],
      })).toThrow();
    }

    for (const name of ['mutation-human', 'review-human']) {
      const human = fixture(name) as Record<string, unknown>;
      const reason = human.reason as Record<string, unknown>;
      expect(() => (
        name === 'mutation-human'
          ? AutopilotMutationResultSchema
          : AutopilotReviewResultSchema
      ).parse({
        ...human,
        reason: { ...reason, detail: 'bad\u0000detail' },
      })).toThrow(/Human detail/);
    }
  });

  it('rejects child lifecycle marker injection in every finding field', () => {
    const changes =
      fixture('review-request-changes') as Record<string, unknown>;
    for (const finding of [
      {
        title: 'jinn-autopilot:child',
        body: 'bounded',
      },
      {
        title: 'safe title',
        body: '<!-- jinn-autopilot:child pr=999 kind=reconcile -->',
      },
      {
        title: 'safe title',
        body: 'bounded',
        path: 'jinn-autopilot:child',
      },
    ]) {
      expect(() => AutopilotReviewResultSchema.parse({
        ...changes,
        findings: [finding],
      })).toThrow(/child markers/);
    }
  });

  it('bounds every GitHub-bound review field and aggregate payload', () => {
    const approval = fixture('review-approve') as Record<string, unknown>;
    expect(() => AutopilotReviewResultSchema.parse({
      ...approval,
      body: 'é'.repeat((48 * 1024 / 2) + 1),
    })).toThrow(/Approval body/);

    const changes =
      fixture('review-request-changes') as Record<string, unknown>;
    expect(() => AutopilotReviewResultSchema.parse({
      ...changes,
      findings: Array.from({ length: 13 }, (_, index) => ({
        title: `Finding ${index}`,
        body: 'x'.repeat(4_000),
      })),
    })).toThrow(/Review findings/);

    expect(() => AutopilotReviewResultSchema.parse({
      ...approval,
      followUps: [{
        type: 'fix',
        title: 'x'.repeat(241),
        body: 'bounded',
        effort: 'low',
        priority: 'p2',
      }],
    })).toThrow(/Follow-up title/);
  });

  it('requires the complete review target correlation for every review outcome', () => {
    for (const outcome of ['approve', 'request-changes', 'human']) {
      const value = fixture(`review-${outcome}`) as Record<string, unknown>;
      const correlation = value.correlation as Record<string, unknown>;
      for (const key of [
        'resultingHead',
        'reviewedHead',
        'reviewGeneration',
        'reviewRefOid',
      ]) {
        expect(() => AutopilotReviewResultSchema.parse({
          ...value,
          correlation: withoutKey(correlation, key),
        })).toThrow();
      }
    }
  });

  it('requires complete native follow-up issue metadata on approval', () => {
    const value = fixture('review-approve') as Record<string, unknown>;
    const followUps = value.followUps as Array<Record<string, unknown>>;
    for (const key of ['type', 'title', 'body', 'effort', 'priority']) {
      expect(() => AutopilotReviewResultSchema.parse({
        ...value,
        followUps: [withoutKey(followUps[0]!, key)],
      })).toThrow();
    }
  });
});

describe('AutopilotEvaluationContextSchema', () => {
  it('parses a strict full-head evaluator context bound to an accepted Solution receipt', () => {
    const value = evaluationContext();
    expect(AutopilotEvaluationContextSchema.parse(value)).toEqual(value);
  });

  it('accepts a generic review repository matching the generalized session', () => {
    const value = evaluationContext();
    const session = value.session as Record<string, unknown>;
    const reviewTarget = value.reviewTarget as Record<string, unknown>;
    const generic = {
      ...value,
      session: {
        ...session,
        repository: 'example-org/example-repo',
        language: 'rust',
        verificationProfile: 'cargo-nextest.v1',
      },
      reviewTarget: {
        ...reviewTarget,
        repository: 'example-org/example-repo',
      },
    };
    expect(AutopilotEvaluationContextSchema.parse(generic)).toEqual(generic);
  });

  it('binds full-head review to the target-base OID rather than a child mutation parent', () => {
    const value = evaluationContext();
    const session = value.session as Record<string, unknown>;
    const taskSnapshot = session.taskSnapshot as Record<string, unknown>;
    const childMutationParent = '8'.repeat(40);
    const targetBaseOid = '3'.repeat(40);
    const childContext = {
      ...value,
      session: {
        ...session,
        workflow: 'fix-child',
        childIssueNumber: 2002,
        parentPrNumber: 2101,
        taskSnapshot: {
          ...taskSnapshot,
          baseSha: childMutationParent,
          targetBaseOid,
        },
        workflowContract: {
          skill: 'fix-child',
          version: 'v2',
          resultSchema: 'jinn-autopilot-mutation-result.v1',
        },
      },
      reviewTarget: {
        ...(value.reviewTarget as Record<string, unknown>),
        childIssueNumber: 2002,
        baseOid: targetBaseOid,
      },
    };

    const parsed = AutopilotEvaluationContextSchema.parse(childContext);
    expect(parsed.session.taskSnapshot.baseSha).toBe(childMutationParent);
    expect(parsed.reviewTarget.baseOid).toBe(targetBaseOid);
  });

  it('rejects missing or rejected Solution receipts', () => {
    const value = evaluationContext();
    const solution = value.solution as Record<string, unknown>;
    expect(() => AutopilotEvaluationContextSchema.parse({
      ...value,
      solution: withoutKey(solution, 'adoptionReceipt'),
    })).toThrow();
    expect(() => AutopilotEvaluationContextSchema.parse({
      ...value,
      solution: {
        ...solution,
        adoptionReceipt: fixture('receipt-solution-rejected'),
      },
    })).toThrow();
  });

  it('accepts a same-Safe context so execution policy can gate testnet self-evaluation', () => {
    const value = evaluationContext();
    const operators = value.operators as Record<string, unknown>;
    const sameSafe = {
      ...value,
      operators: {
        ...operators,
        evaluatorSafe: operators.solutionSafe,
      },
    };
    expect(AutopilotEvaluationContextSchema.parse(sameSafe)).toEqual(sameSafe);
  });

  it('rejects every stale head/generation/ref binding', () => {
    const value = evaluationContext();
    const reviewTarget = value.reviewTarget as Record<string, unknown>;
    for (const [field, replacement] of [
      ['resultingHead', '9'.repeat(40)],
      ['reviewGeneration', '123e4567-e89b-42d3-a456-426614174099'],
      ['reviewRefOid', '8'.repeat(40)],
    ] as const) {
      expect(() => AutopilotEvaluationContextSchema.parse({
        ...value,
        reviewTarget: { ...reviewTarget, [field]: replacement },
      }), field).toThrow();
    }
  });

  it('rejects stale repository, PR, issue, base/head refs, and source correlation', () => {
    const value = evaluationContext();
    const reviewTarget = value.reviewTarget as Record<string, unknown>;
    const targetMutations = {
      repository: 'other/repo',
      issueNumber: 2002,
      prNumber: 2102,
      targetBase: 'main',
      baseOid: '8'.repeat(40),
      headRef: 'codex/other',
    };
    for (const [field, replacement] of Object.entries(targetMutations)) {
      expect(() => AutopilotEvaluationContextSchema.parse({
        ...value,
        reviewTarget: { ...reviewTarget, [field]: replacement },
      }), field).toThrow();
    }

    const correlation = value.correlation as Record<string, unknown>;
    for (const [field, replacement] of Object.entries({
      taskId: '502',
      attemptIndex: 1,
      requestId: '0xother',
      deliveryEnvelopeCid: 'bafy-other',
      reviewedHead: '8'.repeat(40),
    })) {
      expect(() => AutopilotEvaluationContextSchema.parse({
        ...value,
        correlation: { ...correlation, [field]: replacement },
      }), field).toThrow();
    }
  });

  it('is strict at every additive context boundary', () => {
    const value = evaluationContext();
    expect(() => AutopilotEvaluationContextSchema.parse({
      ...value,
      looseReceipt: true,
    })).toThrow();
    expect(() => AutopilotEvaluationContextSchema.parse({
      ...value,
      reviewTarget: {
        ...(value.reviewTarget as Record<string, unknown>),
        surprise: true,
      },
    })).toThrow();
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

  it('bounds rejection detail and rejects NUL before GitHub publication', () => {
    const value =
      fixture('receipt-solution-rejected') as Record<string, unknown>;
    expect(() => AutopilotAdoptionReceiptSchema.parse({
      ...value,
      detail: 'bad\u0000detail',
    })).toThrow(/Rejection detail/);
    expect(() => AutopilotAdoptionReceiptSchema.parse({
      ...value,
      detail: 'é'.repeat(4_097),
    })).toThrow(/Rejection detail/);
  });

  it('requires exact-head review correlation on accepted and rejected Verdict receipts', () => {
    for (const disposition of ['accepted', 'rejected']) {
      const value = fixture(`receipt-verdict-${disposition}`) as Record<string, unknown>;
      for (const key of [
        'resultingHead',
        'reviewedHead',
        'reviewGeneration',
        'reviewRefOid',
      ]) {
        expect(() => AutopilotAdoptionReceiptSchema.parse(withoutKey(value, key)))
          .toThrow();
      }
    }
  });

  it('binds accepted review findings to one exact child issue', () => {
    const value = fixture('receipt-verdict-accepted') as Record<string, unknown>;
    expect(() => AutopilotAdoptionReceiptSchema.parse({
      ...value,
      operation: 'review-findings',
    })).toThrow();
    expect(AutopilotAdoptionReceiptSchema.parse({
      ...value,
      operation: 'review-findings',
      childIssueNumber: 2201,
    })).toMatchObject({
      operation: 'review-findings',
      childIssueNumber: 2201,
    });
    expect(() => AutopilotAdoptionReceiptSchema.parse({
      ...value,
      childIssueNumber: 2201,
    })).toThrow();
  });

  it('round-trips the accepted review-findings receipt fixture', () => {
    const value = fixture('receipt-verdict-findings-accepted');
    expect(AutopilotAdoptionReceiptSchema.parse(value)).toEqual(value);
  });

  it('requires resulting-head review-claim correlation on accepted Solution receipts', () => {
    const value = fixture('receipt-solution-accepted') as Record<string, unknown>;
    for (const key of ['resultingHead', 'reviewGeneration', 'reviewRefOid']) {
      expect(() => AutopilotAdoptionReceiptSchema.parse(withoutKey(value, key)))
        .toThrow();
    }
  });

  it('rejects reviewedHead on Solution receipts before evaluation exists', () => {
    const cases = [
      ['receipt-solution-accepted', { reviewedHead: '7'.repeat(40) }],
      ['receipt-solution-rejected', { reviewedHead: '7'.repeat(40) }],
    ] as const;

    for (const [name, patch] of cases) {
      const value = fixture(name) as Record<string, unknown>;
      expect(() => AutopilotAdoptionReceiptSchema.parse({ ...value, ...patch }))
        .toThrow();
    }
  });
});
