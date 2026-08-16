import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDoctorCommand } from '@/cli/commands/doctor.js';
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

const fakeDeps = {
  loadConfig: () => ({
    network: 'testnet' as const,
    rpcUrl: 'http://fake',
    apiPort: 7331,
    claudePath: 'claude',
    tasks: [],
    engine: { implStateDirRoot: '/tmp/fake-impl-state', workingDirRoot: '/tmp/fake-work' },
    earningDir: '/tmp/fake-earning',
    dbPath: '/tmp/fake.db',
    runtimeMode: undefined,
  } as any),
  getConfigPathFromArgs: () => undefined,
  checkClaudeBinary: async () => ({ ok: true, detail: 'fake claude binary' } as any),
  checkRpcNetwork: async () => ({
    ok: true,
    network: 'testnet' as const,
    expectedChainId: 84532,
    actualChainId: 84532,
    rpcHost: 'fake',
  }),
  rpcNetworkFailureHint: () => 'unused',
  runPortfolioV0DoctorChecks: () => [],
  checkDistributorReachable: async () => null,
  detectAuthContext: () => 'bare' as const,
  probeClaudeAuth: () => ({
    authenticated: true,
    context: 'bare' as const,
    detail: 'fake claude auth',
  }),
  resolveTaskNativeReadiness: () => ({
    ok: true,
    solverReady: true,
    evaluatorReady: true,
    evaluatorRoleReady: true,
    distinctEvaluatorServiceReady: true,
    detail: 'fake Task-native deployment ready; solver-ready=true evaluator-ready=true',
    source: '/tmp/deployment-task-coordinator-router-v3-baseSepolia-fast.json',
    contracts: {
      taskCoordinator: '0x1111111111111111111111111111111111111111',
      jinnRouterV3: '0x2222222222222222222222222222222222222222',
      taskActivityCheckerV3: '0x3333333333333333333333333333333333333333',
    },
    routerClaimDeliveryVersion: 'v3' as const,
  }),
} as const;

describe('doctor command (DI integration)', () => {
  it('emits a well-formed envelope and rpc_network passes when the rpc check succeeds', async () => {
    const cmd = createDoctorCommand(fakeDeps);
    const { envelopes, exits } = await runCommand(cmd);
    expect(exits).toEqual([]);
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0] as { schemaVersion: number; ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(env.schemaVersion).toBe(1);
    expect(typeof env.ok).toBe('boolean');
    expect(env.checks.length).toBeGreaterThan(0);
    // The injected rpc check passes — verify rpc_network is ok in the output
    const rpcCheck = env.checks.find(c => c.name === 'rpc_network');
    expect(rpcCheck).toBeDefined();
    expect(rpcCheck!.ok).toBe(true);
  });

  it('emits ok=false when rpc-network check fails', async () => {
    const cmd = createDoctorCommand({
      ...fakeDeps,
      checkRpcNetwork: async () => ({
        ok: false,
        network: 'testnet' as const,
        expectedChainId: 84532,
        actualChainId: 1,
        rpcHost: 'fake',
        reason: 'chain_mismatch' as const,
        message: 'chain mismatch',
      }),
      rpcNetworkFailureHint: () => 'set rpcUrl',
    });
    const { envelopes } = await runCommand(cmd);
    expect((envelopes[0] as { ok: boolean }).ok).toBe(false);
  });

  it('includes a config provenance block in the success payload', async () => {
    const cmd = createDoctorCommand(fakeDeps);
    const { envelopes } = await runCommand(cmd);
    const env = envelopes[0] as {
      config?: {
        configLoaded: boolean;
        configPath: string | null;
        network: string;
        earningDir: string;
        dbPath: string;
        runtimeMode: string | null;
        envOverrides: Record<string, string>;
      };
    };
    expect(env.config).toBeDefined();
    expect(typeof env.config!.configLoaded).toBe('boolean');
    expect(env.config!.network).toMatch(/^(testnet|mainnet)$/);
    expect(typeof env.config!.earningDir).toBe('string');
    expect(typeof env.config!.dbPath).toBe('string');
    expect(env.config!.envOverrides).toBeDefined();
  });

  it('reports Task-native solver and evaluator readiness from local deployment config', async () => {
    const cmd = createDoctorCommand(fakeDeps);
    const { envelopes } = await runCommand(cmd);
    const env = envelopes[0] as {
      checks: Array<{
        name: string;
        ok: boolean;
        taskNative?: {
          solverReady: boolean;
          evaluatorReady: boolean;
          contracts: Record<string, string>;
          routerClaimDeliveryVersion?: string;
        };
      }>;
    };
    const check = env.checks.find((c) => c.name === 'task_native_deployment');
    expect(check).toBeDefined();
    expect(check?.ok).toBe(true);
    expect(check?.taskNative?.solverReady).toBe(true);
    expect(check?.taskNative?.evaluatorReady).toBe(true);
    expect(check?.taskNative?.contracts.jinnRouterV3).toBe('0x2222222222222222222222222222222222222222');
    expect(check?.taskNative?.routerClaimDeliveryVersion).toBe('v3');
  });

  it('flags stale legacy router claim config in the real Task-native readiness check', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-doctor-task-native-'));
    const prevClaimVersion = process.env['JINN_ROUTER_CLAIM_DELIVERY_VERSION'];
    process.env['JINN_ROUTER_CLAIM_DELIVERY_VERSION'] = 'v2';
    try {
      writeFleetState(earningDir, [
        service(
          1,
          '0x1111111111111111111111111111111111111111',
          '0x2222222222222222222222222222222222222222',
        ),
      ]);
      const { resolveTaskNativeReadiness: _unused, ...deps } = fakeDeps;
      const cmd = createDoctorCommand({
        ...deps,
        loadConfig: () => ({
          network: 'testnet' as const,
          rpcUrl: 'http://fake',
          apiPort: 7331,
          claudePath: 'claude',
          tasks: [],
          engine: { implStateDirRoot: '/tmp/fake-impl-state', workingDirRoot: '/tmp/fake-work' },
          earningDir,
          dbPath: '/tmp/fake.db',
          runtimeMode: undefined,
        } as any),
      });
      const { envelopes } = await runCommand(cmd);
      const env = envelopes[0] as {
        checks: Array<{ name: string; ok: boolean; detail: string; taskNative?: { solverReady: boolean; evaluatorReady: boolean } }>;
      };
      const check = env.checks.find((c) => c.name === 'task_native_deployment');
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('router claim variant is v2, expected v3');
      expect(check?.taskNative?.solverReady).toBe(false);
      expect(check?.taskNative?.evaluatorReady).toBe(false);
    } finally {
      if (prevClaimVersion === undefined) {
        delete process.env['JINN_ROUTER_CLAIM_DELIVERY_VERSION'];
      } else {
        process.env['JINN_ROUTER_CLAIM_DELIVERY_VERSION'] = prevClaimVersion;
      }
      rmSync(earningDir, { recursive: true, force: true });
    }
  });

  it('does not include JINN_PASSWORD in config.envOverrides even when set in ctx.env', async () => {
    const cmd = createDoctorCommand(fakeDeps);
    const { envelopes } = await runCommand(cmd, {
      env: { JINN_PASSWORD: 'secret', JINN_RPC_URL: 'http://fake' },
    });
    const env = envelopes[0] as {
      config?: { envOverrides: Record<string, string> };
    };
    expect(env.config).toBeDefined();
    expect('JINN_PASSWORD' in env.config!.envOverrides).toBe(false);
    // JINN_RPC_URL was set so it should appear
    expect(env.config!.envOverrides['JINN_RPC_URL']).toBe('set');
  });
});
