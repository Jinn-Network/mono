import { describe, expect, it } from 'vitest';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';
import { createRewardsCommand } from '@/cli/commands/rewards.js';
import { assembleRewardsV1 } from '@/api/rewards-build.js';
import { runCommand } from '@test/cli.js';

const mockRaw: GatheredStatusRaw = {
  shutdownState: null,
  dbPath: '/tmp/x',
  activityCounts: {},
  recentActivity: [],
  lastRewardClaimTickAt: '2026-04-14T11:00:00.000Z',
  rewardClaimIntervalMs: 1,
  fleet: {
    master_address: null,
    chain: 'base-sepolia',
    staking_mode: 'standard',
    updated_at: '2026-04-14T12:00:00.000Z',
    services: [
      {
        index: 1,
        agent_address: '0xA',
        safe_address: null,
        service_id: 42,
        mech_address: null,
        staking_address: null,
        step: 'complete',
        error: null,
      },
    ],
  },
  rpc: { ok: true },
  master: { address: null },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '0',
  pendingStakingRewardsWei: '1000',
};

const fakeDeps = {
  gatherIntrospectionRaw: async () => mockRaw as GatheredStatusRaw,
  assembleRewardsV1,
};

describe('rewards command', () => {
  it('emits a rewards response with lastClaimAt and service entries', async () => {
    const cmd = createRewardsCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const parsed = envelopes[0] as { lastClaimAt: string; services: Array<{ pending: string }> };
    expect(parsed.lastClaimAt).toBe('2026-04-14T11:00:00.000Z');
    expect(parsed.services[0].pending).toBe('1000');
  });

  it('emits invalid_invocation for bad flags', async () => {
    const cmd = createRewardsCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd, { argv: ['--configt', '/tmp/x'] });
    const parsed = envelopes[0] as { code: string };
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('labels human output as staking collector claims, not operator tJINN', async () => {
    const cmd = createRewardsCommand(fakeDeps);
    const { raw } = await runCommand(cmd, { argv: ['--human'], tty: true });
    const stdout = raw.join('');
    expect(stdout).toContain('Pending staking collector claims:');
    expect(stdout).toContain('collector-token');
    expect(stdout).toContain('Operator tJINN/JINN earnings');
  });
});
