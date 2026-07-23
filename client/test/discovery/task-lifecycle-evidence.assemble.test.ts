import { describe, expect, it } from 'vitest';
import {
  assembleTaskLifecycleEvidence,
  mergeTaskLifecycleEvidence,
} from '../../src/discovery/task-lifecycle-evidence.js';
import type { TaskLifecycleEvidence } from '../../src/discovery/types.js';

const hex32 = (n: string) => `0x${n.repeat(32)}` as `0x${string}`;
const addr = (n: string) => `0x${n.repeat(20)}` as `0x${string}`;

describe('assembleTaskLifecycleEvidence (#2044 AC2/AC3)', () => {
  it('nests and sorts multiple attempts and verdicts losslessly', () => {
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
      ],
    });
    const ev = map.get('7')!;
    expect(ev.authoritative.attempts.map((a) => a.attemptIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[0]!.verdicts.map((v) => v.verdictIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[0]!.requestId).toBe(hex32('b0')); // SOLVE
    expect(ev.authoritative.attempts[0]!.verdicts[0]!.requestId).toBe(hex32('d0')); // EVAL
  });

  it('attaches candidates by requestId+chainId without rewriting spine fields', () => {
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
        projectedTaskId: '999', projectedAttemptIndex: 99, projectedEvaluator: addr('ff'),
        solutionRequestId: 'hint-only',
      }],
    });
    const attempt = map.get('7')!.authoritative.attempts[0]!;
    expect(attempt.taskId).toBe('7');
    expect(attempt.attemptIndex).toBe(0);
    expect(attempt.operator).toBe(addr('b0'));
    expect(attempt.attemptEnvelopeCandidates).toHaveLength(1);
    expect(attempt.verdicts[0]!.evaluator).toBe(addr('e0')); // not projectedEvaluator
    expect(attempt.verdicts[0]!.verdictEnvelopeCandidates[0]!.projectedTaskId).toBe('999');
  });

  it('omits unknown task ids and retains all candidate publishers for one request', () => {
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
    });
    expect(map.size).toBe(0);
  });
});

describe('mergeTaskLifecycleEvidence (#2044 AC3)', () => {
  it('keeps floor authoritative fields when HTTP spine disagrees and only merges candidates', () => {
    const floor: Map<string, TaskLifecycleEvidence> = new Map([['7', {
      taskId: '7',
      authoritative: {
        task: {
          taskId: '7', chainId: 84532, manifestDigest: hex32('11'),
          taskCidDigest: hex32('22'), creator: addr('aa'), maxClaims: 1,
          requiredVerdicts: 1, createdAtBlock: 10, finalized: false, refunded: false,
        },
        attempts: [{
          taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('b0'), priorityMech: addr('c0'), deliveryRate: '1',
          createdAtBlock: 20, verdicts: [], attemptEnvelopeCandidates: [],
        }],
      },
    }]]);
    const http: Map<string, TaskLifecycleEvidence> = new Map([['7', {
      taskId: '7',
      authoritative: {
        task: {
          taskId: '7', chainId: 84532, manifestDigest: hex32('ff'), // disagree
          taskCidDigest: hex32('ee'), creator: addr('ff'), maxClaims: 99,
          requiredVerdicts: 9, createdAtBlock: 999, finalized: true, refunded: true,
        },
        attempts: [{
          taskId: '7', chainId: 84532, attemptIndex: 0, requestId: hex32('b0'),
          operator: addr('ff'), priorityMech: addr('ff'), deliveryRate: '999',
          createdAtBlock: 999, verdicts: [],
          attemptEnvelopeCandidates: [{
            requestId: hex32('b0'), chainId: 84532, manifestCid: 'bafyA',
            publisherAgentId: '1', manifestHash: hex32('99'), enrichedAtBlock: 25,
          }],
        }],
      },
    }]]);
    const merged = mergeTaskLifecycleEvidence(floor, http);
    const task = merged.get('7')!.authoritative.task;
    expect(task.manifestDigest).toBe(hex32('11'));
    expect(task.finalized).toBe(false);
    expect(merged.get('7')!.authoritative.attempts[0]!.operator).toBe(addr('b0'));
    expect(merged.get('7')!.authoritative.attempts[0]!.attemptEnvelopeCandidates)
      .toHaveLength(1);
  });
});
