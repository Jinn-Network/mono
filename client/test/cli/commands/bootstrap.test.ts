import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

const bootstrapReturn = vi.hoisted(() => ({
  val: {
    ok: false as boolean,
    funding: {
      master_address: '0xabc',
      eth_required: '1000',
      eth_balance: '500',
    },
    message: 'need more eth',
    fleet_state: { master_address: '0xabc', services: [] as Array<{ index: number; step: string; service_id?: number }> },
  },
}));

const passwordResult = vi.hoisted(() => ({
  val:
    { ok: true as const, password: 'test' } as
      | { ok: true; password: string }
      | { ok: false; message: string },
}));

const loadConfigMock = vi.fn();
const checkRpcNetworkMock = vi.fn();
const logRpcLocalDevToStderrMock = vi.hoisted(() => vi.fn());
let constructorOptions: Record<string, unknown> | undefined;

vi.mock('../../../src/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../../src/preflight/rpc-network.js', () => ({
  checkRpcNetwork: checkRpcNetworkMock,
  logRpcLocalDevToStderr: logRpcLocalDevToStderrMock,
  rpcNetworkFailureHint: () => 'fix rpc',
}));

vi.mock('../../../src/earning/bootstrap.js', () => ({
  FleetBootstrapper: class {
    constructor(options: Record<string, unknown>) {
      constructorOptions = options;
    }

    async bootstrap() {
      return { ...bootstrapReturn.val };
    }
  },
}));

vi.mock('../../../src/cli/password.js', () => ({
  resolveCliPassword: vi.fn(() => passwordResult.val),
}));

function makeCtx(
  env: Record<string, string> = { JINN_PASSWORD: 'test' },
  opts: { stdoutIsTty?: boolean; argv?: string[] } = {},
): {
  ctx: CommandContext; writes: string[]; exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: opts.argv ?? [],
    stdoutIsTty: opts.stdoutIsTty ?? false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env,
  };
  return { ctx, writes, exits };
}

describe('bootstrap command', () => {
  beforeEach(() => {
    checkRpcNetworkMock.mockResolvedValue({
      ok: true,
      network: 'testnet',
      expectedChainId: 84532,
      actualChainId: 84532,
      rpcHost: '127.0.0.1:8545',
    });
    loadConfigMock.mockReturnValue({
      earningDir: '/tmp/earning',
      network: 'testnet',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      targetServices: 1,
      debug: false,
      pollIntervalMs: 5000,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    constructorOptions = undefined;
  });

  it('emits funding_required envelope and exits 10 when bootstrap returns funding', async () => {
    passwordResult.val = { ok: true, password: 'test' };
    bootstrapReturn.val = {
      ok: false,
      funding: {
        master_address: '0xabc',
        eth_required: '1000',
        eth_balance: '500',
      },
      message: 'need more eth',
      fleet_state: { master_address: '0xabc', services: [] },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx();
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

  it('emits invalid_invocation exit 11 when password env is missing', async () => {
    passwordResult.val = {
      ok: false,
      message: 'Set JINN_PASSWORD or pass --password-fd N with a readable file descriptor.',
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx({});
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.exitCode).toBe(11);
    expect(parsed.details?.field).toBe('keystore password');
    expect(exits).toEqual([11]);
  });

  it('accepts --password-fd when password env is missing', async () => {
    passwordResult.val = { ok: true, password: 'from-fd' };
    bootstrapReturn.val = {
      ok: false,
      funding: {
        master_address: '0xabc',
        eth_required: '1000',
        eth_balance: '500',
      },
      message: 'need more eth',
      fleet_state: { master_address: '0xabc', services: [] },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx({}, { argv: ['--password-fd', '0'] });
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('funding_required');
    expect(exits).toEqual([10]);
  });

  it('emits JSON success on non-TTY even without --json', async () => {
    passwordResult.val = { ok: true, password: 'test' };
    bootstrapReturn.val = {
      ok: true,
      message: 'ok',
      fleet_state: {
        master_address: '0xmaster',
        services: [{ index: 0, step: 'complete', service_id: 7 }],
      },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx();
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.master).toBe('0xmaster');
    expect(parsed.services).toEqual([{ index: 0, step: 'complete', serviceId: 7 }]);
    expect(exits).toEqual([0]);
  });

  it('does not write local-dev preflight notice to stdout; uses logRpcLocalDevToStderr', async () => {
    checkRpcNetworkMock.mockResolvedValueOnce({
      ok: true,
      network: 'testnet',
      expectedChainId: 84532,
      actualChainId: 31337,
      rpcHost: '127.0.0.1:8545',
      localDev: true,
    });
    passwordResult.val = { ok: true, password: 'test' };
    bootstrapReturn.val = {
      ok: true,
      message: 'ok',
      fleet_state: {
        master_address: '0xmaster',
        services: [],
      },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx();
    await bootstrap.run(ctx);
    expect(logRpcLocalDevToStderrMock).toHaveBeenCalledWith(
      expect.objectContaining({
        localDev: true,
        actualChainId: 31337,
      }),
    );
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).schemaVersion).toBe(1);
    expect(writes[0].trimStart().startsWith('{')).toBe(true);
    expect(exits).toEqual([0]);
  });

  it('emits JSON success on TTY without flags', async () => {
    passwordResult.val = { ok: true, password: 'test' };
    bootstrapReturn.val = {
      ok: true,
      message: 'ok',
      fleet_state: {
        master_address: '0xmaster',
        services: [{ index: 0, step: 'complete', service_id: 7 }],
      },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx(undefined, { stdoutIsTty: true });
    await bootstrap.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.master).toBe('0xmaster');
    expect(exits).toEqual([0]);
  });

  it('emits human success summary on TTY when --human is set', async () => {
    passwordResult.val = { ok: true, password: 'test' };
    bootstrapReturn.val = {
      ok: true,
      message: 'ok',
      fleet_state: {
        master_address: '0xaaa',
        services: [],
      },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx(undefined, { stdoutIsTty: true, argv: ['--human'] });
    await bootstrap.run(ctx);
    const out = writes[writes.length - 1];
    expect(out).toContain('Bootstrap complete.');
    expect(out).toContain('0xaaa');
    expect(exits).toEqual([0]);
  });

  it('passes the command env into FleetBootstrapper', async () => {
    passwordResult.val = { ok: true, password: 'test-password' };
    bootstrapReturn.val = {
      ok: true,
      message: 'ok',
      fleet_state: {
        master_address: '0xmaster',
        services: [],
      },
    };
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, exits } = makeCtx({
      JINN_PASSWORD: 'test-password',
      JINN_DISABLE_TESTNET_FAUCET: '1',
    }, { argv: ['--json'] });

    await bootstrap.run(ctx);

    expect(constructorOptions).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        JINN_PASSWORD: 'test-password',
        JINN_DISABLE_TESTNET_FAUCET: '1',
      }),
    }));
    expect(exits).toEqual([0]);
  });

  it('fails before constructing bootstrapper when rpc chain is mismatched', async () => {
    passwordResult.val = { ok: true, password: 'test' };
    checkRpcNetworkMock.mockResolvedValueOnce({
      ok: false,
      network: 'testnet',
      expectedChainId: 84532,
      actualChainId: 8453,
      rpcHost: 'mainnet.base.org',
      reason: 'chain_mismatch',
      message: 'RPC chain mismatch for testnet',
    });
    const { default: bootstrap } = await import('../../../src/cli/commands/bootstrap.js');
    const { ctx, writes, exits } = makeCtx();

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
    expect(constructorOptions).toBeUndefined();
    expect(exits).toEqual([11]);
  });
});
