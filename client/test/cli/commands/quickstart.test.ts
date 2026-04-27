import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';
import { createQuickstartCommand } from '../../../src/cli/commands/quickstart.js';
import type { QuickstartDeps } from '../../../src/cli/commands/quickstart.js';
import { makeCommandCtx } from '@test/cli.js';

function makeFakeDeps(overrides: Partial<QuickstartDeps> = {}): QuickstartDeps {
  return {
    loadConfig: vi.fn(() => ({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      apiPort: 7331,
    })) as unknown as QuickstartDeps['loadConfig'],
    getConfigPathFromArgs: vi.fn(() => undefined) as unknown as QuickstartDeps['getConfigPathFromArgs'],
    checkRpcNetwork: vi.fn(async () => ({ ok: true as const })) as unknown as QuickstartDeps['checkRpcNetwork'],
    rpcNetworkFailureHint: vi.fn(() => 'fix rpc') as unknown as QuickstartDeps['rpcNetworkFailureHint'],
    checkApiPortAvailable: vi.fn(async () => ({ ok: true as const, port: 7331 })) as unknown as QuickstartDeps['checkApiPortAvailable'],
    apiPortFailureMessage: vi.fn((r: { port: number }) => `Port ${r.port} is already in use.`) as unknown as QuickstartDeps['apiPortFailureMessage'],
    mainFn: vi.fn(async () => ({})),
    initRun: vi.fn(),
    bootstrapRun: vi.fn(),
    doctorRun: vi.fn(),
    passwordFileIO: {
      exists: vi.fn(() => false),
      read: vi.fn(() => ''),
      write: vi.fn(),
      ensureDir: vi.fn(),
    },
    randomBytesFn: vi.fn(() => Buffer.from('deadbeef'.repeat(8), 'hex')),
    ...overrides,
  };
}

describe('quickstart command', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('passes --config through to bootstrap and disables faucet retries while polling', async () => {
    vi.useFakeTimers();

    const fakeDeps = makeFakeDeps({
      loadConfig: vi.fn(() => ({ apiPort: 9555, network: 'testnet', rpcUrl: 'https://sepolia.base.org' })) as unknown as QuickstartDeps['loadConfig'],
      checkApiPortAvailable: vi.fn(async () => ({ ok: true as const, port: 9555 })) as unknown as QuickstartDeps['checkApiPortAvailable'],
      doctorRun: vi.fn(async (ctx: CommandContext) => {
        ctx.writer.write(JSON.stringify({ ok: true, blockingCount: 0, checks: [] }));
      }),
      initRun: vi.fn(async (ctx: CommandContext) => {
        ctx.writer.write(JSON.stringify({ master: '0xmaster' }));
        ctx.exit(0);
      }),
      bootstrapRun: vi.fn()
        .mockImplementationOnce(async (ctx: CommandContext) => {
          ctx.writer.write(JSON.stringify({
            code: 'funding_required',
            details: { address: '0xmaster' },
            hint: 'Fund the wallet.',
          }));
          ctx.exit(10);
        })
        .mockImplementationOnce(async (ctx: CommandContext) => {
          ctx.writer.write(JSON.stringify({ ok: true }));
          ctx.exit(0);
        }) as unknown as QuickstartDeps['bootstrapRun'],
    });

    const quickstart = createQuickstartCommand(fakeDeps);
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--config', '/tmp/custom.json', '--no-daemon'], env: { JINN_PASSWORD: 'test-password' } });

    const runPromise = quickstart.run(ctx);
    await vi.advanceTimersByTimeAsync(15_000);
    await runPromise;

    expect(fakeDeps.bootstrapRun).toHaveBeenCalledTimes(2);
    expect(fakeDeps.checkApiPortAvailable).not.toHaveBeenCalled();
    expect((fakeDeps.bootstrapRun as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      argv: ['--json', '--config', '/tmp/custom.json'],
      env: expect.objectContaining({ JINN_PASSWORD: 'test-password' }),
    });
    expect((fakeDeps.bootstrapRun as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toMatchObject({
      argv: ['--json', '--config', '/tmp/custom.json'],
      env: expect.objectContaining({
        JINN_PASSWORD: 'test-password',
        JINN_DISABLE_TESTNET_FAUCET: '1',
      }),
    });

    expect(exits).toEqual([]);
    const payload = JSON.parse(writes[writes.length - 1] ?? '{}');
    expect(payload.status).toBe('ready');
    expect(payload.dashboardUrl).toBe('http://127.0.0.1:9555');
  });

  it('fails before bootstrap when daemon mode needs an occupied api port', async () => {
    const fakeDeps = makeFakeDeps({
      loadConfig: vi.fn(() => ({ apiPort: 7331, network: 'testnet', rpcUrl: 'https://sepolia.base.org' })) as unknown as QuickstartDeps['loadConfig'],
      checkApiPortAvailable: vi.fn(async () => ({ ok: false as const, port: 7331, code: 'EADDRINUSE', message: 'in use' })) as unknown as QuickstartDeps['checkApiPortAvailable'],
    });

    const quickstart = createQuickstartCommand(fakeDeps);
    const { ctx, writes, exits } = makeCommandCtx({ argv: [], env: { JINN_PASSWORD: 'test-password' } });
    await quickstart.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1] ?? '{}');
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details).toMatchObject({ field: 'apiPort', port: 7331 });
    expect(fakeDeps.bootstrapRun).not.toHaveBeenCalled();
    expect(exits).toEqual([11]);
  });
});
