import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

const runInitMock = vi.fn();
const runBootstrapMock = vi.fn();
const loadConfigMock = vi.fn();
const mainMock = vi.fn();

vi.mock('../../../src/cli/commands/init.js', () => ({
  default: {
    name: 'init',
    summary: '',
    helpText: '',
    run: runInitMock,
  },
}));

vi.mock('../../../src/cli/commands/bootstrap.js', () => ({
  default: {
    name: 'bootstrap',
    summary: '',
    helpText: '',
    run: runBootstrapMock,
  },
}));

vi.mock('../../../src/config.js', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../../src/main.js', () => ({
  main: mainMock,
}));

function makeCtx(argv: string[] = [], env: Record<string, string> = { JINN_PASSWORD: 'test-password' }): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    ctx: {
      argv,
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: (code: number) => { exits.push(code); },
      env,
    },
    writes,
    exits,
  };
}

describe('quickstart command', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('passes --config through to bootstrap and disables faucet retries while polling', async () => {
    vi.useFakeTimers();

    runInitMock.mockImplementation(async (ctx: CommandContext) => {
      ctx.writer.write(JSON.stringify({ master: '0xmaster' }));
      ctx.exit(0);
    });

    runBootstrapMock
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
      });

    loadConfigMock.mockReturnValue({ apiPort: 9555 });

    const { default: quickstart } = await import('../../../src/cli/commands/quickstart.js');
    const { ctx, writes, exits } = makeCtx(['--config', '/tmp/custom.json', '--no-daemon']);

    const runPromise = quickstart.run(ctx);
    await vi.advanceTimersByTimeAsync(15_000);
    await runPromise;

    expect(runBootstrapMock).toHaveBeenCalledTimes(2);
    expect(runBootstrapMock.mock.calls[0]?.[0]).toMatchObject({
      argv: ['--json', '--config', '/tmp/custom.json'],
      env: expect.objectContaining({ JINN_PASSWORD: 'test-password' }),
    });
    expect(runBootstrapMock.mock.calls[1]?.[0]).toMatchObject({
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
});
