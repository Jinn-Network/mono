import { describe, expect, it, vi } from 'vitest';
import {
  AutopilotEvaluationContextSchema,
  type AutopilotEvaluationContext,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import {
  runAutopilotSemanticReview,
  type AutopilotMechanicalRunner,
  type SemanticAgentRunner,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/autopilot-semantic.js';

const REVIEW_GENERATION = '123e4567-e89b-42d3-a456-426614174010';
const V2_ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174001';

function context(): AutopilotEvaluationContext {
  return AutopilotEvaluationContextSchema.parse({
    schemaVersion: 'jinn-autopilot-evaluation-context.v1',
    operators: {
      solutionSafe: `0x${'a'.repeat(40)}`,
      evaluatorSafe: `0x${'b'.repeat(40)}`,
    },
    reviewTarget: {
      repository: 'Jinn-Network/mono',
      issueNumber: 2001,
      childIssueNumber: 2002,
      prNumber: 2101,
      targetBase: 'next',
      baseOid: '3'.repeat(40),
      headRef: 'codex/issue-2001',
      resultingHead: '4'.repeat(40),
      reviewGeneration: REVIEW_GENERATION,
      reviewRefOid: '5'.repeat(40),
    },
    session: {
      schemaVersion: 'jinn-autopilot-session.v1',
      workflow: 'fix-child',
      repository: 'Jinn-Network/mono',
      issueNumber: 2001,
      childIssueNumber: 2002,
      parentPrNumber: 2101,
      prNumber: 2101,
      targetBase: 'next',
      branch: 'codex/issue-2001',
      claimOid: '1'.repeat(40),
      expectedHead: '2'.repeat(40),
      v2AttemptId: V2_ATTEMPT_ID,
      runnerId: 'runner-1',
      taskSnapshot: {
        title: 'Fix the evaluator',
        body: 'Review the full cumulative pull request.',
        prBody: 'Implements the issue and its review child.',
        baseSha: '3'.repeat(40),
      },
      workflowContract: {
        skill: 'fix-child',
        version: 'v2',
        resultSchema: 'jinn-autopilot-mutation-result.v1',
      },
      deadline: '2026-07-25T00:00:00.000Z',
      receiptAuthors: ['trusted-host'],
    },
    correlation: {
      taskId: '501',
      attemptIndex: 0,
      requestId: '0xsolution-request',
      deliveryEnvelopeCid: 'bafy-solution-envelope',
      v2AttemptId: V2_ATTEMPT_ID,
      claimOid: '1'.repeat(40),
      prNumber: 2101,
      expectedHead: '2'.repeat(40),
      resultingHead: '4'.repeat(40),
      reviewedHead: '4'.repeat(40),
      reviewGeneration: REVIEW_GENERATION,
      reviewRefOid: '5'.repeat(40),
    },
    solution: {
      summary: 'Implemented the child fix on the existing parent branch.',
      evidence: {
        commands: ['yarn typecheck'],
        tests: ['yarn vitest run focused.test.ts'],
        notes: ['Full cumulative head was published.'],
      },
      adoptionReceipt: {
        schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
        disposition: 'accepted',
        role: 'solution',
        operation: 'child-complete',
        taskId: '501',
        attemptIndex: 0,
        requestId: '0xsolution-request',
        deliveryEnvelopeCid: 'bafy-solution-envelope',
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

function correlation() {
  return context().correlation;
}

function mechanical(
  result: Awaited<ReturnType<AutopilotMechanicalRunner['run']>> = {
    kind: 'passed',
    checkoutDir: '/tmp/exact-head',
    changedFiles: ['client/src/a.ts', 'client/test/a.test.ts'],
    checks: ['head', 'policy', 'typecheck', 'tests'],
    cleanup: vi.fn().mockResolvedValue(undefined),
  },
): AutopilotMechanicalRunner & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn().mockResolvedValue(result) };
}

function agent(output: unknown): SemanticAgentRunner & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn().mockResolvedValue(
      typeof output === 'string' ? output : JSON.stringify(output),
    ),
  };
}

describe('runAutopilotSemanticReview', () => {
  it('reviews the complete exact head through the injected runtime and review-pr contract', async () => {
    const mechanicalRunner = mechanical();
    const agentRunner = agent({
      schemaVersion: 'jinn-autopilot-review-result.v1',
      outcome: 'approve',
      correlation: correlation(),
      body: 'The full exact head satisfies the issue.',
      followUps: [{
        type: 'refactor',
        title: 'Tidy a name',
        body: 'Non-blocking naming cleanup.',
        effort: 'low',
        priority: 'p3',
      }],
    });

    const result = await runAutopilotSemanticReview({
      context: context(),
      mechanicalRunner,
      agentRunner,
      abort: new AbortController().signal,
    });

    expect(result.review).toMatchObject({
      outcome: 'approve',
      correlation: correlation(),
      followUps: [{
        type: 'refactor',
        effort: 'low',
        priority: 'p3',
      }],
    });
    expect(result.gating).toEqual({
      passed: true,
      verdict: 'PASS',
      verdictCode: 1,
    });
    expect(mechanicalRunner.run).toHaveBeenCalledWith(
      context(),
      expect.any(AbortSignal),
    );
    expect(agentRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/exact-head',
      abort: expect.any(AbortSignal),
    }));
    expect(agentRunner.run.mock.calls[0]![0]).not.toHaveProperty('model');
    const prompt = agentRunner.run.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('review-pr');
    expect(prompt).toContain('complete effective PR diff');
    expect(prompt).toContain('4444444444444444444444444444444444444444');
    expect(prompt).toContain('"reviewGeneration": "123e4567-e89b-42d3-a456-426614174010"');
    expect(prompt).toContain('"adoptionReceipt"');
    expect(prompt).toContain('Return only strict jinn-autopilot-review-result.v1 JSON');
    expect(prompt).toContain('"type": "feat | chore | fix | refactor"');
    expect(prompt).toContain('"effort": "low | medium | high | xhigh | max"');
    expect(prompt).toContain('"priority": "p0 | p1 | p2 | p3 | p4"');
  });

  it.each([
    [
      'request-changes',
      {
        schemaVersion: 'jinn-autopilot-review-result.v1',
        outcome: 'request-changes',
        correlation: correlation(),
        findings: [{
          title: 'Incorrect exact-head behavior',
          body: 'The implementation violates the requested invariant.',
          path: 'client/src/a.ts',
          line: 12,
        }],
      },
      { passed: false, verdict: 'FAIL', verdictCode: 2 },
    ],
    [
      'human',
      {
        schemaVersion: 'jinn-autopilot-review-result.v1',
        outcome: 'human',
        correlation: correlation(),
        reason: {
          code: 'codeowner-surface',
          detail: 'A human code owner must decide this change.',
        },
      },
      { passed: false, verdict: 'UNRESOLVED', verdictCode: 4 },
    ],
  ])('maps strict %s output without collapsing Human into FAIL', async (_name, output, gating) => {
    const result = await runAutopilotSemanticReview({
      context: context(),
      mechanicalRunner: mechanical(),
      agentRunner: agent(output),
      abort: new AbortController().signal,
    });
    expect(result.review).toMatchObject(output);
    expect(result.gating).toEqual(gating);
  });

  it('turns a deterministic check failure into request-changes without executing the agent', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const mechanicalRunner = mechanical({
      kind: 'failed',
      checkoutDir: '/tmp/exact-head',
      changedFiles: ['client/src/a.ts'],
      check: 'typecheck',
      detail: 'client typecheck failed',
      cleanup,
    });
    const agentRunner = agent('{}');

    const result = await runAutopilotSemanticReview({
      context: context(),
      mechanicalRunner,
      agentRunner,
      abort: new AbortController().signal,
    });

    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(result.review).toMatchObject({
      outcome: 'request-changes',
      findings: [{
        title: 'Deterministic typecheck check failed',
        body: 'client typecheck failed',
      }],
    });
    expect(result.gating.verdict).toBe('FAIL');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('turns unscorable mechanical infrastructure into Human/Unresolved without executing the agent', async () => {
    const agentRunner = agent('{}');
    const result = await runAutopilotSemanticReview({
      context: context(),
      mechanicalRunner: mechanical({
        kind: 'unscorable',
        detail: 'git clone timed out',
      }),
      agentRunner,
      abort: new AbortController().signal,
    });
    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(result.review).toMatchObject({
      outcome: 'human',
      reason: {
        code: 'mechanical-check-unscorable',
        detail: 'git clone timed out',
      },
    });
    expect(result.gating).toEqual({
      passed: false,
      verdict: 'UNRESOLVED',
      verdictCode: 4,
    });
  });

  it('turns a thrown mechanical runner failure into Human/Unresolved', async () => {
    const agentRunner = agent('{}');
    const result = await runAutopilotSemanticReview({
      context: context(),
      mechanicalRunner: {
        run: vi.fn().mockRejectedValue(new Error('temporary checkout failure')),
      },
      agentRunner,
      abort: new AbortController().signal,
    });
    expect(agentRunner.run).not.toHaveBeenCalled();
    expect(result.review).toMatchObject({
      outcome: 'human',
      reason: {
        code: 'mechanical-runner-failed',
        detail: 'temporary checkout failure',
      },
    });
    expect(result.gating.verdict).toBe('UNRESOLVED');
  });

  it('does not let checkout cleanup failure replace a typed semantic verdict', async () => {
    const result = await runAutopilotSemanticReview({
      context: context(),
      mechanicalRunner: mechanical({
        kind: 'passed',
        checkoutDir: '/tmp/exact-head',
        changedFiles: ['client/src/a.ts'],
        checks: ['exact-head', 'typecheck', 'tests'],
        cleanup: vi.fn().mockRejectedValue(new Error('temporary cleanup failure')),
      }),
      agentRunner: agent({
        schemaVersion: 'jinn-autopilot-review-result.v1',
        outcome: 'approve',
        correlation: correlation(),
        body: 'The exact-head review passed.',
      }),
      abort: new AbortController().signal,
    });
    expect(result.review).toMatchObject({ outcome: 'approve' });
    expect(result.gating.verdict).toBe('PASS');
  });

  it.each([
    ['malformed JSON', 'not json', 'semantic-output-invalid'],
    [
      'incomplete native follow-up metadata',
      {
        schemaVersion: 'jinn-autopilot-review-result.v1',
        outcome: 'approve',
        correlation: correlation(),
        body: 'Approval with an incomplete follow-up.',
        followUps: [{
          type: 'refactor',
          title: 'Missing priority',
          body: 'This must not pass strict publication validation.',
          effort: 'low',
        }],
      },
      'semantic-output-invalid',
    ],
    [
      'stale result correlation',
      {
        schemaVersion: 'jinn-autopilot-review-result.v1',
        outcome: 'approve',
        correlation: { ...correlation(), reviewedHead: '9'.repeat(40) },
        body: 'Stale approval.',
      },
      'semantic-correlation-mismatch',
    ],
  ])('maps %s to Human/Unresolved, never PASS or FAIL', async (_name, output, reasonCode) => {
    const result = await runAutopilotSemanticReview({
      context: context(),
      mechanicalRunner: mechanical(),
      agentRunner: agent(output),
      abort: new AbortController().signal,
    });
    expect(result.review).toMatchObject({
      outcome: 'human',
      correlation: correlation(),
      reason: { code: reasonCode },
    });
    expect(result.gating.verdict).toBe('UNRESOLVED');
    expect(result.gating.verdictCode).toBe(4);
  });
});
