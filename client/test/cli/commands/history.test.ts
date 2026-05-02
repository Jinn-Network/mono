import { describe, expect, it } from 'vitest';
import { createHistoryCommand } from '@/cli/commands/history.js';
import { assembleHistoryV1 } from '@/api/history-build.js';
import { runCommand } from '@test/cli.js';
import type { GatheredStatusRaw } from '@/api/status-build.js';
import type { ActivityEventRow } from '@/store/store.js';

const mockStoreRows: ActivityEventRow[] = [
  {
    id: 1,
    ts: '2026-04-14T12:00:00.000Z',
    kind: 'delivered',
    requestId: 'req_2',
    serviceIndex: null,
    txHash: null,
    solverType: null,
    outcome: 'ok',
    detail: null,
  },
  {
    id: 2,
    ts: '2026-04-14T11:00:00.000Z',
    kind: 'created',
    requestId: 'req_1',
    serviceIndex: null,
    txHash: null,
    solverType: null,
    outcome: 'ok',
    detail: null,
  },
];

const mockRaw: GatheredStatusRaw = {
  shutdownState: null,
  dbPath: '/tmp/x',
  activityCounts: {},
  recentActivity: [],
  lastRewardClaimTickAt: null,
  rewardClaimIntervalMs: 1,
  fleet: null,
  rpc: { ok: true, chainId: 1, blockNumber: '1' },
  master: { address: '0xM' },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '0',
};

function makeFakeStore(rows: ActivityEventRow[]) {
  return {
    getRecentActivityEvents: (
      limit: number,
      _opts: { since?: string; cursor?: string } = {},
    ) => rows.slice(0, limit),
  } as any;
}

const fakeDeps = {
  loadConfig: () => ({ dbPath: '/tmp/history-mock.db' }) as any,
  getConfigPathFromArgs: () => undefined,
  storeFactory: (_path: string) => makeFakeStore(mockStoreRows),
  gatherIntrospectionRaw: async () => mockRaw as GatheredStatusRaw,
  assembleHistoryV1,
};

describe('history command', () => {
  it('emits events from local activity store', async () => {
    const cmd = createHistoryCommand(fakeDeps);
    const { envelopes } = await runCommand(cmd);
    const parsed = envelopes[envelopes.length - 1] as { events: unknown[] };
    expect(parsed.events.length).toBe(2);
  });

  it('respects --limit', async () => {
    const cmd = createHistoryCommand(fakeDeps);
    const { envelopes } = await runCommand(cmd, { argv: ['--limit', '1'] });
    const parsed = envelopes[envelopes.length - 1] as { events: unknown[] };
    expect(parsed.events).toHaveLength(1);
  });
});
