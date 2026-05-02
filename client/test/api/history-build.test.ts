import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assembleHistoryV1 } from '../../src/api/history-build.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';

function makeRaw(): GatheredStatusRaw {
  return {
    shutdownState: null,
    dbPath: join(tmpdir(), 'history-build-test.db'),
    activityCounts: { created: 2, delivered: 1 },
    recentActivity: [
      {
        id: 1,
        ts: '2026-04-14T12:00:00.000Z',
        kind: 'delivered',
        requestId: 'req_0xBBB',
        serviceIndex: null,
        txHash: null,
        solverType: null,
        outcome: 'ok',
      },
      {
        id: 2,
        ts: '2026-04-14T10:00:00.000Z',
        kind: 'created',
        requestId: 'req_0xAAA',
        serviceIndex: null,
        txHash: null,
        solverType: null,
        outcome: 'ok',
      },
    ],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 1,
    fleet: null,
    rpc: { ok: true, chainId: 84532, blockNumber: '1' },
    master: { address: '0xM' },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '0',
  };
}

describe('assembleHistoryV1', () => {
  it('maps recentActivity entries into event kinds', () => {
    const out = assembleHistoryV1(makeRaw(), { limit: 50 });
    expect(out.events).toHaveLength(2);
    const kinds = out.events.map(e => e.kind);
    expect(kinds).toContain('task_posted');
    expect(kinds).toContain('delivery_submitted');
  });

  it('honors --limit', () => {
    const out = assembleHistoryV1(makeRaw(), { limit: 1 });
    expect(out.events).toHaveLength(1);
  });

  it('honors --since by filtering older events', () => {
    const out = assembleHistoryV1(makeRaw(), {
      limit: 50,
      since: '2026-04-14T11:15:00.000Z',
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.kind).toBe('delivery_submitted');
  });
});
