import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';

const mockRaw: GatheredStatusRaw = {
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
  daemonStartedAt: '2026-04-14T12:00:00.000Z',
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '1',
  pendingStakingRewardsWei: '42',
  earningDir: '/tmp/earning',
};

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => mockRaw),
}));

describe('status command', () => {
  it('emits the §4.1 roll-up shape with daemon/rpc/fleet/earnings/exit', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/status.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: [],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {},
      env: {},
    };
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.daemon.state).toBe('running');
    expect(parsed.daemon.startedAt).toBe('2026-04-14T12:00:00.000Z');
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
    expect(parsed.paths).toEqual({
      earningDir: '/tmp/earning',
      dbPath: '/tmp/x',
    });
  });

  it('rejects unknown flags with invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/status.js');
    const writes: string[] = [];
    const exits: number[] = [];
    const ctx: CommandContext = {
      argv: ['--configt', 'bad.json'],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: (code: number) => { exits.push(code); },
      env: {},
    };
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('renders human output through the CLI dispatcher', async () => {
    const { runCli } = await import('../../../src/cli/index.js');
    const writes: string[] = [];
    const exits: number[] = [];
    await runCli(['status', '--human'], {
      stdoutIsTty: true,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: (code: number) => { exits.push(code); },
    });

    const out = writes.join('');
    expect(out).toContain('daemon=running');
    expect(out).not.toMatch(/^\{/);
    expect(exits).toEqual([]);
  });
});
