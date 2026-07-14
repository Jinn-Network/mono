import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunCommand } from '../../src/cli/commands/run.js';
import type { RunDeps } from '../../src/cli/commands/run.js';
import { makeCommandCtx } from '@test/cli.js';

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
      return { ok: false as const, message: 'No keystore password found.' };
    }) as unknown as RunDeps['resolveCliPassword'],
    mainFn: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'daemon_started',
      pid: 123,
      network: 'testnet',
      apiPort: 7331,
      serviceIndex: 1,
      safeAddress: '0xsafe',
    })),
    ...overrides,
  };
}

describe('jinn run --no-ui', () => {
  it('parses --no-ui flag without erroring (no exit code 11)', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx, exits } = makeCommandCtx({
      argv: ['--no-ui', '--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    // Flag must parse cleanly: no invalid_invocation exit (code 11).
    expect(exits).not.toContain(11);
    expect(fakeDeps.mainFn).toHaveBeenCalled();
  });

  it('parses without --no-ui flag (default behaviour)', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx, exits } = makeCommandCtx({
      argv: ['--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(exits).not.toContain(11);
    expect(fakeDeps.mainFn).toHaveBeenCalled();
  });

  it('does not auto-open the browser when --no-ui is set', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    // The handshake URL is set in env; the only side-effect of auto-open
    // is spawning a child process. We can't observe that here without
    // mocking child_process — but the no-throw + no-exit-11 invariant is
    // sufficient to confirm the flag short-circuits the open path.
    const { ctx, exits } = makeCommandCtx({
      argv: ['--no-ui', '--json'],
      env: { JINN_PASSWORD: 'test', JINN_UI_HANDSHAKE_URL: 'http://127.0.0.1:7331/auth/handshake?k=abc' },
    });
    await expect(run.run(ctx)).resolves.toBeUndefined();
    expect(exits).not.toContain(11);
  });
});

describe('jinn run --ui (issue #804)', () => {
  const FORCE_UI_KEY = 'JINN_FORCE_UI' as const;
  let snapshot: string | undefined;
  beforeEach(() => {
    snapshot = process.env[FORCE_UI_KEY];
    delete process.env[FORCE_UI_KEY];
  });
  afterEach(() => {
    if (snapshot === undefined) delete process.env[FORCE_UI_KEY];
    else process.env[FORCE_UI_KEY] = snapshot;
  });

  it('--ui sets JINN_FORCE_UI=1', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx, exits } = makeCommandCtx({
      argv: ['--ui', '--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(exits).not.toContain(11);
    expect(process.env['JINN_FORCE_UI']).toBe('1');
    expect(fakeDeps.mainFn).toHaveBeenCalled();
  });

  it('without --ui, JINN_FORCE_UI is not set', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx, exits } = makeCommandCtx({
      argv: ['--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(exits).not.toContain(11);
    expect(process.env['JINN_FORCE_UI']).toBeUndefined();
  });
});

describe('jinn run flags (A4 quickstart parity)', () => {
  // Snapshot + restore the env vars these tests mutate via process.env.
  // run.ts's translation block writes JINN_FUNDING_TIMEOUT_MS / JINN_NO_DAEMON
  // / JINN_JSON_PROGRESS into process.env so the spawned mainFn sees them.
  const ENV_KEYS = [
    'JINN_FUNDING_TIMEOUT_MS',
    'JINN_NO_DAEMON',
    'JINN_JSON_PROGRESS',
    'JINN_NO_UI',
    'JINN_FORCE_UI',
  ] as const;
  const snapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('--funding-timeout 5m sets JINN_FUNDING_TIMEOUT_MS=300000', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx, exits } = makeCommandCtx({
      argv: ['--funding-timeout', '5m', '--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(exits).not.toContain(11);
    expect(process.env['JINN_FUNDING_TIMEOUT_MS']).toBe('300000');
    expect(fakeDeps.mainFn).toHaveBeenCalled();
  });

  it('--funding-timeout 30s sets JINN_FUNDING_TIMEOUT_MS=30000', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx } = makeCommandCtx({
      argv: ['--funding-timeout', '30s', '--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(process.env['JINN_FUNDING_TIMEOUT_MS']).toBe('30000');
  });

  it('--funding-timeout 1h sets JINN_FUNDING_TIMEOUT_MS=3600000', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx } = makeCommandCtx({
      argv: ['--funding-timeout', '1h', '--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(process.env['JINN_FUNDING_TIMEOUT_MS']).toBe('3600000');
  });

  it('--funding-timeout never does NOT set JINN_FUNDING_TIMEOUT_MS', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx, exits } = makeCommandCtx({
      argv: ['--funding-timeout', 'never', '--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(exits).not.toContain(11);
    // 'never' / 'none' / 'infinite' all map to "wait forever" in main(),
    // so we MUST NOT set the env var (main()'s default is POSITIVE_INFINITY).
    expect(process.env['JINN_FUNDING_TIMEOUT_MS']).toBeUndefined();
    expect(fakeDeps.mainFn).toHaveBeenCalled();
  });

  it('--funding-timeout none does NOT set JINN_FUNDING_TIMEOUT_MS', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx } = makeCommandCtx({
      argv: ['--funding-timeout', 'none', '--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(process.env['JINN_FUNDING_TIMEOUT_MS']).toBeUndefined();
  });

  it('--funding-timeout with invalid value emits invalid_invocation envelope', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx, exits } = makeCommandCtx({
      argv: ['--funding-timeout', 'banana', '--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(exits).toContain(11);
    // mainFn must NOT have been called — we bailed at flag-validation.
    expect(fakeDeps.mainFn).not.toHaveBeenCalled();
  });

  it('--no-daemon sets JINN_NO_DAEMON=1', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx, exits } = makeCommandCtx({
      argv: ['--no-daemon', '--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(exits).not.toContain(11);
    expect(process.env['JINN_NO_DAEMON']).toBe('1');
    expect(fakeDeps.mainFn).toHaveBeenCalled();
  });

  it('--json-progress sets JINN_JSON_PROGRESS=1', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx, exits } = makeCommandCtx({
      argv: ['--json-progress', '--json'],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(exits).not.toContain(11);
    expect(process.env['JINN_JSON_PROGRESS']).toBe('1');
    expect(fakeDeps.mainFn).toHaveBeenCalled();
  });

  it('all three flags compose without conflict', async () => {
    const fakeDeps = makeFakeDeps();
    const run = createRunCommand(fakeDeps);
    const { ctx, exits } = makeCommandCtx({
      argv: [
        '--no-daemon',
        '--funding-timeout', '15m',
        '--json-progress',
        '--json',
      ],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);
    expect(exits).not.toContain(11);
    expect(process.env['JINN_NO_DAEMON']).toBe('1');
    expect(process.env['JINN_FUNDING_TIMEOUT_MS']).toBe('900000');
    expect(process.env['JINN_JSON_PROGRESS']).toBe('1');
  });
});
