import { describe, expect, it } from 'vitest';
import { assembleStatusRollupV1 } from '../../src/api/status-rollup-build.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';

function makeRaw(): GatheredStatusRaw {
  return {
    shutdownState: 'running',
    dbPath: '/tmp/x',
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 600_000,
    fleet: {
      master_address: '0xM',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      updated_at: '2026-04-14T12:00:00.000Z',
      services: [
        {
          index: 1,
          agent_address: '0x',
          safe_address: null,
          service_id: 42,
          mech_address: null,
          staking_address: null,
          step: 'complete',
          error: null,
        },
        {
          index: 2,
          agent_address: '0x',
          safe_address: null,
          service_id: 43,
          mech_address: null,
          staking_address: null,
          step: 'service_staked',
          error: null,
        },
      ],
    },
    rpc: { ok: true, chainId: 84532, blockNumber: '999' },
    master: { address: '0xM', balanceWei: '1' },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '1',
    pendingStakingRewardsWei: '42',
  };
}

describe('assembleStatusRollupV1', () => {
  it('emits the §4.1 roll-up shape with daemon/rpc/fleet/earnings/exit', () => {
    const parsed = assembleStatusRollupV1(makeRaw());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.daemon.state).toBe('running');
    expect(parsed.daemon.network).toBe('testnet');
    expect(parsed.rpc.ok).toBe(true);
    expect(parsed.rpc.chainId).toBe(84532);
    expect(parsed.fleet.size).toBe(2);
    expect(parsed.fleet.complete).toBe(1);
    expect(parsed.fleet.needsAttention).toBe(1);
    expect(parsed.earnings.pendingTotal).toBe('42');
    expect(parsed.earnings.asset).toBe('reward');
    expect(parsed.exit.blocking).toBe(true);
    expect(parsed.exit.hint).toContain('fleet');
  });

  it('exit.blocking when rpc is not ok', () => {
    const raw = makeRaw();
    raw.rpc = { ok: false, error: 'rpc down' };
    const parsed = assembleStatusRollupV1(raw);
    expect(parsed.exit.blocking).toBe(true);
    expect(parsed.exit.hint).toContain('rpc');
  });

  it('exit not blocking when fleet is fully complete and master above minimum', () => {
    const raw = makeRaw();
    raw.fleet!.services = raw.fleet!.services.map(s => ({ ...s, step: 'complete' as const }));
    raw.minMasterEthWei = '1';
    raw.master.balanceWei = '100';
    const parsed = assembleStatusRollupV1(raw);
    expect(parsed.exit.blocking).toBe(false);
  });
});
