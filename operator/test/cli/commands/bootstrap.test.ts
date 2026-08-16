import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBootstrapCommand, type BootstrapDeps } from '../../../src/cli/commands/bootstrap.js';
import { makeCommandCtx } from '@test/cli.js';

type BootstrapResult = {
  ok: boolean;
  funding?: { master_address: string; eth_required: string; eth_balance: string };
  message: string;
  fleet_state: { master_address: string; services: Array<{ index: number; step: string; service_id?: number }> };
};

type RpcResult =
  | { ok: true; network: string; expectedChainId: number; actualChainId: number; rpcHost: string; localDev?: boolean }
  | { ok: false; network: string; expectedChainId: number; actualChainId: number; rpcHost: string; reason: string; message: string };

const defaultRpcOk: RpcResult = {
  ok: true,
  network: 'testnet',
  expectedChainId: 84532,
  actualChainId: 84532,
  rpcHost: '127.0.0.1:8545',
};

const defaultConfig = {
  earningDir: '/tmp/earning',
  network: 'testnet',
  rpcUrl: 'http://127.0.0.1:8545',
  stakingMode: 'standard',
  targetServices: 1,
  debug: false,
  pollIntervalMs: 5000,
};

const defaultBootstrapResult: BootstrapResult = {
  ok: false,
  funding: {
    master_address: '0xabc',
    eth_required: '1000',
    eth_balance: '500',
  },
  message: 'need more eth',
  fleet_state: { master_address: '0xabc', services: [] },
};

function makeFakeDeps(
  overrides: {
    bootstrapResult?: BootstrapResult;
    rpcResult?: RpcResult;
    config?: Record<string, unknown>;
    passwordOk?: boolean;
    captureConstructorOptions?: (opts: Record<string, unknown>) => void;
  } = {},
): BootstrapDeps {
  const {
    bootstrapResult = defaultBootstrapResult,
    rpcResult = defaultRpcOk,
    config = defaultConfig,
    passwordOk = true,
    captureConstructorOptions,
  } = overrides;

  return {
    loadConfig: () => config as any,
    getConfigPathFromArgs: () => undefined,
    checkRpcNetwork: async () => rpcResult as any,
    rpcNetworkFailureHint: () => 'fix rpc',
    logRpcLocalDevToStderr: () => {},
    bootstrapperFactory: (cfg) => {
      if (captureConstructorOptions) {
        captureConstructorOptions(cfg as unknown as Record<string, unknown>);
      }
      return {
        bootstrap: async () => ({ ...bootstrapResult }),
      } as any;
    },
    resolveCliPassword: () =>
      passwordOk
        ? { ok: true as const, password: 'test' }
        : { ok: false as const, message: 'Set JINN_PASSWORD or pass --password-fd N with a readable file descriptor.' },
    checkDaemonGuard: () => ({ blocked: false, pid: null, pidfilePath: '', reason: 'not-running' as const }),
  };
}


let capturedConstructorOptions: Record<string, unknown> | undefined;

