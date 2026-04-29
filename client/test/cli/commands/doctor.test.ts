import { describe, it, expect } from 'vitest';
import { createDoctorCommand } from '@/cli/commands/doctor.js';
import { runCommand } from '@test/cli.js';

const fakeDeps = {
  loadConfig: () => ({
    network: 'testnet' as const,
    rpcUrl: 'http://fake',
    apiPort: 7331,
    claudePath: 'claude',
    desiredStates: [],
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
