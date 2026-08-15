import { describe, expect, it } from 'vitest';
import {
  AutopilotEvaluationContextSchema,
  type AutopilotEvaluationContext,
  type AutopilotMutationResult,
  type JinnRepoAutopilotSessionTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import {
  admitAutopilotEvaluationOpportunity,
  type AutopilotEvaluationContextObservation,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/autopilot-evaluation-context.js';

const V2_ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174001';
const REVIEW_GENERATION = '123e4567-e89b-42d3-a456-426614174010';

function task(): JinnRepoAutopilotSessionTask {
  return {
    schemaVersion: 'jinn-repo.v1',
    source: 'autopilot-session',
    instance_id: 'autopilot:501:0',
    repo: 'Jinn-Network/mono',
    base_commit: '3'.repeat(40),
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    problem_statement: 'Implement the exact session.',
    session: {
      schemaVersion: 'jinn-autopilot-session.v1',
      workflow: 'implement',
      repository: 'Jinn-Network/mono',
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      issueNumber: 2001,
      prNumber: 2101,
      targetBase: 'next',
      branch: 'codex/issue-2001',
      claimOid: '1'.repeat(40),
      expectedHead: '2'.repeat(40),
      v2AttemptId: V2_ATTEMPT_ID,
      runnerId: 'runner-1',
      taskSnapshot: {
        title: 'Implement the exact session',
        body: 'Body.',
        prBody: 'PR body.',
        baseSha: '3'.repeat(40),
        targetBaseOid: '3'.repeat(40),
      },
      workflowContract: {
        skill: 'implement-issue',
        version: 'v2',
        resultSchema: 'jinn-autopilot-mutation-result.v1',
      },
      deadline: '2026-07-25T00:00:00.000Z',
      receiptAuthors: ['trusted-host'],
    },
  };
}

function solution(): AutopilotMutationResult {
  return {
    schemaVersion: 'jinn-autopilot-mutation-result.v1',
    outcome: 'mutation-complete',
    correlation: {
      taskId: '501',
      attemptIndex: 0,
      requestId: '0xsolution',
      deliveryEnvelopeCid: 'bafy-solution',
      v2AttemptId: V2_ATTEMPT_ID,
      claimOid: '1'.repeat(40),
      prNumber: 2101,
      expectedHead: '2'.repeat(40),
    },
    patch: 'diff --git a/client/src/a.ts b/client/src/a.ts\n',
    summary: 'Implemented the exact session.',
    evidence: {
      commands: ['yarn typecheck'],
      tests: ['yarn test'],
    },
  };
}

function evaluationContext(): AutopilotEvaluationContext {
  const source = solution();
  return AutopilotEvaluationContextSchema.parse({
    schemaVersion: 'jinn-autopilot-evaluation-context.v1',
    operators: {
      solutionSafe: `0x${'a'.repeat(40)}`,
      evaluatorSafe: `0x${'b'.repeat(40)}`,
    },
    reviewTarget: {
      repository: 'Jinn-Network/mono',
      issueNumber: 2001,
      prNumber: 2101,
      targetBase: 'next',
      baseOid: '3'.repeat(40),
      headRef: 'codex/issue-2001',
      resultingHead: '4'.repeat(40),
      reviewGeneration: REVIEW_GENERATION,
      reviewRefOid: '5'.repeat(40),
    },
    session: task().session,
    correlation: {
      ...source.correlation,
      resultingHead: '4'.repeat(40),
      reviewedHead: '4'.repeat(40),
      reviewGeneration: REVIEW_GENERATION,
      reviewRefOid: '5'.repeat(40),
    },
    solution: {
      summary: source.outcome === 'mutation-complete' ? source.summary : '',
      evidence: source.outcome === 'mutation-complete'
        ? source.evidence
        : { commands: [], tests: [] },
      adoptionReceipt: {
        schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
        disposition: 'accepted',
        role: 'solution',
        operation: 'implementation-complete',
        taskId: '501',
        attemptIndex: 0,
        requestId: '0xsolution',
        deliveryEnvelopeCid: 'bafy-solution',
        v2AttemptId: V2_ATTEMPT_ID,
        prNumber: 2101,
        claimOid: '1'.repeat(40),
        expectedHead: '2'.repeat(40),
        resultingHead: '4'.repeat(40),
        reviewGeneration: REVIEW_GENERATION,
        reviewRefOid: '5'.repeat(40),
        recordedAt: '2026-07-24T22:00:00.000Z',
      },
    },
  });
}

function observation(
  context: AutopilotEvaluationContext = evaluationContext(),
): AutopilotEvaluationContextObservation {
  return { state: 'accepted', context };
}

function admit(
  currentObservation: AutopilotEvaluationContextObservation | undefined,
) {
  return admitAutopilotEvaluationOpportunity({
    task: task(),
    solution: solution(),
    taskId: '501',
    attemptIndex: 0,
    requestId: '0xsolution',
    solutionEnvelopeCid: 'bafy-solution',
    solutionOperatorSafe: `0x${'a'.repeat(40)}`,
    evaluatorOperatorSafe: `0x${'b'.repeat(40)}`,
    observation: currentObservation,
  });
}

describe('admitAutopilotEvaluationOpportunity', () => {
  it('accepts only the exact full-head context after an accepted Solution receipt', () => {
    expect(admit(observation())).toEqual({
      kind: 'accepted',
      context: evaluationContext(),
    });
  });

  it.each([
    ['missing', undefined],
    ['pending', { state: 'pending', detail: 'not published' }],
    ['rejected', { state: 'rejected', detail: 'stale result' }],
    ['contradictory', { state: 'contradictory', detail: 'two receipts' }],
  ] as const)('keeps %s receipt/context pending and emits no gradeable opportunity', (_name, value) => {
    expect(admit(value)).toMatchObject({ kind: 'pending' });
  });

  it('rejects canonical Safe self-evaluation before semantic execution', () => {
    const value = evaluationContext();
    const result = admitAutopilotEvaluationOpportunity({
      task: task(),
      solution: solution(),
      taskId: '501',
      attemptIndex: 0,
      requestId: '0xsolution',
      solutionEnvelopeCid: 'bafy-solution',
      solutionOperatorSafe: `0x${'a'.repeat(40)}`,
      evaluatorOperatorSafe: `0x${'a'.repeat(40)}`,
      observation: observation({
        ...value,
        operators: {
          solutionSafe: `0x${'a'.repeat(40)}`,
          evaluatorSafe: `0x${'a'.repeat(40)}`,
        },
      } as AutopilotEvaluationContext),
    });
    expect(result).toMatchObject({
      kind: 'pending',
      reason: expect.stringContaining('self-evaluation'),
    });
  });

  it.each([
    ['resulting head', { reviewTarget: { resultingHead: '9'.repeat(40) } }],
    ['review generation', { reviewTarget: { reviewGeneration: '123e4567-e89b-42d3-a456-426614174099' } }],
    ['review ref', { reviewTarget: { reviewRefOid: '8'.repeat(40) } }],
    ['request', { correlation: { requestId: '0xother' } }],
    ['envelope', { correlation: { deliveryEnvelopeCid: 'bafy-other' } }],
  ])('keeps stale/mismatched %s context pending', (_name, mutation) => {
    const value = evaluationContext() as unknown as Record<string, unknown>;
    const [section, patch] = Object.entries(mutation)[0]!;
    const mutated = {
      ...value,
      [section]: {
        ...(value[section] as Record<string, unknown>),
        ...patch,
      },
    };
    const result = admit({
      state: 'accepted',
      context: mutated,
    });
    expect(result).toMatchObject({ kind: 'pending' });
  });

  it('rejects a context whose summary/evidence differs from the adopted Solution envelope', () => {
    const value = evaluationContext();
    const result = admit({
      state: 'accepted',
      context: {
        ...value,
        solution: {
          ...value.solution,
          summary: 'Different summary.',
        },
      },
    });
    expect(result).toMatchObject({
      kind: 'pending',
      reason: expect.stringContaining('summary/evidence'),
    });
  });
});
