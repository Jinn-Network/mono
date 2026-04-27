import { describe, expect, it } from 'vitest';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';
import { makeCommandCtx } from '@test/cli.js';
import { createFleetScaleCommand, type FleetScaleDeps } from '../../../src/cli/commands/fleet-scale.js';
import { findServiceByDisplayIndex } from '../../../src/earning/fleet-display-index.js';

const mockRawOne: GatheredStatusRaw = {
  shutdownState: null,
  dbPath: '',
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
        safe_address: null,
        service_id: 1,
        mech_address: null,
        staking_address: null,
        step: 'complete',
        error: null,
      },
    ],
  },
  rpc: { ok: true },
  master: { address: '0xM' },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '0',
};

function makeFakeDeps(raw: GatheredStatusRaw = mockRawOne): FleetScaleDeps {
  return {
    loadConfig: () => ({} as any),
    getConfigPathFromArgs: () => undefined,
    gatherIntrospectionRaw: async () => raw,
    resolveCliPassword: () => ({ ok: true as const, password: 'test' }),
    signerContextFactory: async () => ({ ok: false, envelope: { code: 'fatal', message: 'not used in dry-run tests' } } as any),
    bootstrapperFactory: () => ({ bootstrap: async () => ({ ok: true, message: 'ok', fleet_state: { master_address: '0xM', services: [] } }) } as any),
    retireFleetServiceOnChain: async () => ({ ok: true, message: 'retired', txHash: '0xabc' } as any),
    findServiceByDisplayIndex,
    isRecoverableTransactionError: () => false,
  };
}

describe('fleet compound command', () => {
  it('scale --dry-run accepts --config and --password-fd', async () => {
    const fleet = createFleetScaleCommand(makeFakeDeps());
    const { ctx, writes } = makeCommandCtx({ argv: [
      'scale',
      '--to',
      '3',
      '--dry-run',
      '--config',
      '/tmp/fleet-scale-config.json',
      '--password-fd',
      '5',
    ], env: { JINN_PASSWORD: 'test' } });
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
  });

  it('scale --to 3 --dry-run emits a growth plan', async () => {
    const fleet = createFleetScaleCommand(makeFakeDeps());
    const { ctx, writes } = makeCommandCtx({ argv: ['scale', '--to', '3', '--dry-run'], env: { JINN_PASSWORD: 'test' } });
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.plan[0]).toMatchObject({ action: 'grow', from: 1, to: 3 });
  });

  it('scale --to 1 --dry-run when already at 1 is a no-op', async () => {
    const fleet = createFleetScaleCommand(makeFakeDeps());
    const { ctx, writes } = makeCommandCtx({ argv: ['scale', '--to', '1', '--dry-run'], env: { JINN_PASSWORD: 'test' } });
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.plan).toEqual([]);
    expect(parsed.description).toContain('already');
  });

  it('missing subverb emits invalid_invocation', async () => {
    const fleet = createFleetScaleCommand(makeFakeDeps());
    const { ctx, writes, exits } = makeCommandCtx({ argv: [], env: { JINN_PASSWORD: 'test' } });
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('subverb');
    expect(exits).toEqual([11]);
  });

  it('unknown subverb emits invalid_invocation', async () => {
    const fleet = createFleetScaleCommand(makeFakeDeps());
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['nope'], env: { JINN_PASSWORD: 'test' } });
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
