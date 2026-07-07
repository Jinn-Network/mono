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
  claimedByService: {
    0: {
      total: '44',
      lastAt: '2026-04-14T10:45:00.000Z',
      lastTxHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
    },
  },
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
        staking_address: '0x5555555555555555555555555555555555555555',
        step: 'complete',
        error: null,
      },
    ],
  },
  rpc: { ok: true },
  master: { address: null },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '0',
};

const fakeDeps = {
  gatherIntrospectionRaw: async () => ({ ...mockRaw }) as GatheredStatusRaw,
  assembleRewardsV1,
  sumPendingStakingRewards: async () => ({
    sum: '1000',
    pendingByService: { 0: '1000' },
    nextCheckpointAt: '2026-04-15T00:00:00.000Z',
  }),
};

describe('rewards command', () => {
  it('emits a rewards response with lastClaimAt and service entries', async () => {
    const cmd = createRewardsCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const parsed = envelopes[0] as {
      lastClaimAt: string | null;
      lastClaimTickAt: string | null;
      services: Array<{ pending: string; claimed: string; asset: string }>;
    };
    expect(parsed.lastClaimAt).toBe('2026-04-14T10:45:00.000Z');
    expect(parsed.lastClaimTickAt).toBe('2026-04-14T11:00:00.000Z');
    expect(parsed.services[0].pending).toBe('1000');
    expect(parsed.services[0].claimed).toBe('44');
    expect(parsed.services[0].asset).toBe('OLAS');
  });

  it('invokes the on-demand staking extractor and renders its pending value (#992)', async () => {
    let extractorCalls = 0;
    const cmd = createRewardsCommand({
      gatherIntrospectionRaw: async () => ({ ...mockRaw }) as GatheredStatusRaw,
      assembleRewardsV1,
      sumPendingStakingRewards: async () => {
        extractorCalls += 1;
        return { sum: '1000', pendingByService: { 0: '1000' }, nextCheckpointAt: '2026-04-15T00:00:00.000Z' };
      },
    });
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    expect(extractorCalls).toBe(1);
    const parsed = envelopes[0] as { services: Array<{ pending: string }>; nextCheckpointAt: string };
    expect(parsed.services[0].pending).toBe('1000');
    expect(parsed.nextCheckpointAt).toBe('2026-04-15T00:00:00.000Z');
  });

  it('renders pending=0 and a null checkpoint when the extractor errors (#992)', async () => {
    const cmd = createRewardsCommand({
      gatherIntrospectionRaw: async () => ({ ...mockRaw }) as GatheredStatusRaw,
      assembleRewardsV1,
      sumPendingStakingRewards: async () => ({ error: 'rpc down' }),
    });
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    const parsed = envelopes[0] as { services: Array<{ pending: string }>; nextCheckpointAt: string | null };
    expect(parsed.services[0].pending).toBe('0');
    expect(parsed.nextCheckpointAt).toBeNull();
  });

  it('emits invalid_invocation for bad flags', async () => {
    const cmd = createRewardsCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd, { argv: ['--configt', '/tmp/x'] });
    const parsed = envelopes[0] as { code: string };
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('labels human output as pending OLAS rewards, not collector tokens or tJINN', async () => {
    const cmd = createRewardsCommand(fakeDeps);
    const { raw } = await runCommand(cmd, { argv: ['--human'], tty: true });
    const stdout = raw.join('');
    expect(stdout).toContain('Pending OLAS rewards:');
    expect(stdout).toContain('Service #0: 0.000000000000001 OLAS pending');
    expect(stdout).toContain('Operator OLAS rewards accrue through staking');
    expect(stdout).not.toContain('collector-token');
    expect(stdout).not.toContain('tJINN');
  });
});
