import { describe, expect, it } from 'vitest';
import { createWithdrawCommand } from '@/cli/commands/withdraw.js';
import { parseWithdrawArgv } from '@/withdraw/args.js';
import { validateWithdrawArgs } from '@/withdraw/args.js';
import { runCommand } from '@test/cli.js';
import type { GatheredStatusRaw } from '@/api/status-build.js';

const mockRaw: GatheredStatusRaw = {
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
        safe_address: '0xS',
        service_id: 1,
        mech_address: null,
        staking_address: null,
        step: 'complete',
        error: null,
      },
    ],
  },
  rpc: { ok: true },
  master: { address: '0xM', balanceWei: '1000000' },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '0',
};

/** Minimal deps covering all paths exercised by the tests below (dry-run + validation paths). */
const fakeDeps = {
  loadConfig: () => ({ network: 'testnet', rpcUrl: 'https://fake', earningDir: '/tmp/e' }) as any,
  getConfigPathFromArgs: () => undefined,
  gatherIntrospectionRaw: async () => mockRaw as GatheredStatusRaw,
  resolveCliPassword: () => ({ ok: true as const, password: 'test' }),
  parseWithdrawArgv,
  validateWithdrawArgs,
  computeSweepWouldSend: async () => false,
  runWithdrawPlan: async () => {},
  withdrawNeedsInteractiveConfirm: () => false,
  decryptMnemonic: async () => 'mnemonic',
  fleetStateStoreFactory: () => ({
    loadMnemonicKeystore: async () => '{}',
    tryLoadExisting: async () => null,
  }) as any,
  createJinnPublicClient: () => ({}) as any,
};

describe('withdraw command', () => {
  it('--dry-run emits a sweep plan', async () => {
    const cmd = createWithdrawCommand(fakeDeps);
    const { envelopes } = await runCommand(cmd, {
      argv: [
        '--to',
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        '--eth-amount',
        '0.01',
        '--dry-run',
      ],
      env: { JINN_PASSWORD: 'test' },
    });
    const parsed = envelopes[envelopes.length - 1] as {
      dryRun: boolean;
      plan: Array<{ from: string }>;
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.plan.some((p) => p.from === '0xM')).toBe(true);
  });

  it('missing --to emits invalid_invocation', async () => {
    const cmd = createWithdrawCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd, {
      argv: ['--drain-eth', '--yes'],
      env: { JINN_PASSWORD: 'test' },
    });
    const parsed = envelopes[envelopes.length - 1] as {
      code: string;
      details?: { field?: string };
    };
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('--to');
    expect(exits).toEqual([11]);
  });

  it('non-TTY without --yes or --dry-run refuses', async () => {
    const cmd = createWithdrawCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd, {
      argv: [
        '--to',
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        '--eth-amount',
        '0.01',
      ],
      env: { JINN_PASSWORD: 'test' },
    });
    const parsed = envelopes[envelopes.length - 1] as { code: string };
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
