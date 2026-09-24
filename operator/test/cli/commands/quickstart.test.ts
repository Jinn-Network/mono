import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
});
