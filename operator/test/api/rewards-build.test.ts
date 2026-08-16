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
    pendingByService: { 0: '1500000000000000000' },
    claimedByService: {
      0: {
        total: '250000000000000000',
        lastAt: '2026-04-14T10:45:00.000Z',
        lastTxHash: '0xabc0000000000000000000000000000000000000000000000000000000001234',
      },
    },
  };
}

describe('assembleRewardsV1', () => {
  it('emits OLAS pending and claimed totals with per-service entries', () => {
    const out = assembleRewardsV1(makeRaw());
    expect(out.schemaVersion).toBe(1);
    expect(out.readState).toBe('ready');
    expect(out.totalPending).toBe('1500000000000000000');
    expect(out.totalClaimed).toBe('250000000000000000');
    expect(out.services).toHaveLength(1);
    const svc = out.services[0]!;
    expect(svc.index).toBe(0);
    expect(svc.pending).toBe('1500000000000000000');
    expect(svc.claimed).toBe('250000000000000000');
    expect(svc.lastClaimAt).toBe('2026-04-14T10:45:00.000Z');
    expect(svc.lastClaimTxHash).toBe('0xabc0000000000000000000000000000000000000000000000000000000001234');
    expect(svc.asset).toBe('OLAS');
  });

  it('reports the last successful claim, not the last claim-loop tick, on the top-level', () => {
    const out = assembleRewardsV1(makeRaw());
    expect(out.lastClaimAt).toBe('2026-04-14T10:45:00.000Z');
    expect(out.lastClaimTickAt).toBe('2026-04-14T11:00:00.000Z');
  });

  it('marks the read unavailable when the pending reward read failed', () => {
    const out = assembleRewardsV1({
      ...makeRaw(),
      pendingStakingRewardsWei: undefined,
      pendingByService: {},
      pendingStakingRewardsError: 'rpc down',
    } as GatheredStatusRaw);

    expect(out.readState).toBe('error');
    expect(out.error).toBe('rpc down');
    expect(out.totalPending).toBe('0');
  });
});
