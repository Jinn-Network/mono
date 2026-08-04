import { describe, expect, it } from 'vitest';
import { applyTaskLifecycleTerminals } from '../../src/discovery/task-lifecycle-evidence.js';
import type { RawTaskRow } from '../../src/discovery/task-lifecycle-evidence.js';

const hex32 = (n: string) => `0x${n.repeat(32)}` as `0x${string}`;
const addr = (n: string) => `0x${n.repeat(20)}` as `0x${string}`;

function baseTask(over: Partial<RawTaskRow> = {}): RawTaskRow {
  return {
    taskId: '7',
    chainId: 84532,
    manifestDigest: hex32('11'),
    taskCidDigest: hex32('22'),
    creator: addr('aa'),
    maxClaims: 1,
    requiredVerdicts: 1,
    createdAtBlock: 10,
    finalized: true, // hostile provisional — helper must overwrite
    refunded: false,
    ...over,
  };
}

describe('applyTaskLifecycleTerminals (#2236)', () => {
  it('clears hostile finalized when spine is empty and sets refunded from the set', () => {
    const task = baseTask({ finalized: true, refunded: false });
    applyTaskLifecycleTerminals({
      tasks: [task],
      attempts: [],
      verdicts: [],
      refundedTaskIds: new Set(['7']),
    });
    expect(task.finalized).toBe(false);
    expect(task.refunded).toBe(true);
  });

  it('sets finalized when one attempt meets requiredVerdicts', () => {
    const task = baseTask({ finalized: false, requiredVerdicts: 1 });
    applyTaskLifecycleTerminals({
      tasks: [task],
      attempts: [{ taskId: '7', attemptIndex: 0, chainId: 84532 }],
      verdicts: [{ taskId: '7', attemptIndex: 0, chainId: 84532 }],
      refundedTaskIds: new Set(),
    });
    expect(task.finalized).toBe(true);
    expect(task.refunded).toBe(false);
  });

  it('keeps finalized false when verdict count is below requiredVerdicts', () => {
    const task = baseTask({ finalized: true, requiredVerdicts: 2 });
    applyTaskLifecycleTerminals({
      tasks: [task],
      attempts: [{ taskId: '7', attemptIndex: 0, chainId: 84532 }],
      verdicts: [{ taskId: '7', attemptIndex: 0, chainId: 84532 }],
      refundedTaskIds: new Set(),
    });
    expect(task.finalized).toBe(false);
  });

  it('ignores attempts/verdicts on a different chainId or taskId', () => {
    const task = baseTask({ finalized: true, requiredVerdicts: 1 });
    applyTaskLifecycleTerminals({
      tasks: [task],
      attempts: [
        { taskId: '7', attemptIndex: 0, chainId: 1 },
        { taskId: '8', attemptIndex: 0, chainId: 84532 },
      ],
      verdicts: [
        { taskId: '7', attemptIndex: 0, chainId: 1 },
        { taskId: '8', attemptIndex: 0, chainId: 84532 },
      ],
      refundedTaskIds: new Set(['8']),
    });
    expect(task.finalized).toBe(false);
    expect(task.refunded).toBe(false);
  });

  it('finalizes when any single attempt meets the threshold (multi-attempt)', () => {
    const task = baseTask({ requiredVerdicts: 2 });
    applyTaskLifecycleTerminals({
      tasks: [task],
      attempts: [
        { taskId: '7', attemptIndex: 0, chainId: 84532 },
        { taskId: '7', attemptIndex: 1, chainId: 84532 },
      ],
      verdicts: [
        { taskId: '7', attemptIndex: 1, chainId: 84532 },
        { taskId: '7', attemptIndex: 1, chainId: 84532 },
      ],
      refundedTaskIds: new Set(),
    });
    expect(task.finalized).toBe(true);
  });
});
