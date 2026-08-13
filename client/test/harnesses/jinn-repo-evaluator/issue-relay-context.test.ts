import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  IssueRelayEvaluationContextV1Schema,
  type IssueRelayEvaluationContextV1,
  type JinnRepoLiveIssueTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import {
  admitIssueRelayEvaluationOpportunity,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/issue-relay-context.js';

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

function fixtures() {
  const snapshotDigest = `sha256:${'a'.repeat(64)}` as const;
  const baseOid = '1'.repeat(40);
  const evaluatedHead = '2'.repeat(40);
  const solutionSafe = `0x${'1'.repeat(40)}`;
  const evaluatorSafe = `0x${'2'.repeat(40)}`;
  const patch = 'diff --git a/foo.ts b/foo.ts\n';
  const round = {
    schemaVersion: 'jinn-issue-relay-round.v1' as const,
    generation: `R_kgDOExample:42:${snapshotDigest}`,
    round: 0,
    snapshotDigest,
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: baseOid,
    purpose: 'initial' as const,
    findings: [],
  };
  const correlation = {
    generation: round.generation,
    round: round.round,
    snapshotDigest,
    taskId: '501',
    attemptIndex: 0,
    requestId: `0x${'3'.repeat(64)}`,
    deliveryEnvelopeCid: 'bafy-solution',
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
    patchDigest:
      `sha256:${createHash('sha256').update(patch).digest('hex')}` as const,
    solutionSafe,
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
  const task: JinnRepoLiveIssueTask = {
    schemaVersion: 'jinn-repo.v1',
    source: 'live-issue',
    instance_id: `issue-relay:${round.generation}:round:0`,
    repo: round.targetRepository,
    base_commit: baseOid,
    language: 'typescript',
    problem_statement: 'Frozen goal.',
    issue_number: 42,
    relay: round,
  };
  const context = IssueRelayEvaluationContextV1Schema.parse({
    schemaVersion: 'jinn-issue-relay-evaluation-context.v1',
    goal: {
      snapshotDigest,
      problemStatement: task.problem_statement,
      acceptanceEvidence: ['The complete exact head passes.'],
      verificationProfile: 'jinn-mono.v1',
    },
    operators: { solutionSafe, evaluatorSafe },
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
      optional: [],
    },
  }) as IssueRelayEvaluationContextV1;
  return {
    task: task as JinnRepoLiveIssueTask & { relay: typeof round },
    solution: { schemaVersion: 'jinn-repo-solution.v1' as const, patch },
    context,
    correlation,
    solutionSafe,
    evaluatorSafe,
  };
}

describe('admitIssueRelayEvaluationOpportunity', () => {
  it('accepts only the strict context that exactly binds the source delivery', () => {
    const value = fixtures();

    expect(admitIssueRelayEvaluationOpportunity({
      task: value.task,
      solution: value.solution,
      taskId: value.correlation.taskId,
      attemptIndex: value.correlation.attemptIndex,
      requestId: value.correlation.requestId,
      solutionEnvelopeCid: value.correlation.deliveryEnvelopeCid,
      solutionOperatorSafe: value.solutionSafe,
      evaluatorOperatorSafe: value.evaluatorSafe,
      observation: { state: 'accepted', context: value.context },
    })).toEqual({ kind: 'accepted', context: value.context });
  });

  it.each([
    ['missing observation', undefined],
    ['pending observation', { state: 'pending' as const, detail: 'host adoption pending' }],
    ['rejected observation', { state: 'rejected' as const, detail: 'unsafe patch' }],
    ['contradictory observation', { state: 'contradictory' as const, detail: 'conflict' }],
  ])('keeps a Relay evaluation pending for %s', (_label, observation) => {
    const value = fixtures();

    expect(admitIssueRelayEvaluationOpportunity({
      task: value.task,
      solution: value.solution,
      taskId: value.correlation.taskId,
      attemptIndex: value.correlation.attemptIndex,
      requestId: value.correlation.requestId,
      solutionEnvelopeCid: value.correlation.deliveryEnvelopeCid,
      solutionOperatorSafe: value.solutionSafe,
      evaluatorOperatorSafe: value.evaluatorSafe,
      observation,
    })).toMatchObject({ kind: 'pending' });
  });

  it('rejects stale context correlation and self-evaluation', () => {
    const value = fixtures();
    const common = {
      task: value.task,
      solution: value.solution,
      taskId: value.correlation.taskId,
      attemptIndex: value.correlation.attemptIndex,
      requestId: value.correlation.requestId,
      solutionEnvelopeCid: value.correlation.deliveryEnvelopeCid,
      solutionOperatorSafe: value.solutionSafe,
      evaluatorOperatorSafe: value.evaluatorSafe,
      observation: { state: 'accepted' as const, context: value.context },
    };

    expect(admitIssueRelayEvaluationOpportunity({
      ...common,
      requestId: 'wrong-request',
    })).toMatchObject({
      kind: 'pending',
      reason: expect.stringMatching(/correlation/i),
    });
    expect(admitIssueRelayEvaluationOpportunity({
      ...common,
      evaluatorOperatorSafe: value.solutionSafe.toUpperCase().replace('0X', '0x'),
    })).toMatchObject({
      kind: 'pending',
      reason: expect.stringMatching(/self-evaluation/i),
    });
  });
});
