import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

const loadConfigMock = vi.fn(() => ({
  network: 'testnet',
  rpcUrl: 'https://sepolia.base.org',
  apiPort: 7331,
}));
const checkRpcNetworkMock = vi.fn(async () => ({ ok: true }));
const checkApiPortAvailableMock = vi.fn(async () => ({ ok: true, port: 7331 }));

vi.mock('../../../src/config.js', () => ({
  loadConfig: loadConfigMock,
  getConfigPathFromArgs: vi.fn(() => undefined),
}));

vi.mock('../../../src/preflight/rpc-network.js', () => ({
  checkRpcNetwork: checkRpcNetworkMock,
  rpcNetworkFailureHint: () => 'fix rpc',
}));

vi.mock('../../../src/preflight/api-port.js', () => ({
  checkApiPortAvailable: checkApiPortAvailableMock,
  apiPortFailureMessage: (r: { port: number }) => `Port ${r.port} is already in use.`,
}));

vi.mock('../../../src/main.js', () => ({
  main: vi.fn(async () => ({
    schemaVersion: 1,
    generatedAt: '2026-04-15T00:00:00.000Z',
    kind: 'daemon_started',
    pid: 123,
    network: 'testnet',
    phase: 'phase-1b',
    apiPort: 7331,
    masterAddress: '0xmaster',
    safeAddress: '0xsafe',
    mechAddress: '0xmech',
    serviceIndex: 1,
    serviceId: 7,
  })),
}));

function makeCtx(env: Record<string, string> = { JINN_PASSWORD: 'test' }): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env,
  };
  return { ctx, writes, exits };
}

describe('run command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      apiPort: 7331,
    });
    checkRpcNetworkMock.mockResolvedValue({ ok: true });
    checkApiPortAvailableMock.mockResolvedValue({ ok: true, port: 7331 });
  });

  it('requires JINN_PASSWORD', async () => {
    const { default: run } = await import('../../../src/cli/commands/run.js');
    const { ctx, writes, exits } = makeCtx({});
    await run.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('delegates to main() when JINN_PASSWORD is set', async () => {
    const { default: run } = await import('../../../src/cli/commands/run.js');
    const { main } = await import('../../../src/main.js');
    const { ctx, writes } = makeCtx();
    await run.run(ctx);
    expect(main).toHaveBeenCalled();
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.kind).toBe('daemon_started');
  });

  it('fails before main() when api port is occupied', async () => {
    checkApiPortAvailableMock.mockResolvedValueOnce({ ok: false, port: 7331, code: 'EADDRINUSE', message: 'in use' });
    const { default: run } = await import('../../../src/cli/commands/run.js');
    const { main } = await import('../../../src/main.js');
    const { ctx, writes, exits } = makeCtx();
    await run.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details).toMatchObject({ field: 'apiPort', port: 7331 });
    expect(main).not.toHaveBeenCalled();
    expect(exits).toEqual([11]);
  });
});
