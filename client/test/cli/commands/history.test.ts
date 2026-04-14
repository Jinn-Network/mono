import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';

const mockRaw: GatheredStatusRaw = {
  shutdownState: null,
  dbPath: '/tmp/x',
  activityCounts: {},
  recentActivity: [
    { requestId: 'req_2', role: 'delivered' },
    { requestId: 'req_1', role: 'created' },
  ],
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

describe('history command', () => {
  it('emits events from recentActivity', async () => {
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
    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
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
