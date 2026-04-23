import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assembleBalanceV1 } from '../../src/api/balance-build.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';

function makeRaw(): GatheredStatusRaw {
  return {
    shutdownState: null,
    dbPath: join(tmpdir(), 'balance-build-test.db'),
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 1,
    fleet: {
      master_address: '0xMASTER',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      updated_at: '2026-04-14T12:00:00.000Z',
      services: [
        {
          index: 1,
          agent_address: '0xA0',
          safe_address: '0xS0',
          service_id: 1,
          mech_address: null,
          staking_address: null,
          step: 'complete',
          error: null,
        },
        {
          index: 2,
          agent_address: '0xA1',
          safe_address: '0xS1',
          service_id: 2,
          mech_address: null,
          staking_address: null,
          step: 'complete',
          error: null,
        },
      ],
    },
    rpc: { ok: true },
    master: { address: '0xMASTER', balanceWei: '1' },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '1',
  };
}

describe('assembleBalanceV1', () => {
  it('emits one entry per wallet with stable role names', () => {
    const out = assembleBalanceV1(makeRaw());
    expect(out.schemaVersion).toBe(1);
    const roles = out.wallets.map(w => w.role);
    expect(roles).toEqual([
      'master',
      'service.0.agent',
      'service.0.multisig',
      'service.1.agent',
      'service.1.multisig',
    ]);
  });

  it('master has a native balance', () => {
    const out = assembleBalanceV1(makeRaw());
    const master = out.wallets.find(w => w.role === 'master')!;
    expect(master.address).toBe('0xMASTER');
    expect(master.balances[0]!.asset).toBe('native');
  });
});
