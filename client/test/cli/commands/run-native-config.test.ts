import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunCommand } from '../../../src/cli/commands/run.js';
import { makeCommandCtx } from '@test/cli.js';
import { validNativeProductFileContent } from '@test/native-config-fixture.js';
import type { RunDeps } from '../../../src/cli/commands/run.js';
import {
  DEFAULT_CONFIG_PATH,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
  loadConfig as defaultLoadConfig,
} from '../../../src/config.js';
import { loadNativeProductConfigFile } from '../../../src/daemon/native-config-path.js';

/**
 * End-to-end regression coverage for issue #2378. Unlike run.test.ts (which
 * mocks `loadConfig` entirely), these tests exercise the REAL config loader —
 * including the real shape-v2 migration and the real strict native parse —
 * against real files. Only mainFn/nativeMainFn (no real daemon boot) and
 * network/password preflights are mocked.
 *
 * `loadConfig()`/`getConfigPathFromArgs()`'s default path
 * (`DEFAULT_CONFIG_PATH`) is captured at module-load time from `os.homedir()`,
 * which the suite-wide `test/_support/isolate-home.ts` setup file already
 * repoints at a fresh temp dir for this whole test file (see
 * `test/config/home-isolation.test.ts`). So "the default path" for both the
 * legacy loader and the new native-config resolver is
 * `dirname(DEFAULT_CONFIG_PATH)` here — not a second, independently-rolled
 * fake home, which `loadConfig()`'s own default resolution would never see.
 */
const jinnDir = dirname(DEFAULT_CONFIG_PATH);
const defaultNativeConfigPath = join(jinnDir, 'native-config.json');

function realConfigDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    loadConfig: defaultLoadConfig,
    getConfigPathFromArgs: defaultGetConfigPathFromArgs,
    loadNativeConfig: loadNativeProductConfigFile,
    checkRpcNetwork: vi.fn(async () => ({ ok: true as const })) as unknown as RunDeps['checkRpcNetwork'],
    rpcNetworkFailureHint: vi.fn(() => 'fix rpc') as unknown as RunDeps['rpcNetworkFailureHint'],
    checkApiPortAvailable: vi.fn(async () => ({ ok: true as const, port: 7331 })) as unknown as RunDeps['checkApiPortAvailable'],
    apiPortFailureMessage: vi.fn((r: { port: number }) => `Port ${r.port} is already in use.`) as unknown as RunDeps['apiPortFailureMessage'],
    resolveCliPassword: vi.fn((_argv, env) => {
      const password = (env as Record<string, string | undefined>)?.['JINN_PASSWORD'];
      if (password) return { ok: true as const, password };
      return { ok: false as const, message: 'no password' };
    }) as unknown as RunDeps['resolveCliPassword'],
    mainFn: vi.fn(async () => ({
      schemaVersion: 1, kind: 'daemon_started', pid: 1, network: 'testnet', apiPort: 7331,
      serviceIndex: 1, safeAddress: '0xsafe',
    })),
    nativeMainFn: vi.fn(async () => ({
      schemaVersion: 1, kind: 'native_daemon_started', mode: 'native-v1', readiness: 'explicit-native-unvalidated',
    })),
    ...overrides,
  };
}

function writeNative(path: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(path, `${JSON.stringify(validNativeProductFileContent(extra), null, 2)}\n`, { mode: 0o600 });
}

function writeLegacy(path: string, content: Record<string, unknown> = {}): void {
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
}

describe('jinn run native/legacy config routing (issue #2378)', () => {
  beforeEach(() => {
    rmSync(jinnDir, { recursive: true, force: true });
    mkdirSync(jinnDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(jinnDir, { recursive: true, force: true });
  });

  it('boots native from the default native-config.json path without touching any legacy file', async () => {
    writeNative(defaultNativeConfigPath);

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await run.run(ctx);

    expect(deps.nativeMainFn).toHaveBeenCalledOnce();
    expect(deps.mainFn).not.toHaveBeenCalled();
    // No legacy config.json was ever created/migrated.
    expect(existsSync(DEFAULT_CONFIG_PATH)).toBe(false);
  });

  it('migrates a legacy config exactly as before when no native-config.json is present', async () => {
    writeLegacy(DEFAULT_CONFIG_PATH, { network: 'testnet', rpcUrl: 'https://sepolia.base.org' });

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await run.run(ctx);

    expect(deps.mainFn).toHaveBeenCalledOnce();
    expect(deps.nativeMainFn).not.toHaveBeenCalled();
    const written = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf-8'));
    expect(written.configShapeVersion).toBe(2);
    expect(written.claimPolicy).toBeDefined();
    expect(written.executionWiring).toBeDefined();
    expect(written.posting).toBeDefined();
  });

  it('when both default files exist, native wins and the legacy file is left byte-identical', async () => {
    writeNative(defaultNativeConfigPath);
    writeLegacy(DEFAULT_CONFIG_PATH, { network: 'testnet', rpcUrl: 'https://sepolia.base.org' });
    const legacyBefore = readFileSync(DEFAULT_CONFIG_PATH, 'utf-8');

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await run.run(ctx);

    expect(deps.nativeMainFn).toHaveBeenCalledOnce();
    expect(deps.mainFn).not.toHaveBeenCalled();
    expect(readFileSync(DEFAULT_CONFIG_PATH, 'utf-8')).toBe(legacyBefore);
  });

  it('an explicit --config always forces legacy, even when a native default file exists', async () => {
    writeNative(defaultNativeConfigPath);
    const nativeBefore = readFileSync(defaultNativeConfigPath, 'utf-8');
    const explicitLegacyPath = join(jinnDir, 'my-legacy-config.json');
    writeLegacy(explicitLegacyPath, { network: 'testnet', rpcUrl: 'https://sepolia.base.org' });

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx } = makeCommandCtx({ argv: ['--config', explicitLegacyPath], env: { JINN_PASSWORD: 'test' } });
    await run.run(ctx);

    expect(deps.mainFn).toHaveBeenCalledOnce();
    expect(deps.nativeMainFn).not.toHaveBeenCalled();
    // The native default file was never read or written.
    expect(readFileSync(defaultNativeConfigPath, 'utf-8')).toBe(nativeBefore);
    const written = JSON.parse(readFileSync(explicitLegacyPath, 'utf-8'));
    expect(written.configShapeVersion).toBe(2);
  });

  it('passing --native-config and --config together is invalid_invocation, no boot', async () => {
    writeNative(defaultNativeConfigPath);
    writeLegacy(DEFAULT_CONFIG_PATH, {});

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['--native-config', defaultNativeConfigPath, '--config', DEFAULT_CONFIG_PATH],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
    expect(deps.mainFn).not.toHaveBeenCalled();
    expect(deps.nativeMainFn).not.toHaveBeenCalled();
  });

  it('--native-config pointing at a legacy-shaped file is invalid_invocation, no legacy fallback', async () => {
    const legacyShapedPath = join(jinnDir, 'oops-legacy.json');
    writeLegacy(legacyShapedPath, { network: 'testnet', rpcUrl: 'https://sepolia.base.org', tasks: [] });

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['--native-config', legacyShapedPath],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
    expect(deps.mainFn).not.toHaveBeenCalled();
    expect(deps.nativeMainFn).not.toHaveBeenCalled();
  });

  it('--native-config pointing at a missing file is invalid_invocation', async () => {
    const missingPath = join(jinnDir, 'does-not-exist.json');

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['--native-config', missingPath],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
