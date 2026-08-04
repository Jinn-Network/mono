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

/**
 * `operator.verticalMode` is optional in NativeProductFileSchema — omitted or
 * `'legacy'` both resolve to `effectiveMode: 'legacy'`
 * (native-vertical-mode.ts:103-105). A `--native-config` file in either shape
 * must never silently boot the legacy product against a config the operator
 * never named as `--config`.
 */
function writeNativeFileWithVerticalMode(path: string, verticalMode: 'native-v1' | 'legacy' | 'omitted'): void {
  const content = validNativeProductFileContent();
  const operator = content['operator'] as Record<string, unknown>;
  if (verticalMode === 'omitted') {
    delete operator['verticalMode'];
  } else {
    operator['verticalMode'] = verticalMode;
  }
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
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

  // --- Coordinator re-review: --config=<path> (equals form) bypassed both the
  // "explicit --config always forces legacy" behavior above and the mutual-exclusion
  // guard below, because run.ts sourced the legacy flag from
  // deps.getConfigPathFromArgs (a raw argv.indexOf('--config') scan, config.ts:1520-1523)
  // while the native side had already learned the equals form. The two scanners were
  // asymmetric — --config=<path> was silently invisible to the legacy-flag check.

  it('an explicit --config=<path> (equals form) also always forces legacy, even when a native default file exists', async () => {
    writeNative(defaultNativeConfigPath);
    const nativeBefore = readFileSync(defaultNativeConfigPath, 'utf-8');
    const explicitLegacyPath = join(jinnDir, 'my-legacy-config.json');
    writeLegacy(explicitLegacyPath, { network: 'testnet', rpcUrl: 'https://sepolia.base.org' });

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx } = makeCommandCtx({ argv: [`--config=${explicitLegacyPath}`], env: { JINN_PASSWORD: 'test' } });
    await run.run(ctx);

    expect(deps.mainFn).toHaveBeenCalledOnce();
    expect(deps.nativeMainFn).not.toHaveBeenCalled();
    // The native default file was never read or written.
    expect(readFileSync(defaultNativeConfigPath, 'utf-8')).toBe(nativeBefore);
    const written = JSON.parse(readFileSync(explicitLegacyPath, 'utf-8'));
    expect(written.configShapeVersion).toBe(2);
  });

  it('--config=<path> and --native-config=<path> (both equals form) together is invalid_invocation, no boot', async () => {
    writeNative(defaultNativeConfigPath);
    writeLegacy(DEFAULT_CONFIG_PATH, {});

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({
      argv: [`--native-config=${defaultNativeConfigPath}`, `--config=${DEFAULT_CONFIG_PATH}`],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
    expect(deps.mainFn).not.toHaveBeenCalled();
    expect(deps.nativeMainFn).not.toHaveBeenCalled();
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

  // --- Opus review (2026-08-04): naming --native-config must never silently boot the
  // legacy product. operator.verticalMode is optional in NativeProductFileSchema; an
  // omitted or explicit 'legacy' value resolves to effectiveMode 'legacy'
  // (native-vertical-mode.ts:103-105), which — pre-fix — selected deps.mainFn, and in
  // production that loads AND MIGRATES ~/.jinn-client/config.json, a file the operator
  // never named. Both shapes must instead hard-fail before any daemon boots.

  it('--native-config with operator.verticalMode omitted refuses to silently boot legacy', async () => {
    const nativePath = join(jinnDir, 'native-config.json');
    writeNativeFileWithVerticalMode(nativePath, 'omitted');
    // A legacy config also exists at the default path — proving it is never touched.
    writeLegacy(DEFAULT_CONFIG_PATH, { network: 'testnet', rpcUrl: 'https://sepolia.base.org' });
    const legacyBefore = readFileSync(DEFAULT_CONFIG_PATH, 'utf-8');

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['--native-config', nativePath],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
    expect(deps.mainFn).not.toHaveBeenCalled();
    expect(deps.nativeMainFn).not.toHaveBeenCalled();
    // The legacy config.json was never opened, let alone migrated.
    expect(readFileSync(DEFAULT_CONFIG_PATH, 'utf-8')).toBe(legacyBefore);
  });

  it("--native-config with operator.verticalMode: 'legacy' refuses to silently boot legacy", async () => {
    const nativePath = join(jinnDir, 'native-config.json');
    writeNativeFileWithVerticalMode(nativePath, 'legacy');
    writeLegacy(DEFAULT_CONFIG_PATH, { network: 'testnet', rpcUrl: 'https://sepolia.base.org' });
    const legacyBefore = readFileSync(DEFAULT_CONFIG_PATH, 'utf-8');

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['--native-config', nativePath],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
    expect(deps.mainFn).not.toHaveBeenCalled();
    expect(deps.nativeMainFn).not.toHaveBeenCalled();
    expect(readFileSync(DEFAULT_CONFIG_PATH, 'utf-8')).toBe(legacyBefore);
  });

  it('the default-path route also refuses a native-config.json whose effective mode is legacy', async () => {
    // Same hazard via the zero-flag default-path route, not just an explicit --native-config.
    writeNativeFileWithVerticalMode(defaultNativeConfigPath, 'omitted');

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({ env: { JINN_PASSWORD: 'test' } });
    await run.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
    expect(deps.mainFn).not.toHaveBeenCalled();
    expect(deps.nativeMainFn).not.toHaveBeenCalled();
  });

  // --- Opus review: --native-config=<path> (the `=` form, which Node's parseArgs accepts)
  // was silently ignored by the raw argv scan, falling through to legacy.

  it('accepts the --native-config=<path> equals form', async () => {
    const nativePath = join(jinnDir, 'native-config.json');
    writeNative(nativePath);

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx } = makeCommandCtx({
      argv: [`--native-config=${nativePath}`],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);

    expect(deps.nativeMainFn).toHaveBeenCalledOnce();
    expect(deps.mainFn).not.toHaveBeenCalled();
  });

  it('the --native-config=<path> equals form still errors on a missing file rather than falling to legacy', async () => {
    const missingPath = join(jinnDir, 'does-not-exist.json');

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({
      argv: [`--native-config=${missingPath}`],
      env: { JINN_PASSWORD: 'test' },
    });
    await run.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
    expect(deps.mainFn).not.toHaveBeenCalled();
  });

  // --- Opus review minor: the error envelope should name how the path was resolved, so an
  // operator who set JINN_NATIVE_CONFIG_PATH at their legacy file gets a pointer to the env var.

  it('a bad native config resolved via JINN_NATIVE_CONFIG_PATH names the env var in the error', async () => {
    const legacyShapedPath = join(jinnDir, 'oops-legacy.json');
    writeLegacy(legacyShapedPath, { network: 'testnet', rpcUrl: 'https://sepolia.base.org', tasks: [] });

    const deps = realConfigDeps();
    const run = createRunCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({
      env: { JINN_PASSWORD: 'test', JINN_NATIVE_CONFIG_PATH: legacyShapedPath },
    });
    await run.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
    expect(JSON.stringify(parsed)).toContain('JINN_NATIVE_CONFIG_PATH');
  });
});
