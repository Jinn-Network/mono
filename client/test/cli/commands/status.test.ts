import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatheredStatusRaw } from '../../../src/api/status-build.js';
import { createStatusCommand } from '@/cli/commands/status.js';
import { assembleStatusRollupV1 } from '@/api/status-rollup-build.js';
import { runCommand } from '@test/cli.js';

function writeFleetState(earningDir: string, services: unknown[]): void {
  mkdirSync(earningDir, { recursive: true });
  writeFileSync(
    join(earningDir, 'earning_state.json'),
    JSON.stringify({
      master_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      services,
      updated_at: '2026-05-03T00:00:00.000Z',
    }),
    'utf8',
  );
}

function service(index: number, safe: string, mech: string): unknown {
  return {
    index,
    agent_address: `0x${String(index).repeat(40)}`,
    safe_address: safe,
    service_id: 100 + index,
    mech_address: mech,
    staking_address: '0x5555555555555555555555555555555555555555',
    step: 'complete',
    error: null,
    agent_id: String(index),
    agent_uri: null,
    identity_registry_address: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    agent_registered_tx: null,
    safe_bound_to_agent: false,
  };
}

function realReadinessDeps(earningDir: string, roles: Array<'solving' | 'evaluating'> = ['solving', 'evaluating']) {
  const { resolveTaskNativeReadiness: _unused, ...deps } = fakeDeps;
  const evaluatorEnabled = roles.includes('evaluating');
  return {
    ...deps,
    loadConfig: () => ({
      network: 'testnet' as const,
      earningDir,
      dbPath: '/tmp/x',
      runtimeMode: undefined,
      evaluator: { enabled: evaluatorEnabled },
      executionWiring: [{
        workKind: 'swe-rebench-v2.v1',
        harness: evaluatorEnabled ? 'swe-rebench-v2-evaluator' : 'codex-code-learner',
        model: 'claude-haiku-4-5-20251001',
        plugins: [],
        credentialRef: 'codex-code-learner-default',
        isolationPolicy: 'process',
      }],
    } as any),
  };
}

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
  loadConfig: () => ({
    network: 'testnet' as const,
    earningDir: '/tmp/earning',
    dbPath: '/tmp/x',
    runtimeMode: undefined,
  } as any),
  getConfigPathFromArgs: () => undefined,
  resolveTaskNativeReadiness: () => ({
    ok: true,
    solverReady: true,
    evaluatorReady: true,
    evaluatorRoleReady: true,
    distinctEvaluatorServiceReady: true,
    detail: 'fake Task-native deployment ready',
    source: '/tmp/deployment-task-coordinator-router-v3-baseSepolia-fast.json',
    contracts: {
      taskCoordinator: '0x1111111111111111111111111111111111111111',
      jinnRouterV3: '0x2222222222222222222222222222222222222222',
      taskActivityCheckerV3: '0x3333333333333333333333333333333333333333',
    },
    routerClaimDeliveryVersion: 'v3' as const,
  }),
};

