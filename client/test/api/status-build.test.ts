import { describe, expect, it } from 'vitest';
import {
  assembleStatusV1,
  resolveMasterDailyEstimateWei,
  type GatheredStatusRaw,
} from '../../src/api/status-build.js';
import type { FleetState } from '../../src/earning/types.js';

function minimalFleet(overrides: Partial<FleetState> = {}): FleetState {
  return {
    master_address: '0x1111111111111111111111111111111111111111',
    chain: 'base',
    staking_mode: 'standard',
    services: [
      {
        index: 1,
        agent_address: '0x2222222222222222222222222222222222222222',
        safe_address: '0x3333333333333333333333333333333333333333',
        service_id: 42,
        mech_address: '0x4444444444444444444444444444444444444444',
        staking_address: '0x5555555555555555555555555555555555555555',
        step: 'complete',
        error: null,
      },
    ],
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveMasterDailyEstimateWei', () => {
  it('uses explicit config string', () => {
    expect(resolveMasterDailyEstimateWei('5000000000000000', 5000)).toBe(5_000_000_000_000_000n);
  });

  it('falls back to poll-based heuristic when unset', () => {
    const v = resolveMasterDailyEstimateWei(undefined, 5000);
    expect(v).toBeGreaterThan(0n);
  });
});

describe('assembleStatusV1', () => {
  it('marks sqlite_only mode and short-circuits next actions', () => {
    const raw: GatheredStatusRaw = {
      hintsScope: 'sqlite_only',
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: { created: 1 },
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000',
    };
    const j = assembleStatusV1(raw);
    expect(j.statusMode).toBe('sqlite_only');
    expect(j.nextActions).toHaveLength(1);
    expect(j.nextActions[0]).toMatch(/npm run status/);
    expect(j.earnings.hint).toMatch(/omitted/);
  });

  it('reports zero runway excess when balance is already below minimum', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: {
        address: '0x1111111111111111111111111111111111111111',
        balanceWei: '20000000000000000',
      },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000000000000000',
      minMasterEthWei: '50000000000000000',
    };
    const j = assembleStatusV1(raw);
    expect(j.masterGas.runwayDaysExcess).toBe('0');
  });

  it('flags low master balance vs minimum', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 600_000,
      fleet: minimalFleet(),
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: {
        address: '0x1111111111111111111111111111111111111111',
        balanceWei: '1',
      },
      pendingStakingRewardsWei: '0',
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000000000000000000',
      minMasterEthWei: '10000000000000000000',
    };
    const j = assembleStatusV1(raw);
    expect(j.nextActions.some(a => a.includes('Fund master'))).toBe(true);
    expect(j.fleet.completeCount).toBe(1);
    expect(j.fleet.stakedLikeCount).toBe(1);
  });

  it('includes RPC failure in next actions when full mode', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: false, error: 'boom' },
      master: { address: '0x1111111111111111111111111111111111111111' },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1',
    };
    const j = assembleStatusV1(raw);
    expect(j.statusMode).toBe('full');
    expect(j.nextActions.some(a => a.includes('RPC'))).toBe(true);
  });
});
