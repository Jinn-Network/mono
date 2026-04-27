import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunCommand } from '../../../src/cli/commands/run.js';
import { makeCommandCtx } from '@test/cli.js';
import type { RunDeps } from '../../../src/cli/commands/run.js';

function makeFakeDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    loadConfig: vi.fn(() => ({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      apiPort: 7331,
    })) as unknown as RunDeps['loadConfig'],
    getConfigPathFromArgs: vi.fn(() => undefined) as unknown as RunDeps['getConfigPathFromArgs'],
    checkRpcNetwork: vi.fn(async () => ({ ok: true as const })) as unknown as RunDeps['checkRpcNetwork'],
    rpcNetworkFailureHint: vi.fn(() => 'fix rpc') as unknown as RunDeps['rpcNetworkFailureHint'],
    checkApiPortAvailable: vi.fn(async () => ({ ok: true as const, port: 7331 })) as unknown as RunDeps['checkApiPortAvailable'],
    apiPortFailureMessage: vi.fn((r: { port: number }) => `Port ${r.port} is already in use.`) as unknown as RunDeps['apiPortFailureMessage'],
    resolveCliPassword: vi.fn((argv, env) => {
      const password = (env as Record<string, string | undefined>)?.['JINN_PASSWORD'];
      if (password) return { ok: true as const, password };
      return { ok: false as const, message: 'No keystore password found. Set JINN_PASSWORD or pass --password-fd N, then re-run.' };
    }) as unknown as RunDeps['resolveCliPassword'],
    mainFn: vi.fn(async () => ({
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
    ...overrides,
  };
}

describe('run command', () => {
  let fakeDeps: RunDeps;

  beforeEach(() => {
    fakeDeps = makeFakeDeps();
  });

  it('requires JINN_PASSWORD', async () => {
    const run = createRunCommand(fakeDeps);
    const { ctx, writes, exits } = makeCommandCtx({ env: {} });
    await run.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('delegates to mainFn() when JINN_PASSWORD is set', async () => {
    const run = createRunCommand(fakeDeps);
    const { ctx, writes } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await run.run(ctx);
    expect(fakeDeps.mainFn).toHaveBeenCalled();
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.kind).toBe('daemon_started');
  });

  it('fails before mainFn() when api port is occupied', async () => {
    fakeDeps = makeFakeDeps({
      checkApiPortAvailable: vi.fn(async () => ({ ok: false as const, port: 7331, code: 'EADDRINUSE', message: 'in use' })) as unknown as RunDeps['checkApiPortAvailable'],
    });
    const run = createRunCommand(fakeDeps);
    const { ctx, writes, exits } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await run.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details).toMatchObject({ field: 'apiPort', port: 7331 });
    expect(fakeDeps.mainFn).not.toHaveBeenCalled();
    expect(exits).toEqual([11]);
  });
});
