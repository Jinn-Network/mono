import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';

const mockStoreRows = [
  {
    id: 1,
    ts: '2026-04-14T12:00:00.000Z',
    kind: 'delivered' as const,
    requestId: 'req_2' as const,
    serviceIndex: null as const,
    txHash: null as const,
    specKind: null as const,
    outcome: 'ok' as const,
  },
  {
    id: 2,
    ts: '2026-04-14T11:00:00.000Z',
    kind: 'created' as const,
    requestId: 'req_1' as const,
    serviceIndex: null as const,
    txHash: null as const,
    specKind: null as const,
    outcome: 'ok' as const,
  },
];

vi.mock('../../../src/store/store.js', () => ({
  Store: class {
    getRecentActivityEvents(
      limit: number,
      _opts: { since?: string; cursor?: string } = {},
    ) {
      return mockStoreRows.slice(0, limit);
    }
  },
}));

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

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => mockRaw),
}));

vi.mock('../../../src/config.js', () => ({
  loadConfig: () => ({
    dbPath: '/tmp/history-mock.db',
  }),
  getConfigPathFromArgs: () => undefined,
}));

describe('history command', () => {
  it('emits events from local activity store', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/history.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: [],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {},
      env: {},
    };
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.events.length).toBe(2);
  });

  it('respects --limit', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/history.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: ['--limit', '1'],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {},
      env: {},
    };
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.events).toHaveLength(1);
  });
});
