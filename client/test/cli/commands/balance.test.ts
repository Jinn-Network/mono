import { describe, expect, it } from 'vitest';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';
import { createBalanceCommand } from '@/cli/commands/balance.js';
import { assembleBalanceV1 } from '@/api/balance-build.js';
import { runCommand } from '@test/cli.js';

const mockRaw: GatheredStatusRaw = {
  shutdownState: null,
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
  rpc: { ok: true },
  master: { address: '0xM', balanceWei: '1' },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '1',
};

const fakeDeps = {
  gatherIntrospectionRaw: async () => mockRaw as GatheredStatusRaw,
  assembleBalanceV1,
};

describe('balance command', () => {
  it('writes assembled balance JSON', async () => {
    const cmd = createBalanceCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const parsed = envelopes[0] as { schemaVersion: number; wallets: Array<{ role: string }> };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.wallets.some((w) => w.role === 'master')).toBe(true);
  });

  it('rejects unknown flags with invalid_invocation', async () => {
    const cmd = createBalanceCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd, { argv: ['--bogus'] });
    const parsed = envelopes[0] as { code: string };
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
