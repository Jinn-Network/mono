import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQuickstartCommand,
  DEFAULT_PASSWORD_FILE_IO,
  type PasswordFileIO,
  type QuickstartDeps,
} from '../../../src/cli/commands/quickstart.js';
import { makeCommandCtx } from '@test/cli.js';
import { legacyKeystorePasswordPath, primaryKeystorePasswordPath } from '../../../src/earning/password-file.js';

// Reuses the production I/O object (not a reimplementation of it) so that a
// regression in the real `write` path -- e.g. reverting to a plain
// `writeFileSync` -- fails these tests instead of a parallel test-only copy.
function diskPasswordFileIO(): PasswordFileIO {
  return {
    ...DEFAULT_PASSWORD_FILE_IO,
    remove: () => { /* unused in these tests */ },
  };
}

describe('quickstart password resolution (#4087)', () => {
  let fakeHome: string;
  let capturedInitEnv: NodeJS.ProcessEnv | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'jinn-qs-pw-'));
    capturedInitEnv = undefined;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<QuickstartDeps> = {}): QuickstartDeps {
    const earningDir = join(fakeHome, '.jinn-operator', 'earning');
    mkdirSync(earningDir, { recursive: true });
    return {
      loadConfig: vi.fn(() => ({
        network: 'testnet',
        rpcUrl: 'https://sepolia.base.org',
        apiPort: 7331,
        earningDir,
      })) as unknown as QuickstartDeps['loadConfig'],
      getConfigPathFromArgs: vi.fn(() => undefined) as unknown as QuickstartDeps['getConfigPathFromArgs'],
      checkRpcNetwork: vi.fn(async () => ({ ok: true as const })) as unknown as QuickstartDeps['checkRpcNetwork'],
      rpcNetworkFailureHint: vi.fn(() => 'fix rpc') as unknown as QuickstartDeps['rpcNetworkFailureHint'],
      checkApiPortAvailable: vi.fn(async () => ({ ok: true as const, port: 7331 })) as unknown as QuickstartDeps['checkApiPortAvailable'],
      apiPortFailureMessage: vi.fn((r: { port: number }) => `Port ${r.port} is already in use.`) as unknown as QuickstartDeps['apiPortFailureMessage'],
      mainFn: vi.fn(async () => ({})),
      initRun: vi.fn(async (ctx) => {
        capturedInitEnv = ctx.env;
        ctx.writer.write(JSON.stringify({ master: '0xmaster' }) + '\n');
      }) as unknown as QuickstartDeps['initRun'],
      bootstrapRun: vi.fn(async () => undefined) as unknown as QuickstartDeps['bootstrapRun'],
      doctorRun: vi.fn(async (ctx) => {
        ctx.writer.write(JSON.stringify({ ok: true, blockingCount: 0, checks: [] }) + '\n');
      }) as unknown as QuickstartDeps['doctorRun'],
      passwordFileIO: diskPasswordFileIO(),
      randomBytesFn: vi.fn(() => Buffer.alloc(32, 0xab)),
      ...overrides,
    };
  }

  it('reuses a host-wide legacy password instead of minting a primary that would outrank it', async () => {
    const earningDir = join(fakeHome, '.jinn-operator', 'earning');
    mkdirSync(join(fakeHome, '.jinn-operator'), { recursive: true });
    mkdirSync(earningDir, { recursive: true });
    const env = { HOME: fakeHome };
    const legacyPath = legacyKeystorePasswordPath({ home: fakeHome, env });
    writeFileSync(legacyPath, 'legacy-secret\n', { mode: 0o600 });

    const deps = makeDeps();
    const cmd = createQuickstartCommand(deps);
    const { ctx } = makeCommandCtx({ argv: ['--no-daemon'], env });
    await cmd.run(ctx);

    expect(deps.randomBytesFn).not.toHaveBeenCalled();
    expect(existsSync(primaryKeystorePasswordPath(earningDir))).toBe(false);
    expect(readFileSync(legacyPath, 'utf-8').trim()).toBe('legacy-secret');
    expect(capturedInitEnv?.['JINN_PASSWORD']).toBe('legacy-secret');
  });

  it('tightens a pre-existing loose primary file to 0600 when generating into it', async () => {
    // A raw `writeFileSync(path, content, { mode: 0o600 })` only applies
    // `mode` on create, so a hand-made 0644 empty file would receive the
    // generated secret world-readable. The atomic replace (#4610) always
    // creates its temp file at 0600, so the rename always lands at 0600.
    const earningDir = join(fakeHome, '.jinn-operator', 'earning');
    mkdirSync(join(fakeHome, '.jinn-operator'), { recursive: true });
    mkdirSync(earningDir, { recursive: true });
    const env = { HOME: fakeHome };
    const primaryPath = primaryKeystorePasswordPath(earningDir);
    writeFileSync(primaryPath, '');
    chmodSync(primaryPath, 0o644);

    const deps = makeDeps();
    const cmd = createQuickstartCommand(deps);
    const { ctx } = makeCommandCtx({ argv: ['--no-daemon'], env });
    await cmd.run(ctx);

    expect(deps.randomBytesFn).toHaveBeenCalled();
    expect(readFileSync(primaryPath, 'utf-8').trim()).toBe('ab'.repeat(32));
    expect(statSync(primaryPath).mode & 0o777).toBe(0o600);
  });

  // #5390: quickstart accepted --password-fd but picked JINN_PASSWORD, the file or a fresh
  // password, then ran init and bootstrap in-process, which read the descriptor themselves.
  describe('--password-fd', () => {
    const fds: number[] = [];

    function openPasswordFd(content: string): number {
      const path = join(fakeHome, `fd-${fds.length}`);
      writeFileSync(path, content, { mode: 0o600 });
      const fd = openSync(path, 'r');
      fds.push(fd);
      return fd;
    }

    afterEach(() => {
      for (const fd of fds.splice(0)) closeSync(fd);
    });

    it('uses the descriptor password for doctor, init and bootstrap, over JINN_PASSWORD and the file', async () => {
      const earningDir = join(fakeHome, '.jinn-operator', 'earning');
      mkdirSync(earningDir, { recursive: true });
      const primaryPath = primaryKeystorePasswordPath(earningDir);
      writeFileSync(primaryPath, 'file-secret\n', { mode: 0o600 });
      const env = { HOME: fakeHome, JINN_PASSWORD: 'env-secret' };
      const fd = openPasswordFd('fd-secret\n');
      const seen: Array<{ step: string; password: string | undefined; argv: string[] }> = [];

      const deps = makeDeps({
        doctorRun: vi.fn(async (ctx) => {
          seen.push({ step: 'doctor', password: ctx.env['JINN_PASSWORD'], argv: ctx.argv });
          ctx.writer.write(JSON.stringify({ ok: true, blockingCount: 0, checks: [] }) + '\n');
        }) as unknown as QuickstartDeps['doctorRun'],
        initRun: vi.fn(async (ctx) => {
          seen.push({ step: 'init', password: ctx.env['JINN_PASSWORD'], argv: ctx.argv });
          ctx.writer.write(JSON.stringify({ master: '0xmaster' }) + '\n');
        }) as unknown as QuickstartDeps['initRun'],
        bootstrapRun: vi.fn(async (ctx) => {
          seen.push({ step: 'bootstrap', password: ctx.env['JINN_PASSWORD'], argv: ctx.argv });
        }) as unknown as QuickstartDeps['bootstrapRun'],
      });
      const { ctx, writes, exits } = makeCommandCtx({ argv: ['--no-daemon', '--password-fd', String(fd)], env });
      await createQuickstartCommand(deps).run(ctx);

      expect(exits).toEqual([]);
      expect(seen.map(({ step, password }) => `${step}:${password}`)).toEqual([
        'doctor:fd-secret',
        'init:fd-secret',
        'bootstrap:fd-secret',
      ]);
      for (const { argv } of seen) expect(argv.join(' ')).not.toContain('--password-fd');
      expect(deps.randomBytesFn).not.toHaveBeenCalled();
      expect(readFileSync(primaryPath, 'utf-8').trim()).toBe('file-secret');
      const payload = JSON.parse(writes.join('').trim().split('\n').at(-1)!);
      expect(payload).toMatchObject({ status: 'ready', passwordGenerated: false });
      expect(payload.passwordFile).toBeUndefined();
    });

    it('starts the daemon with the descriptor password', async () => {
      const fd = openPasswordFd('fd-secret\n');
      const saved = {
        password: process.env['JINN_PASSWORD'],
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
      };
      let daemonPassword: string | undefined;
      try {
        const deps = makeDeps({
          mainFn: vi.fn(async () => {
            daemonPassword = process.env['JINN_PASSWORD'];
            return {};
          }),
        });
        const { ctx } = makeCommandCtx({ argv: ['--password-fd', String(fd)], env: { HOME: fakeHome } });
        await createQuickstartCommand(deps).run(ctx);
      } finally {
        console.log = saved.log;
        console.info = saved.info;
        console.warn = saved.warn;
        console.error = saved.error;
        if (saved.password === undefined) delete process.env['JINN_PASSWORD'];
        else process.env['JINN_PASSWORD'] = saved.password;
      }
      expect(daemonPassword).toBe('fd-secret');
      expect(capturedInitEnv?.['JINN_PASSWORD']).toBe('fd-secret');
    });

    it.each([
      [
        'an invalid descriptor',
        () => '--password-fd=',
        'Missing or invalid value for --password-fd (expected a non-negative file descriptor)',
      ],
      ['an empty descriptor', () => `--password-fd=${openPasswordFd('')}`, 'Password from --password-fd is empty.'],
    ])('refuses %s before any preflight, and generates and writes nothing', async (_label, flag, message) => {
      const earningDir = join(fakeHome, '.jinn-operator', 'earning');
      const deps = makeDeps();
      const { ctx, writes, exits } = makeCommandCtx({ argv: ['--no-daemon', flag()], env: { HOME: fakeHome } });
      await createQuickstartCommand(deps).run(ctx);

      const envelope = JSON.parse(writes.join('').trim());
      expect(envelope).toMatchObject({ code: 'invalid_invocation', message, details: { field: 'password-fd' } });
      expect(exits).toEqual([11]);
      expect(deps.checkRpcNetwork).not.toHaveBeenCalled();
      expect(deps.doctorRun).not.toHaveBeenCalled();
      expect(deps.initRun).not.toHaveBeenCalled();
      expect(deps.randomBytesFn).not.toHaveBeenCalled();
      expect(existsSync(primaryKeystorePasswordPath(earningDir))).toBe(false);
    });
  });
});
