import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';

const mockRaw: GatheredStatusRaw = {
  shutdownState: null,
  dbPath: '/tmp/x',
  activityCounts: {},
  recentActivity: [],
  lastRewardClaimTickAt: '2026-04-14T11:00:00.000Z',
  rewardClaimIntervalMs: 1,
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
  pendingStakingRewardsWei: '1000',
};

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => mockRaw),
}));

describe('rewards command', () => {
  it('emits a rewards response with lastClaimAt and service entries', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/rewards.js');
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
    expect(parsed.lastClaimAt).toBe('2026-04-14T11:00:00.000Z');
    expect(parsed.services[0].pending).toBe('1000');
  });

  it('emits invalid_invocation for bad flags', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/rewards.js');
    const writes: string[] = [];
    const exits: number[] = [];
    const ctx: CommandContext = {
      argv: ['--configt', '/tmp/x'],
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
});