describe('bootstrap command', () => {
  beforeEach(() => {
    capturedConstructorOptions = undefined;
  });

  afterEach(() => {
    capturedConstructorOptions = undefined;
  });

  it('emits funding_required envelope and exits 10 when bootstrap returns funding', async () => {
    const bootstrap = createBootstrapCommand(makeFakeDeps({
      bootstrapResult: {
        ok: false,
        funding: { master_address: '0xabc', eth_required: '1000', eth_balance: '500' },
        message: 'need more eth',
        fleet_state: { master_address: '0xabc', services: [] },
      },
    }));
    const { ctx, writes, exits } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('funding_required');
    expect(parsed.exitCode).toBe(10);
    expect(parsed.details).toEqual({
      role: 'master',
      address: '0xabc',
      asset: 'native',
      needWei: '1000',
      haveWei: '500',
    });
    expect(exits).toEqual([10]);
  });

  it('emits invalid_invocation exit 11 and never bootstraps when the daemon guard blocks (#525/#562/#897)', async () => {
    let bootstrapperInvoked = false;
    const deps = makeFakeDeps();
    deps.checkDaemonGuard = () => ({
      blocked: true,
      pid: 4242,
      pidfilePath: '/tmp/earning/daemon.pid',
      reason: 'alive',
    });
    const originalFactory = deps.bootstrapperFactory;
    deps.bootstrapperFactory = (cfg) => {
      bootstrapperInvoked = true;
      return originalFactory(cfg);
    };
    const bootstrap = createBootstrapCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.exitCode).toBe(11);
    expect(parsed.message).toContain('4242');
    expect(parsed.details?.pid).toBe(4242);
    expect(exits).toEqual([11]);
    expect(bootstrapperInvoked).toBe(false);
  });

  it('emits invalid_invocation exit 11 when password env is missing', async () => {
    const bootstrap = createBootstrapCommand(makeFakeDeps({ passwordOk: false }));
    const { ctx, writes, exits } = makeCommandCtx({ env: {} });
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.exitCode).toBe(11);
    expect(parsed.details?.field).toBe('keystore password');
    expect(exits).toEqual([11]);
  });

  it('accepts --password-fd when password env is missing', async () => {
    const bootstrap = createBootstrapCommand(makeFakeDeps({
      bootstrapResult: {
        ok: false,
        funding: { master_address: '0xabc', eth_required: '1000', eth_balance: '500' },
        message: 'need more eth',
        fleet_state: { master_address: '0xabc', services: [] },
      },
    }));
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--password-fd', '0'], env: {} });
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('funding_required');
    expect(exits).toEqual([10]);
  });

  it('emits JSON success on non-TTY even without --json', async () => {
    const bootstrap = createBootstrapCommand(makeFakeDeps({
      bootstrapResult: {
        ok: true,
        message: 'ok',
        fleet_state: {
          master_address: '0xmaster',
          services: [{ index: 0, step: 'complete', service_id: 7 }],
        },
      },
    }));
    const { ctx, writes, exits } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.master).toBe('0xmaster');
    expect(parsed.services).toEqual([{ index: 0, step: 'complete', serviceId: 7 }]);
    expect(exits).toEqual([0]);
  });

  it('does not write local-dev preflight notice to stdout; uses logRpcLocalDevToStderr', async () => {
    let logRpcCalledWith: unknown;
    const bootstrap = createBootstrapCommand({
      ...makeFakeDeps({
        bootstrapResult: {
          ok: true,
          message: 'ok',
          fleet_state: { master_address: '0xmaster', services: [] },
        },
        rpcResult: {
          ok: true,
          network: 'testnet',
          expectedChainId: 84532,
          actualChainId: 31337,
          rpcHost: '127.0.0.1:8545',
          localDev: true,
        },
      }),
      logRpcLocalDevToStderr: (result) => { logRpcCalledWith = result; },
    });
    const { ctx, writes, exits } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await bootstrap.run(ctx);
    expect(logRpcCalledWith).toMatchObject({ localDev: true, actualChainId: 31337 });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).schemaVersion).toBe(1);
    expect(writes[0].trimStart().startsWith('{')).toBe(true);
    expect(exits).toEqual([0]);
  });

  it('emits JSON success on TTY without flags', async () => {
    const bootstrap = createBootstrapCommand(makeFakeDeps({
      bootstrapResult: {
        ok: true,
        message: 'ok',
        fleet_state: {
          master_address: '0xmaster',
          services: [{ index: 0, step: 'complete', service_id: 7 }],
        },
      },
    }));
    const { ctx, writes, exits } = makeCommandCtx({ tty: true, env: { JINN_PASSWORD: 'test' } });
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.master).toBe('0xmaster');
    expect(exits).toEqual([0]);
  });

  it('emits human success summary on TTY when --human is set', async () => {
    const bootstrap = createBootstrapCommand(makeFakeDeps({
      bootstrapResult: {
        ok: true,
        message: 'ok',
        fleet_state: { master_address: '0xaaa', services: [] },
      },
    }));
    const { ctx, writes, exits } = makeCommandCtx({ tty: true, argv: ['--human'], env: { JINN_PASSWORD: 'test' } });
    await bootstrap.run(ctx);
    const out = writes[writes.length - 1];
    expect(out).toContain('Bootstrap complete.');
    expect(out).toContain('0xaaa');
    expect(exits).toEqual([0]);
  });

  it('passes the command env into FleetBootstrapper', async () => {
    const bootstrap = createBootstrapCommand(makeFakeDeps({
      bootstrapResult: {
        ok: true,
        message: 'ok',
        fleet_state: { master_address: '0xmaster', services: [] },
      },
      captureConstructorOptions: (opts) => { capturedConstructorOptions = opts; },
    }));
    const { ctx, exits } = makeCommandCtx({
      argv: ['--json'],
      env: { JINN_PASSWORD: 'test-password', JINN_DISABLE_TESTNET_FAUCET: '1' },
    });

    await bootstrap.run(ctx);

    expect(capturedConstructorOptions).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        JINN_PASSWORD: 'test-password',
        JINN_DISABLE_TESTNET_FAUCET: '1',
      }),
    }));
    expect(exits).toEqual([0]);
  });

  it('fails before constructing bootstrapper when rpc chain is mismatched', async () => {
    let bootstrapperCreated = false;
    const deps = makeFakeDeps({
      rpcResult: {
        ok: false,
        network: 'testnet',
        expectedChainId: 84532,
        actualChainId: 8453,
        rpcHost: 'mainnet.base.org',
        reason: 'chain_mismatch',
        message: 'RPC chain mismatch for testnet',
      },
    });
    const bootstrap = createBootstrapCommand({
      ...deps,
      bootstrapperFactory: (cfg) => {
        bootstrapperCreated = true;
        return deps.bootstrapperFactory(cfg);
      },
    });
    const { ctx, writes, exits } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });

    await bootstrap.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details).toMatchObject({
      field: 'rpcUrl',
      network: 'testnet',
      expectedChainId: 84532,
      actualChainId: 8453,
      rpcHost: 'mainnet.base.org',
    });
    expect(bootstrapperCreated).toBe(false);
    expect(exits).toEqual([11]);
  });
});
