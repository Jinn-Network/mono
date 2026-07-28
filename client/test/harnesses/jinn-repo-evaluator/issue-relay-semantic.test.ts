import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  IssueRelayEvaluationContextV1Schema,
  type IssueRelayEvaluationContextV1,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import {
  runIssueRelaySemanticReview,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/issue-relay-semantic.js';

function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(
        (value as Record<string, unknown>)[key],
      )}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function context(): IssueRelayEvaluationContextV1 {
  const snapshotDigest = `sha256:${'a'.repeat(64)}` as const;
  const baseOid = '1'.repeat(40);
  const evaluatedHead = '2'.repeat(40);
  const correlation = {
    generation: `R_kgDOExample:42:${snapshotDigest}`,
    round: 0,
    snapshotDigest,
    taskId: '501',
    attemptIndex: 0,
    requestId: `0x${'3'.repeat(64)}`,
    deliveryEnvelopeCid: 'bafy-solution',
  };
  const round = {
    schemaVersion: 'jinn-issue-relay-round.v1' as const,
    generation: correlation.generation,
    round: 0,
    snapshotDigest,
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: baseOid,
    purpose: 'initial' as const,
    findings: [],
  };
  const receipt = {
    schemaVersion: 'jinn-issue-relay-adoption.v1' as const,
    disposition: 'accepted' as const,
    correlation,
    targetRepository: round.targetRepository,
    workspaceRepository: 'Jinn-Network/mono-relay',
    issueNumber: 42,
    prNumber: 314,
    headRef: 'jinn/issue-relay/example',
    inputHead: baseOid,
    resultingHead: evaluatedHead,
    patchDigest: `sha256:${'c'.repeat(64)}` as const,
    solutionSafe: `0x${'1'.repeat(40)}`,
    adoptedAt: '2026-07-28T12:10:00.000Z',
  };
  const checksDigest = `sha256:${'b'.repeat(64)}` as const;
  const anchor = {
    schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1' as const,
    correlation,
    targetRepository: receipt.targetRepository,
    workspaceRepository: receipt.workspaceRepository,
    prNumber: receipt.prNumber,
    targetBase: 'main',
    baseOid,
    headRef: receipt.headRef,
    evaluatedHead,
    adoptionReceiptDigest:
      `sha256:${createHash('sha256').update(canonicalJson(receipt)).digest('hex')}` as const,
    checksDigest,
    anchoredAt: '2026-07-28T12:12:00.000Z',
  };
  return IssueRelayEvaluationContextV1Schema.parse({
    schemaVersion: 'jinn-issue-relay-evaluation-context.v1',
    goal: {
      snapshotDigest,
      problemStatement: 'Fix the exact frozen issue.',
      acceptanceEvidence: ['The exact cumulative change passes.'],
      verificationProfile: 'jinn-mono.v1',
    },
    operators: {
      solutionSafe: receipt.solutionSafe,
      evaluatorSafe: `0x${'2'.repeat(40)}`,
    },
    round,
    correlation,
    reviewTarget: {
      targetRepository: receipt.targetRepository,
      workspaceRepository: receipt.workspaceRepository,
      issueNumber: receipt.issueNumber,
      prNumber: receipt.prNumber,
      targetBase: anchor.targetBase,
      baseOid,
      headRef: receipt.headRef,
      evaluatedHead,
    },
    adoptionReceipt: receipt,
    evaluationAnchor: anchor,
    checks: {
      digest: checksDigest,
      required: [{ name: 'relay/typecheck', status: 'passed' }],
      optional: [{ name: 'upstream/ci', status: 'passed' }],
    },
  }) as IssueRelayEvaluationContextV1;
}

