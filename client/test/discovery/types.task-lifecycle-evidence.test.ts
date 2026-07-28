import { describe, expect, it } from 'vitest';
import type {
  DiscoveryAPI,
  TaskLifecycleEvidence,
  AuthoritativeAttemptRow,
  AttemptEnvelopeCandidate,
  VerdictEnvelopeCandidate,
} from '../../src/discovery/types.js';

describe('TaskLifecycleEvidence shape (#2044)', () => {
  it('keeps authoritative spine and candidate bags as distinct namespaces', () => {
    const attemptCandidates: AttemptEnvelopeCandidate[] = [{
      requestId: `0x${'11'.repeat(32)}`,
      chainId: 84532,
      manifestCid: 'bafyAttempt',
      publisherAgentId: '1',
      manifestHash: `0x${'22'.repeat(32)}`,
      enrichedAtBlock: 100,
      solverType: 'prediction.v0',
    }];
    const verdictCandidates: VerdictEnvelopeCandidate[] = [{
      requestId: `0x${'33'.repeat(32)}`,
      chainId: 84532,
      manifestCid: 'bafyVerdict',
      publisherAgentId: '2',
      manifestHash: `0x${'44'.repeat(32)}`,
      enrichedAtBlock: 101,
      actualPassed: true,
      projectedTaskId: '999', // hint only — must never be required on authoritative
      projectedAttemptIndex: 99,
    }];
    const attempt: AuthoritativeAttemptRow = {
      taskId: '42',
      chainId: 84532,
      attemptIndex: 0,
      requestId: `0x${'11'.repeat(32)}`,
      operator: `0x${'aa'.repeat(20)}`,
      priorityMech: `0x${'bb'.repeat(20)}`,
      deliveryRate: '1000',
      createdAtBlock: 50,
      verdicts: [{
        taskId: '42',
        chainId: 84532,
        attemptIndex: 0,
        verdictIndex: 0,
        requestId: `0x${'33'.repeat(32)}`,
        evaluator: `0x${'cc'.repeat(20)}`,
        verdictCode: 1,
        createdAtBlock: 60,
        verdictEnvelopeCandidates: verdictCandidates,
      }],
      attemptEnvelopeCandidates: attemptCandidates,
    };
    const row: TaskLifecycleEvidence = {
      taskId: '42',
      authoritative: {
        task: {
          taskId: '42',
          chainId: 84532,
          manifestDigest: `0x${'55'.repeat(32)}`,
          taskCidDigest: `0x${'66'.repeat(32)}`,
          creator: `0x${'dd'.repeat(20)}`,
          maxClaims: 3,
          requiredVerdicts: 1,
          createdAtBlock: 40,
          createdAtTx: `0x${'77'.repeat(32)}`,
          finalized: false,
          refunded: false,
        },
        attempts: [attempt],
      },
    };
    expect(row.authoritative.attempts[0]!.attemptIndex).toBe(0);
    expect(row.authoritative.attempts[0]!.verdicts[0]!.verdictCode).toBe(1);
    expect(row.authoritative.attempts[0]!.attemptEnvelopeCandidates[0]!.manifestCid)
      .toBe('bafyAttempt');
  });

  it('DiscoveryAPI declares getTaskLifecycleEvidence', () => {
    const has = (api: DiscoveryAPI): boolean =>
      typeof api.getTaskLifecycleEvidence === 'function';
    expect(has).toBeTypeOf('function');
  });
});