describe('status command', () => {
  it('emits the §4.1 roll-up shape with daemon/rpc/fleet/exit', async () => {
    const cmd = createStatusCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const parsed = envelopes[0] as {
      schemaVersion: number;
      daemon: { state: string; startedAt: string; network: string };
      rpc: { ok: boolean; chainId: number };
      fleet: { size: number; complete: number; needsAttention: number };
      exit: { blocking: boolean; hint: string };
      paths: { earningDir: string; dbPath: string };
      taskNative: {
        solverReady: boolean;
        evaluatorReady: boolean;
        evaluatorRoleReady: boolean;
        distinctEvaluatorServiceReady: boolean;
        contracts: Record<string, string>;
      };
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
    expect(parsed.exit.blocking).toBe(true);
    expect(parsed.exit.hint).toContain('fleet');
    expect(parsed.paths).toEqual({
      earningDir: '/tmp/earning',
      dbPath: '/tmp/x',
    });
    expect(parsed.taskNative.solverReady).toBe(true);
    expect(parsed.taskNative.evaluatorReady).toBe(true);
    expect(parsed.taskNative.evaluatorRoleReady).toBe(true);
    expect(parsed.taskNative.distinctEvaluatorServiceReady).toBe(true);
    expect(parsed.taskNative.contracts.jinnRouterV3).toBe('0x2222222222222222222222222222222222222222');
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
    expect(out).toContain('task-native: solver=ready evaluator=ready');
    expect(out).not.toMatch(/^\{/);
    expect(exits).toEqual([]);
  });

  it('reports Task-native solver and evaluator ready from bundled config plus distinct local services', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-status-task-native-'));
    try {
      writeFleetState(earningDir, [
        service(
          1,
          '0x1111111111111111111111111111111111111111',
          '0x2222222222222222222222222222222222222222',
        ),
        service(
          2,
          '0x3333333333333333333333333333333333333333',
          '0x4444444444444444444444444444444444444444',
        ),
      ]);
      const cmd = createStatusCommand(realReadinessDeps(earningDir));
      const { envelopes } = await runCommand(cmd);
      const payload = envelopes[0] as {
        taskNative: {
          ok: boolean;
          solverReady: boolean;
          evaluatorReady: boolean;
          evaluatorRoleReady: boolean;
          distinctEvaluatorServiceReady: boolean;
          contracts: Record<string, string>;
          operatorState?: { taskNativeServices: number; activeSafe?: string; evaluatorSafe?: string };
        };
      };
      expect(payload.taskNative.ok).toBe(true);
      expect(payload.taskNative.solverReady).toBe(true);
      expect(payload.taskNative.evaluatorReady).toBe(true);
      expect(payload.taskNative.evaluatorRoleReady).toBe(true);
      expect(payload.taskNative.distinctEvaluatorServiceReady).toBe(true);
      expect(payload.taskNative.contracts.taskCoordinator).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(payload.taskNative.contracts.jinnRouterV3).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(payload.taskNative.contracts.taskActivityCheckerV3).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(payload.taskNative.operatorState?.taskNativeServices).toBe(2);
      expect(payload.taskNative.operatorState?.activeSafe).toBe('0x1111111111111111111111111111111111111111');
      expect(payload.taskNative.operatorState?.evaluatorSafe).toBe('0x3333333333333333333333333333333333333333');
    } finally {
      rmSync(earningDir, { recursive: true, force: true });
    }
  });

  it('reports evaluator-ready same-service topology when no distinct evaluator service exists', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-status-task-native-'));
    try {
      writeFleetState(earningDir, [
        service(
          1,
          '0x1111111111111111111111111111111111111111',
          '0x2222222222222222222222222222222222222222',
        ),
      ]);
      const cmd = createStatusCommand(realReadinessDeps(earningDir));
      const { envelopes, raw } = await runCommand(cmd, { argv: ['--human'], tty: true });
      expect(envelopes).toEqual([]);
      const out = raw.join('');
      expect(out).toContain('task-native: solver=ready evaluator=ready');
      expect(out).toContain('evaluator-topology=same-service');
      expect(out).not.toContain('self-evaluation is disabled');

      const jsonCmd = createStatusCommand(realReadinessDeps(earningDir));
      const jsonResult = await runCommand(jsonCmd);
      const payload = jsonResult.envelopes[0] as {
        taskNative: {
          ok: boolean;
          solverReady: boolean;
          evaluatorReady: boolean;
          evaluatorRoleReady: boolean;
          distinctEvaluatorServiceReady: boolean;
          detail: string;
        };
      };
      expect(payload.taskNative.ok).toBe(true);
      expect(payload.taskNative.solverReady).toBe(true);
      expect(payload.taskNative.evaluatorReady).toBe(true);
      expect(payload.taskNative.evaluatorRoleReady).toBe(true);
      expect(payload.taskNative.distinctEvaluatorServiceReady).toBe(false);
      expect(payload.taskNative.detail).toContain('evaluator-topology=same-service');
    } finally {
      rmSync(earningDir, { recursive: true, force: true });
    }
  });

  it('reports evaluator not-ready when the operator has no evaluator role', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-status-task-native-'));
    try {
      writeFleetState(earningDir, [
        service(
          1,
          '0x1111111111111111111111111111111111111111',
          '0x2222222222222222222222222222222222222222',
        ),
      ]);
      const cmd = createStatusCommand(realReadinessDeps(earningDir, ['solving']));
      const { envelopes, raw } = await runCommand(cmd, { argv: ['--human'], tty: true });
      expect(envelopes).toEqual([]);
      const out = raw.join('');
      expect(out).toContain('task-native: solver=ready evaluator=not-ready');
      expect(out).toContain('operator has not joined any evaluator role');

      const jsonCmd = createStatusCommand(realReadinessDeps(earningDir, ['solving']));
      const jsonResult = await runCommand(jsonCmd);
      const payload = jsonResult.envelopes[0] as {
        taskNative: {
          solverReady: boolean;
          evaluatorReady: boolean;
          evaluatorRoleReady: boolean;
          distinctEvaluatorServiceReady: boolean;
        };
      };
      expect(payload.taskNative.solverReady).toBe(true);
      expect(payload.taskNative.evaluatorReady).toBe(false);
      expect(payload.taskNative.evaluatorRoleReady).toBe(false);
      expect(payload.taskNative.distinctEvaluatorServiceReady).toBe(false);
    } finally {
      rmSync(earningDir, { recursive: true, force: true });
    }
  });

  it('reports missing Task-native artifact without chain readback', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-status-task-native-'));
    const prevArtifact = process.env['JINN_TESTNET_TASK_COORDINATOR_ROUTER_V3_DEPLOYMENT'];
    process.env['JINN_TESTNET_TASK_COORDINATOR_ROUTER_V3_DEPLOYMENT'] = join(earningDir, 'missing-task-native.json');
    try {
      writeFleetState(earningDir, [
        service(
          1,
          '0x1111111111111111111111111111111111111111',
          '0x2222222222222222222222222222222222222222',
        ),
      ]);
      const cmd = createStatusCommand(realReadinessDeps(earningDir));
      const { envelopes } = await runCommand(cmd);
      const payload = envelopes[0] as {
        taskNative: { ok: boolean; solverReady: boolean; evaluatorReady: boolean; detail: string; contracts: Record<string, string> };
      };
      expect(payload.taskNative.ok).toBe(false);
      expect(payload.taskNative.solverReady).toBe(false);
      expect(payload.taskNative.evaluatorReady).toBe(false);
      expect(payload.taskNative.detail).toContain('Task-native deployment artifact is not bundled');
      expect(payload.taskNative.contracts).toEqual({});
    } finally {
      if (prevArtifact === undefined) {
        delete process.env['JINN_TESTNET_TASK_COORDINATOR_ROUTER_V3_DEPLOYMENT'];
      } else {
        process.env['JINN_TESTNET_TASK_COORDINATOR_ROUTER_V3_DEPLOYMENT'] = prevArtifact;
      }
      rmSync(earningDir, { recursive: true, force: true });
    }
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
