import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';
import { createFleetScaleCommand, type FleetScaleDeps } from '../../../src/cli/commands/fleet-scale.js';
import { findServiceByDisplayIndex } from '../../../src/earning/fleet-display-index.js';

const mockRawTwo: GatheredStatusRaw = {
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
      {
        index: 2,
        agent_address: '0xB',
        safe_address: null,
        service_id: 2,
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

function makeFakeDeps(raw: GatheredStatusRaw = mockRawTwo): FleetScaleDeps {
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
    checkDaemonGuard: () => ({ blocked: false, pid: null, pidfilePath: '', reason: 'not-running' as const }),
  };
}

describe('fleet retire subverb', () => {
  it('retire 1 --dry-run emits a retire plan for display index 1 (HD slot 2)', async () => {
    const fleet = createFleetScaleCommand(makeFakeDeps());
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: ['retire', '1', '--dry-run'],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {},
      env: { JINN_PASSWORD: 'test' },
    };
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.plan[0]).toMatchObject({ action: 'retire', index: 1, chainIndex: 2 });
  });

  it('retire 0 --dry-run targets display index 0 (HD slot 1)', async () => {
    const fleet = createFleetScaleCommand(makeFakeDeps());
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: ['retire', '0', '--dry-run'],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {},
      env: { JINN_PASSWORD: 'test' },
    };
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.plan[0]).toMatchObject({ action: 'retire', index: 0, chainIndex: 1 });
  });

  it('retire 99 --dry-run on non-existent index is a no-op', async () => {
    const fleet = createFleetScaleCommand(makeFakeDeps());
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: ['retire', '99', '--dry-run'],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {},
      env: { JINN_PASSWORD: 'test' },
    };
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.plan).toEqual([]);
    expect(parsed.description).toContain('already retired');
  });

  it('retire with no index emits invalid_invocation', async () => {
    const fleet = createFleetScaleCommand(makeFakeDeps());
    const writes: string[] = [];
    const exits: number[] = [];
    const ctx: CommandContext = {
      argv: ['retire'],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: (c: number) => { exits.push(c); },
      env: { JINN_PASSWORD: 'test' },
    };
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('<index>');
    expect(exits).toEqual([11]);
  });
});