describe('runIssueRelaySemanticReview', () => {
  it('clones the public managed fork and reviews the complete base-to-head diff', async () => {
    const value = context();
    const completeDiff = 'diff --git a/a.ts b/a.ts\n+complete cumulative change\n';
    const git = vi.fn(async (input: { readonly args: readonly string[] }) => {
      if (input.args.includes('rev-parse')) return `${value.reviewTarget.evaluatedHead}\n`;
      if (input.args.includes('diff')) return completeDiff;
      return '';
    });
    const runMechanical = vi.fn().mockResolvedValue({
      passed: true,
      summary: 'jinn-mono.v1 mechanical checks passed',
      findings: [],
    });
    const runSemantic = vi.fn().mockResolvedValue({
      outcome: 'pass',
      summary: 'The frozen goal is satisfied at the exact head.',
      findings: [],
    });

    await expect(runIssueRelaySemanticReview({
      context: value,
      runMechanical,
      runSemantic,
      git,
    })).resolves.toEqual({
      schemaVersion: 'jinn-issue-relay-verdict.v1',
      outcome: 'pass',
      correlation: value.correlation,
      evaluatedHead: value.reviewTarget.evaluatedHead,
      summary: 'The frozen goal is satisfied at the exact head.',
      findings: [],
    });

    const clone = git.mock.calls.find(([input]) => input.args.includes('clone'))![0];
    expect(clone.args).toContain(
      `https://github.com/${value.reviewTarget.workspaceRepository}.git`,
    );
    expect(clone.args).not.toContain(
      `https://github.com/${value.round.workspaceRepository}.git`,
    );
    expect(git.mock.calls.some(([input]) =>
      input.args.includes(`${value.reviewTarget.baseOid}..${value.reviewTarget.evaluatedHead}`)))
      .toBe(true);
    expect(runMechanical).toHaveBeenCalledWith({
      checkoutPath: expect.any(String),
      verificationProfile: 'jinn-mono.v1',
    });
    expect(runSemantic).toHaveBeenCalledWith({
      problemStatement: value.goal.problemStatement,
      acceptanceEvidence: value.goal.acceptanceEvidence,
      completeDiff,
      mechanicalSummary: 'jinn-mono.v1 mechanical checks passed',
      repositoryChecks: value.checks,
    });
  });

  it('returns bounded request-changes findings without invoking semantic review after mechanical failure', async () => {
    const value = context();
    const finding = {
      code: 'typecheck',
      title: 'Typecheck failed',
      detail: 'The exact adopted head fails client typecheck.',
      path: 'client/src/a.ts',
    };
    const runSemantic = vi.fn();

    await expect(runIssueRelaySemanticReview({
      context: value,
      git: async ({ args }) =>
        args.includes('rev-parse') ? `${value.reviewTarget.evaluatedHead}\n` : '',
      runMechanical: async () => ({
        passed: false,
        summary: 'Typecheck failed.',
        findings: [finding],
      }),
      runSemantic,
    })).resolves.toMatchObject({
      outcome: 'request-changes',
      correlation: value.correlation,
      evaluatedHead: value.reviewTarget.evaluatedHead,
      findings: [finding],
    });
    expect(runSemantic).not.toHaveBeenCalled();
  });

  it('fails unresolved before either runner when checkout HEAD differs from the anchor', async () => {
    const value = context();
    const runMechanical = vi.fn();
    const runSemantic = vi.fn();

    await expect(runIssueRelaySemanticReview({
      context: value,
      git: async ({ args }) => args.includes('rev-parse') ? `${'9'.repeat(40)}\n` : '',
      runMechanical,
      runSemantic,
    })).resolves.toMatchObject({
      outcome: 'unresolved',
      correlation: value.correlation,
      evaluatedHead: value.reviewTarget.evaluatedHead,
      findings: [],
      summary: expect.stringMatching(/head/i),
    });
    expect(runMechanical).not.toHaveBeenCalled();
    expect(runSemantic).not.toHaveBeenCalled();
  });

  it('binds request-change output to authoritative context instead of runner-supplied identity', async () => {
    const value = context();
    const finding = {
      code: 'semantic-regression',
      title: 'Behavior regressed',
      detail: 'The cumulative diff violates the frozen acceptance evidence.',
    };

    await expect(runIssueRelaySemanticReview({
      context: value,
      git: async ({ args }) =>
        args.includes('rev-parse') ? `${value.reviewTarget.evaluatedHead}\n` : '',
      runMechanical: async () => ({
        passed: true,
        summary: 'Mechanical checks passed.',
        findings: [],
      }),
      runSemantic: async () => ({
        outcome: 'request-changes',
        summary: 'The change needs repair.',
        findings: [finding],
      }),
    })).resolves.toEqual({
      schemaVersion: 'jinn-issue-relay-verdict.v1',
      outcome: 'request-changes',
      correlation: value.correlation,
      evaluatedHead: value.reviewTarget.evaluatedHead,
      summary: 'The change needs repair.',
      findings: [finding],
    });
  });

  it('truncates oversized UTF-8 summaries without corrupting an otherwise valid verdict', async () => {
    const value = context();
    const oversizedSummary = `${'a'.repeat(8_188)}😀b`;

    const result = await runIssueRelaySemanticReview({
      context: value,
      git: async ({ args }) =>
        args.includes('rev-parse') ? `${value.reviewTarget.evaluatedHead}\n` : '',
      runMechanical: async () => ({
        passed: true,
        summary: 'Mechanical checks passed.',
        findings: [],
      }),
      runSemantic: async () => ({
        outcome: 'pass',
        summary: oversizedSummary,
        findings: [],
      }),
    });

    expect(result.outcome).toBe('pass');
    expect(new TextEncoder().encode(result.summary).byteLength).toBeLessThanOrEqual(8_192);
    expect(result.summary.endsWith('...')).toBe(true);
  });
});
