import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';

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

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => mockRawOne),
}));

function makeCtx(argv: string[]): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (c: number) => { exits.push(c); },
    env: { JINN_PASSWORD: 'test' },
  };
  return { ctx, writes, exits };
}

describe('fleet compound command', () => {
  it('scale --to 3 --dry-run emits a growth plan', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const { ctx, writes } = makeCtx(['scale', '--to', '3', '--dry-run']);
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.plan[0]).toMatchObject({ action: 'grow', from: 1, to: 3 });
  });

  it('scale --to 1 --dry-run when already at 1 is a no-op', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const { ctx, writes } = makeCtx(['scale', '--to', '1', '--dry-run']);
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.plan).toEqual([]);
    expect(parsed.description).toContain('already');
  });

  it('missing subverb emits invalid_invocation', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const { ctx, writes, exits } = makeCtx([]);
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('subverb');
    expect(exits).toEqual([11]);
  });

  it('unknown subverb emits invalid_invocation', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const { ctx, writes, exits } = makeCtx(['nope']);
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
