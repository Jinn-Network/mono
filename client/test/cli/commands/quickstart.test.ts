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
      remove: vi.fn(),
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

  // ── W4 (jinn-mono-964.6): plaintext-password orphan fix ──
  // Audit doc: docs/reviews/2026-04-28-operator-experience-audit.md (W4).
  // Quickstart must not write ~/.jinn-client/keystore-password before all
  // non-secret preflight (RPC, port, doctor) has passed. The structured error
  // envelope must include passwordGenerated and passwordFileCleanup.

  describe('W4: plaintext-password orphan fix', () => {
    it('does NOT generate password file when RPC preflight fails (no JINN_PASSWORD)', async () => {
      const writeSpy = vi.fn();
      const removeSpy = vi.fn();
      const ensureDirSpy = vi.fn();
      const randomBytesSpy = vi.fn(() => Buffer.from('deadbeef'.repeat(8), 'hex'));
      const fakeDeps = makeFakeDeps({
        checkRpcNetwork: vi.fn(async () => ({
          ok: false as const,
          message: 'RPC unreachable',
          network: 'testnet',
          expectedChainId: 84532,
          actualChainId: null,
          rpcHost: 'sepolia.base.org',
          reason: 'unreachable',
        })) as unknown as QuickstartDeps['checkRpcNetwork'],
        passwordFileIO: {
          exists: vi.fn(() => false),
          read: vi.fn(() => ''),
          write: writeSpy,
          remove: removeSpy,
          ensureDir: ensureDirSpy,
        },
        randomBytesFn: randomBytesSpy as unknown as QuickstartDeps['randomBytesFn'],
      });

      const quickstart = createQuickstartCommand(fakeDeps);
      const { ctx, writes, exits } = makeCommandCtx({ argv: [], env: { HOME: '/tmp/quickstart-test-w4-rpc' } });
      await quickstart.run(ctx);

      // Password file IO must never have been touched: no random bytes,
      // no ensureDir, no write, no remove (nothing to clean up).
      expect(randomBytesSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(ensureDirSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();

      const parsed = JSON.parse(writes[writes.length - 1] ?? '{}');
      expect(parsed.code).toBe('invalid_invocation');
      expect(parsed.details).toMatchObject({
        field: 'rpcUrl',
        passwordGenerated: false,
        passwordFileCleanup: { removed: false, reason: 'not_generated_this_run' },
      });
      expect(exits).toEqual([11]);
    });

    it('does NOT generate password file when port preflight fails (no JINN_PASSWORD)', async () => {
      const writeSpy = vi.fn();
      const randomBytesSpy = vi.fn(() => Buffer.from('cafef00d'.repeat(8), 'hex'));
      const fakeDeps = makeFakeDeps({
        checkApiPortAvailable: vi.fn(async () => ({ ok: false as const, port: 7331, code: 'EADDRINUSE', message: 'in use' })) as unknown as QuickstartDeps['checkApiPortAvailable'],
        passwordFileIO: {
          exists: vi.fn(() => false),
          read: vi.fn(() => ''),
          write: writeSpy,
          remove: vi.fn(),
          ensureDir: vi.fn(),
        },
        randomBytesFn: randomBytesSpy as unknown as QuickstartDeps['randomBytesFn'],
      });

      const quickstart = createQuickstartCommand(fakeDeps);
      const { ctx, writes, exits } = makeCommandCtx({ argv: [], env: { HOME: '/tmp/quickstart-test-w4-port' } });
      await quickstart.run(ctx);

      expect(randomBytesSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();

      const parsed = JSON.parse(writes[writes.length - 1] ?? '{}');
      expect(parsed.code).toBe('invalid_invocation');
      expect(parsed.details).toMatchObject({
        field: 'apiPort',
        passwordGenerated: false,
        passwordFileCleanup: { removed: false, reason: 'not_generated_this_run' },
      });
      expect(exits).toEqual([11]);
    });

    it('does NOT generate password file when doctor preflight blocks', async () => {
      const writeSpy = vi.fn();
      const randomBytesSpy = vi.fn(() => Buffer.from('badcoffee'.padEnd(64, '0'), 'hex'));
      const fakeDeps = makeFakeDeps({
        doctorRun: vi.fn(async (ctx: CommandContext) => {
          ctx.writer.write(JSON.stringify({
            ok: false,
            blockingCount: 1,
            checks: [
              { name: 'claude_binary', ok: false, detail: 'not found', remedy: 'install claude' },
            ],
          }));
        }),
        passwordFileIO: {
          exists: vi.fn(() => false),
          read: vi.fn(() => ''),
          write: writeSpy,
          remove: vi.fn(),
          ensureDir: vi.fn(),
        },
        randomBytesFn: randomBytesSpy as unknown as QuickstartDeps['randomBytesFn'],
      });

      const quickstart = createQuickstartCommand(fakeDeps);
      const { ctx, writes, exits } = makeCommandCtx({ argv: ['--no-daemon'], env: { HOME: '/tmp/quickstart-test-w4-doctor' } });
      await quickstart.run(ctx);

      expect(randomBytesSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();

      const parsed = JSON.parse(writes[writes.length - 1] ?? '{}');
      expect(parsed.code).toBe('invalid_invocation');
      expect(parsed.details).toMatchObject({
        field: 'doctor',
        passwordGenerated: false,
        passwordFileCleanup: { removed: false, reason: 'not_generated_this_run' },
      });
      expect(parsed.details.blockers).toEqual([
        { name: 'claude_binary', detail: 'not found', remedy: 'install claude' },
      ]);
      expect(exits).toEqual([11]);
    });

    it('does NOT pass JINN_PASSWORD onto disk when doctor needs a transient value', async () => {
      // Even though doctor needs a non-empty JINN_PASSWORD to skip its own
      // preflight, we must not write that placeholder to the password file.
      const writeSpy = vi.fn();
      const fakeDeps = makeFakeDeps({
        doctorRun: vi.fn(async (ctx: CommandContext) => {
          // Doctor sees a placeholder password in its env (so its password
          // preflight passes), but we should never persist it to disk.
          expect(ctx.env['JINN_PASSWORD']).toBeDefined();
          expect(ctx.env['JINN_PASSWORD']!.length).toBeGreaterThan(0);
          ctx.writer.write(JSON.stringify({
            ok: false,
            blockingCount: 1,
            checks: [{ name: 'rpc', ok: false, detail: 'broken' }],
          }));
        }),
        passwordFileIO: {
          exists: vi.fn(() => false),
          read: vi.fn(() => ''),
          write: writeSpy,
          remove: vi.fn(),
          ensureDir: vi.fn(),
        },
      });

      const quickstart = createQuickstartCommand(fakeDeps);
      const { ctx } = makeCommandCtx({ argv: ['--no-daemon'], env: { HOME: '/tmp/quickstart-test-w4-doctor-transient' } });
      await quickstart.run(ctx);

      // Doctor saw a transient password but we never wrote one to disk.
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('generates password AFTER preflight passes and reports passwordGenerated:true on success', async () => {
      const writeSpy = vi.fn();
      const ensureDirSpy = vi.fn();
      const randomBytesSpy = vi.fn(() => Buffer.from('feedfacefeedface'.repeat(4), 'hex'));
      let passwordWriteOrder: string[] = [];

      const checkRpcSpy = vi.fn(async () => {
        passwordWriteOrder.push('rpc');
        return { ok: true as const };
      });
      const checkPortSpy = vi.fn(async () => {
        passwordWriteOrder.push('port');
        return { ok: true as const, port: 7331 };
      });
      const doctorSpy = vi.fn(async (ctx: CommandContext) => {
        passwordWriteOrder.push('doctor');
        ctx.writer.write(JSON.stringify({ ok: true, blockingCount: 0, checks: [] }));
      });
      const recordingWrite = (path: string, content: string): void => {
        passwordWriteOrder.push('password_write');
        writeSpy(path, content);
      };

      const fakeDeps = makeFakeDeps({
        checkRpcNetwork: checkRpcSpy as unknown as QuickstartDeps['checkRpcNetwork'],
        checkApiPortAvailable: checkPortSpy as unknown as QuickstartDeps['checkApiPortAvailable'],
        doctorRun: doctorSpy,
        initRun: vi.fn(async (ctx: CommandContext) => {
          passwordWriteOrder.push('init');
          ctx.writer.write(JSON.stringify({ master: '0xdeadbeef' }));
          ctx.exit(0);
        }),
        bootstrapRun: vi.fn(async (ctx: CommandContext) => {
          passwordWriteOrder.push('bootstrap');
          ctx.writer.write(JSON.stringify({ ok: true }));
          ctx.exit(0);
        }) as unknown as QuickstartDeps['bootstrapRun'],
        passwordFileIO: {
          exists: vi.fn(() => false),
          read: vi.fn(() => ''),
          write: recordingWrite,
          remove: vi.fn(),
          ensureDir: ensureDirSpy,
        },
        randomBytesFn: randomBytesSpy as unknown as QuickstartDeps['randomBytesFn'],
      });

      const quickstart = createQuickstartCommand(fakeDeps);
      const { ctx, writes } = makeCommandCtx({ argv: ['--no-daemon'], env: { HOME: '/tmp/quickstart-test-w4-success' } });
      await quickstart.run(ctx);

      // Password write must come AFTER all three preflight checks — that's
      // the heart of the W4 fix.
      expect(passwordWriteOrder.indexOf('password_write')).toBeGreaterThan(passwordWriteOrder.indexOf('rpc'));
      expect(passwordWriteOrder.indexOf('password_write')).toBeGreaterThan(passwordWriteOrder.indexOf('port'));
      expect(passwordWriteOrder.indexOf('password_write')).toBeGreaterThan(passwordWriteOrder.indexOf('doctor'));
      // …and BEFORE init runs.
      expect(passwordWriteOrder.indexOf('password_write')).toBeLessThan(passwordWriteOrder.indexOf('init'));

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(ensureDirSpy).toHaveBeenCalledTimes(1);

      // Final success envelope reports passwordGenerated:true and the path.
      const lastEnvelope = JSON.parse(writes[writes.length - 1] ?? '{}');
      expect(lastEnvelope.status).toBe('ready');
      expect(lastEnvelope.passwordGenerated).toBe(true);
      expect(lastEnvelope.passwordFile).toContain('/.jinn-client/keystore-password');
    });

    it('cleans up generated password file when init fails before keystore is created', async () => {
      const writeSpy = vi.fn();
      const removeSpy = vi.fn();
      const existsSpy = vi.fn((path: string) => {
        // First call: passwordFilePreexisted check → false.
        // Subsequent calls: keystore existence check during cleanup → false
        // (init failed before creating it).
        if (path.endsWith('master_keystore.json')) return false;
        return false;
      });
      const fakeDeps = makeFakeDeps({
        initRun: vi.fn(async (ctx: CommandContext) => {
          ctx.writer.write(JSON.stringify({ code: 'fatal', message: 'mnemonic generation failed' }));
          ctx.exit(50);
        }),
        passwordFileIO: {
          exists: existsSpy,
          read: vi.fn(() => ''),
          write: writeSpy,
          remove: removeSpy,
          ensureDir: vi.fn(),
        },
        doctorRun: vi.fn(async (ctx: CommandContext) => {
          ctx.writer.write(JSON.stringify({ ok: true, blockingCount: 0, checks: [] }));
        }),
      });

      const quickstart = createQuickstartCommand(fakeDeps);
      const { ctx, writes, exits } = makeCommandCtx({ argv: ['--no-daemon'], env: { HOME: '/tmp/quickstart-test-w4-init-fail' } });
      await quickstart.run(ctx);

      // Password was written, then removed because init failed.
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy.mock.calls[0]?.[0]).toContain('/.jinn-client/keystore-password');

      // The trailing envelope reports status=init_failed with cleanup info.
      const trailing = writes
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean);
      const initFailedEnvelope = trailing.find((e: { status?: string }) => e.status === 'init_failed');
      expect(initFailedEnvelope).toMatchObject({
        verb: 'quickstart',
        status: 'init_failed',
        passwordGenerated: true,
        passwordFileCleanup: { removed: true, reason: 'orphan_cleanup' },
      });
      expect(exits).toEqual([50]);
    });

    it('does NOT remove a pre-existing password file on preflight failure', async () => {
      // Operator already had ~/.jinn-client/keystore-password from a prior
      // run; preflight failure must leave it alone.
      const removeSpy = vi.fn();
      const fakeDeps = makeFakeDeps({
        checkRpcNetwork: vi.fn(async () => ({
          ok: false as const,
          message: 'RPC unreachable',
          network: 'testnet',
          expectedChainId: 84532,
          actualChainId: null,
          rpcHost: 'sepolia.base.org',
          reason: 'unreachable',
        })) as unknown as QuickstartDeps['checkRpcNetwork'],
        passwordFileIO: {
          exists: vi.fn(() => true),
          read: vi.fn(() => 'existing-password\n'),
          write: vi.fn(),
          remove: removeSpy,
          ensureDir: vi.fn(),
        },
      });

      const quickstart = createQuickstartCommand(fakeDeps);
      const { ctx, writes } = makeCommandCtx({ argv: [], env: { HOME: '/tmp/quickstart-test-w4-preexisting' } });
      await quickstart.run(ctx);

      expect(removeSpy).not.toHaveBeenCalled();

      const parsed = JSON.parse(writes[writes.length - 1] ?? '{}');
      expect(parsed.details).toMatchObject({
        passwordGenerated: false,
        passwordFileCleanup: { removed: false, reason: 'not_generated_this_run' },
      });
    });

    it('does NOT remove password file when JINN_PASSWORD is set (no generation occurred)', async () => {
      const removeSpy = vi.fn();
      const writeSpy = vi.fn();
      const fakeDeps = makeFakeDeps({
        checkApiPortAvailable: vi.fn(async () => ({ ok: false as const, port: 7331, code: 'EADDRINUSE', message: 'in use' })) as unknown as QuickstartDeps['checkApiPortAvailable'],
        passwordFileIO: {
          exists: vi.fn(() => false),
          read: vi.fn(() => ''),
          write: writeSpy,
          remove: removeSpy,
          ensureDir: vi.fn(),
        },
      });

      const quickstart = createQuickstartCommand(fakeDeps);
      const { ctx, writes } = makeCommandCtx({ argv: [], env: { JINN_PASSWORD: 'env-password', HOME: '/tmp/quickstart-test-w4-envpw' } });
      await quickstart.run(ctx);

      expect(writeSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();

      const parsed = JSON.parse(writes[writes.length - 1] ?? '{}');
      expect(parsed.details).toMatchObject({
        passwordGenerated: false,
        passwordFileCleanup: { removed: false, reason: 'not_generated_this_run' },
      });
    });
  });
});
