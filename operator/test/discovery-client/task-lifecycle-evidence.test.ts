/**
 * Pure-assembler tests for task lifecycle evidence (#2044).
 *
 * The invariant under test: the authoritative spine is built ONLY from
 * task/attempt/verdict rows. Envelope candidates attach last, joined by
 * (requestId, chainId), and can never create or rewrite a spine row.
 */
import { describe, expect, it } from 'vitest';
import { assembleTaskLifecycleEvidence } from '../../src/discovery-client/task-lifecycle-evidence.js';

const hex32 = (n: string) => `0x${n.repeat(32)}` as `0x${string}`;
const addr = (n: string) => `0x${n.repeat(20)}` as `0x${string}`;

describe('assembleTaskLifecycleEvidence (#2044)', () => {
  it('nests and sorts multiple attempts and verdicts losslessly (AC2)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [{
        taskId: '7', chainId: 84532, manifestDigest: hex32('11'),
        taskCidDigest: hex32('22'), creator: addr('aa'), maxClaims: 2,
        requiredVerdicts: 1, createdAtBlock: 10, finalized: false, refunded: false,
      }],
      attempts: [
        { taskId: '7', chainId: 84532, attemptIndex: 1, requestId: hex32('b1'),
          operator: addr('b1'), priorityMech: addr('c1'), deliveryRate: '2', createdAtBlock: 21 },
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: 20 },
      ],
      verdicts: [
        { taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: 1,
          requestId: hex32('d1'), evaluator: addr('e1'), verdictCode: 2, createdAtBlock: 31 },
        { taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: 0,
          requestId: hex32('d0'), evaluator: addr('e0'), verdictCode: 1, createdAtBlock: 30 },
        { taskId: '7', chainId: 84532, attemptIndex: 1, verdictIndex: 0,
          requestId: hex32('d2'), evaluator: addr('e2'), verdictCode: 1, createdAtBlock: 32 },
      ],
    });
    const ev = map.get('7')!;
    expect(ev.authoritative.attempts.map((a) => a.attemptIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[0]!.verdicts.map((v) => v.verdictIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[1]!.verdicts.map((v) => v.verdictIndex)).toEqual([0]);
    // The SOLVE request and the EVAL request are distinct identities, both kept.
    expect(ev.authoritative.attempts[0]!.requestId).toBe(hex32('b0'));
    expect(ev.authoritative.attempts[0]!.verdicts[0]!.requestId).toBe(hex32('d0'));
    expect(ev.authoritative.attempts[0]!.verdicts[1]!.verdictCode).toBe(2);
  });

  it('drops a verdict whose (taskId, attemptIndex, chainId) has no attempt row (AC2)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [{
        taskId: '7', chainId: 84532, manifestDigest: hex32('11'),
        taskCidDigest: hex32('22'), creator: addr('aa'), maxClaims: 1,
        requiredVerdicts: 1, createdAtBlock: 10, finalized: false, refunded: false,
      }],
      attempts: [{
        taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
        operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: 20,
      }],
      verdicts: [{
        taskId: '7', chainId: 84532, attemptIndex: 9, verdictIndex: 0,
        requestId: hex32('d9'), evaluator: addr('e9'), verdictCode: 1, createdAtBlock: 30,
      }],
    });
    expect(map.get('7')!.authoritative.attempts[0]!.verdicts).toEqual([]);
  });

  it('attaches candidates by requestId+chainId without rewriting spine fields (AC3)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [{
        taskId: '7', chainId: 84532, manifestDigest: hex32('11'),
        taskCidDigest: hex32('22'), creator: addr('aa'), maxClaims: 1,
        requiredVerdicts: 1, createdAtBlock: 10, finalized: false, refunded: false,
      }],
      attempts: [{
        taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
        operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: 20,
      }],
      verdicts: [{
        taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: 0,
        requestId: hex32('d0'), evaluator: addr('e0'), verdictCode: 1, createdAtBlock: 30,
      }],
      attemptCandidates: [{
        requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafyA',
        publisherAgentId: '1', manifestHash: hex32('99'), enrichedAtBlock: 25,
      }],
      verdictCandidates: [{
        requestId: hex32('d0'), chainId: 84532, manifestCid: 'bafyV',
        publisherAgentId: '2', manifestHash: hex32('88'), enrichedAtBlock: 35,
        projectedTaskId: '999', projectedAttemptIndex: 99, projectedVerdictIndex: 99,
        projectedEvaluator: addr('ff'), solutionRequestId: 'hint-only',
      }],
    });
    const attempt = map.get('7')!.authoritative.attempts[0]!;
    // Spine identity survives a contradictory candidate verbatim.
    expect(attempt.taskId).toBe('7');
    expect(attempt.attemptIndex).toBe(0);
    expect(attempt.operator).toBe(addr('b0'));
    expect(attempt.attemptEnvelopeCandidates).toHaveLength(1);
    const verdict = attempt.verdicts[0]!;
    expect(verdict.taskId).toBe('7');
    expect(verdict.attemptIndex).toBe(0);
    expect(verdict.verdictIndex).toBe(0);
    expect(verdict.evaluator).toBe(addr('e0'));
    // The contradictory values are readable, but only under projected* names.
    expect(verdict.verdictEnvelopeCandidates[0]!.projectedTaskId).toBe('999');
    expect(verdict.verdictEnvelopeCandidates[0]!.projectedEvaluator).toBe(addr('ff'));
  });

  it('does not attach a candidate whose chainId differs from the spine row (AC3)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [{
        taskId: '7', chainId: 84532, manifestDigest: hex32('11'),
        taskCidDigest: hex32('22'), creator: addr('aa'), maxClaims: 1,
        requiredVerdicts: 1, createdAtBlock: 10, finalized: false, refunded: false,
      }],
      attempts: [{
        taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
        operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: 20,
      }],
      verdicts: [],
      attemptCandidates: [{
        requestId: hex32('b0'), chainId: 8453, manifestCid: 'bafyOtherChain',
        publisherAgentId: '1', manifestHash: hex32('99'), enrichedAtBlock: 25,
      }],
    });
    expect(map.get('7')!.authoritative.attempts[0]!.attemptEnvelopeCandidates).toEqual([]);
  });

  it('never invents a spine row from candidates alone (AC3)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [],
      attempts: [],
      verdicts: [],
      attemptCandidates: [
        { requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafy1',
          publisherAgentId: '1', manifestHash: hex32('01'), enrichedAtBlock: 1 },
        { requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafy2',
          publisherAgentId: '2', manifestHash: hex32('02'), enrichedAtBlock: 2 },
      ],
      verdictCandidates: [
        { requestId: hex32('d0'), chainId: 84532, manifestCid: 'bafyV',
          publisherAgentId: '3', manifestHash: hex32('03'), enrichedAtBlock: 3,
          projectedTaskId: '7', projectedAttemptIndex: 0, projectedVerdictIndex: 0 },
      ],
    });
    expect(map.size).toBe(0);
  });

  it('retains every candidate publisher for one request (AC1)', () => {
    const map = assembleTaskLifecycleEvidence({
      tasks: [{
        taskId: '7', chainId: 84532, manifestDigest: hex32('11'),
        taskCidDigest: hex32('22'), creator: addr('aa'), maxClaims: 1,
        requiredVerdicts: 1, createdAtBlock: 10, finalized: false, refunded: false,
      }],
      attempts: [{
        taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
        operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1', createdAtBlock: 20,
      }],
      verdicts: [],
      attemptCandidates: [
        { requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafy1',
          publisherAgentId: '1', manifestHash: hex32('01'), enrichedAtBlock: 1 },
        { requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafy2',
          publisherAgentId: '2', manifestHash: hex32('02'), enrichedAtBlock: 2 },
      ],
    });
    expect(map.get('7')!.authoritative.attempts[0]!.attemptEnvelopeCandidates
      .map((c) => c.publisherAgentId)).toEqual(['1', '2']);
  });
});
