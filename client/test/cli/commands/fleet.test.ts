import { describe, expect, it } from 'vitest';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';
import { createFleetCommand } from '@/cli/commands/fleet.js';
import { assembleFleetV1 } from '@/api/fleet-build.js';
import { runCommand } from '@test/cli.js';

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

const fakeDeps = {
  gatherIntrospectionRaw: async () => mockRaw as GatheredStatusRaw,
  assembleFleetV1,
};

describe('fleet command', () => {
  it('writes assembled fleet JSON', async () => {
    const cmd = createFleetCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const parsed = envelopes[0] as { schemaVersion: number; services: Array<{ index: number }> };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.services).toHaveLength(1);
    expect(parsed.services[0].index).toBe(0);
  });

  it('rejects unknown flags with invalid_invocation', async () => {
    const cmd = createFleetCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd, { argv: ['--bogus'] });
    const parsed = envelopes[0] as { code: string };
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
