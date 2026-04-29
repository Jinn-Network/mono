import { describe, expect, it } from 'vitest';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';
import { createStatusCommand } from '@/cli/commands/status.js';
import { assembleStatusRollupV1 } from '@/api/status-rollup-build.js';
import { runCommand } from '@test/cli.js';

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

const fakeDeps = {
  gatherIntrospectionRaw: async () => mockRaw as GatheredStatusRaw,
  assembleStatusRollupV1,
};

describe('status command', () => {
  it('emits the §4.1 roll-up shape with daemon/rpc/fleet/earnings/exit', async () => {
    const cmd = createStatusCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const parsed = envelopes[0] as {
      schemaVersion: number;
      daemon: { state: string; startedAt: string; network: string };
      rpc: { ok: boolean; chainId: number };
      fleet: { size: number; complete: number; needsAttention: number };
      earnings: { pendingTotal: string; asset: string };
      exit: { blocking: boolean; hint: string };
      paths: { earningDir: string; dbPath: string };
    };
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
    const cmd = createStatusCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd, { argv: ['--configt', 'bad.json'] });
    const parsed = envelopes[0] as { code: string };
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('renders human output (--human flag emits plain text, not JSON)', async () => {
    const cmd = createStatusCommand(fakeDeps);
    const { raw, exits } = await runCommand(cmd, { argv: ['--human'], tty: true });
    const out = raw.join('');
    expect(out).toContain('daemon=running');
    expect(out).not.toMatch(/^\{/);
    expect(exits).toEqual([]);
  });

  // ── --detail flag (audit U4) ─────────────────────────────────────────────

  it('--detail omitted: no detail key in JSON output', async () => {
    const cmd = createStatusCommand(fakeDeps);
    const { envelopes } = await runCommand(cmd);
    const payload = envelopes[0] as Record<string, unknown>;
    expect(payload['detail']).toBeUndefined();
  });

  it('--detail: includes detail block in JSON output', async () => {
    const cmd = createStatusCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd, { argv: ['--detail'] });
    expect(exits).toEqual([]);
    const payload = envelopes[0] as {
      detail: {
        lastBootstrapStep: string | null;
        fleetUpdatedAt: string | null;
        lastDaemonEvent: unknown;
        lastClaudeSession: unknown;
        lastChainTx: string | null;
        nextActions: string[];
      };
    };
    expect(payload.detail).toBeDefined();
    // fleet has one incomplete service (service_staked) so lastBootstrapStep is not 'complete'
    expect(payload.detail.lastBootstrapStep).toBe('service_staked');
    expect(Array.isArray(payload.detail.nextActions)).toBe(true);
    expect(payload.detail.nextActions.length).toBeGreaterThan(0);
  });

  it('--detail --human: includes readable detail section', async () => {
    const cmd = createStatusCommand(fakeDeps);
    const { raw, exits } = await runCommand(cmd, { argv: ['--detail', '--human'], tty: true });
    expect(exits).toEqual([]);
    const out = raw.join('');
    expect(out).toContain('--- detail ---');
    expect(out).toContain('bootstrap:');
    expect(out).toContain('next actions:');
  });
});
