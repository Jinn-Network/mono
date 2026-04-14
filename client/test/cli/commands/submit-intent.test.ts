import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';

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
  rpc: { ok: true },
  master: { address: '0xM', balanceWei: '0' },
  pollIntervalMs: 5000,
  masterDailyEstimateWei: '0',
};

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => mockRaw),
}));

function makeCtx(argv: string[], tty = false): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: tty,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (c: number) => { exits.push(c); },
    env: { JINN_PASSWORD: 'test' },
  };
  return { ctx, writes, exits };
}

describe('submit-intent command', () => {
  it('--dry-run emits a plan without executing', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes } = makeCtx([
      '--id',
      'test-1',
      '--description',
      'The service is healthy',
      '--dry-run',
    ]);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('submit-intent');
    expect(parsed.plan[0]).toMatchObject({ id: 'test-1' });
  });

  it('non-TTY without --yes or --dry-run emits invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes, exits } = makeCtx(['--id', 'test-1', '--description', 'The service is healthy']);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('missing --id emits invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes, exits } = makeCtx(['--dry-run', '--description', 'x']);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('--id');
    expect(exits).toEqual([11]);
  });
});
