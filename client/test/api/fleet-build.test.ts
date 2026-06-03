import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assembleFleetV1 } from '../../src/api/fleet-build.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';

function makeRaw(overrides: Partial<GatheredStatusRaw> = {}): GatheredStatusRaw {
  return {
    shutdownState: 'running',
    dbPath: join(tmpdir(), 'fleet-build-test.db'),
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 600_000,
    fleet: {
      master_address: '0xMASTER',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      updated_at: '2026-04-14T12:00:00.000Z',
      services: [
        {
          index: 1,
          agent_address: '0xAGENT',
          safe_address: '0xSAFE',
          service_id: 42,
          mech_address: null,
          staking_address: null,
          step: 'complete',
          error: null,
        },
      ],
    },
    rpc: { ok: true, chainId: 84532, blockNumber: '1' },
    master: { address: '0xMASTER', balanceWei: '10000000000000000' },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '1000000000000000',
    minMasterEthWei: '5000000000000000',
    pendingStakingRewardsWei: '0',
    ...overrides,
  };
}

describe('assembleFleetV1', () => {
  it('emits schemaVersion and per-service entries with wallets and staking state', () => {
    const out = assembleFleetV1(makeRaw());
    expect(out.schemaVersion).toBe(1);
    expect(out.network).toBe('testnet');
    expect(out.master.address).toBe('0xMASTER');
    expect(out.services).toHaveLength(1);
    const svc = out.services[0]!;
    expect(svc.index).toBe(0);
    expect(svc.step).toBe('complete');
    expect(svc.serviceId).toBe(42);
    expect(svc.wallets.agent.address).toBe('0xAGENT');
    expect(svc.wallets.multisig.address).toBe('0xSAFE');
    expect(svc.staking.staked).toBe(true);
  });

  it('sets attention=null when no issue detected', () => {
    const out = assembleFleetV1(makeRaw());
    expect(out.services[0]!.attention).toBeNull();
  });

  it('sets attention.kind=low_gas when master gas is below min', () => {
    const raw = makeRaw();
    raw.master.balanceWei = '1000';
    raw.minMasterEthWei = '5000000000000000';
    const out = assembleFleetV1(raw);
    expect(out.services[0]!.attention?.kind).toBe('low_gas');
  });

  it('surfaces preserved setup errors as service attention', () => {
    const raw = makeRaw();
    raw.fleet!.services[0]!.error = 'Existing setup was preserved for recovery.';
    const out = assembleFleetV1(raw);
    expect(out.services[0]!.attention?.kind).toBe('reconcile_needed');
    expect(out.services[0]!.attention?.hint).toContain('preserved for recovery');
  });

  it('reports network=mainnet when fleet.chain is base', () => {
    const raw = makeRaw();
    raw.fleet = { ...raw.fleet!, chain: 'base' };
    const out = assembleFleetV1(raw);
    expect(out.network).toBe('mainnet');
  });
});
