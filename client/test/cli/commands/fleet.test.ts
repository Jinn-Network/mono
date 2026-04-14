import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';

const mockRaw: GatheredStatusRaw = {
  shutdownState: 'running',
  dbPath: '/tmp/x',
  activityCounts: {},
  recentActivity: [],
  lastRewardClaimTickAt: null,
  rewardClaimIntervalMs: 1,
  fleet: {
    master_address: '0xM',
    chain: 'base-sepolia',
    staking_mode: 'standard',
    updated_at: '2026-04-14T12:00:00.000Z',
    services: [
      {
        index: 1,
        agent_address: '0xA',
        safe_address: '0xS',
        service_id: 1,
        mech_address: null,
        staking_address: null,
        step: 'complete',
        error: null,
      },
    ],
  },
  rpc: { ok: true, chainId: 84532, blockNumber: '1' },
  master: { address: '0xM', balanceWei: '1' },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '1',
  minMasterEthWei: '1',
};

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => mockRaw),
}));

describe('fleet command', () => {
  it('writes assembled fleet JSON', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/fleet.js');
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
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.services).toHaveLength(1);
    expect(parsed.services[0].index).toBe(0);
  });
});
