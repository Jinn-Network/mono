import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assembleRewardsV1 } from '../../src/api/rewards-build.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';

function makeRaw(): GatheredStatusRaw {
  return {
    shutdownState: null,
    dbPath: join(tmpdir(), 'rewards-build-test.db'),
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: '2026-04-14T11:00:00.000Z',
    rewardClaimIntervalMs: 600_000,
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
    pendingStakingRewardsWei: '1500000000000000000',
  };
}

describe('assembleRewardsV1', () => {
  it('emits a per-service rewards entry with pending / asset=reward', () => {
    const out = assembleRewardsV1(makeRaw());
    expect(out.schemaVersion).toBe(1);
    expect(out.services).toHaveLength(1);
    const svc = out.services[0]!;
    expect(svc.index).toBe(0);
    expect(svc.pending).toBe('1500000000000000000');
    expect(svc.asset).toBe('reward');
  });

  it('reports lastClaimTickAt on the top-level', () => {
    const out = assembleRewardsV1(makeRaw());
    expect(out.lastClaimAt).toBe('2026-04-14T11:00:00.000Z');
  });
});
