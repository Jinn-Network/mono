import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validNativeProductFileContent } from '@test/native-config-fixture.js';
import {
  getNativeConfigPathFromArgs,
  loadNativeProductConfigFile,
  NativeConfigLoadError,
  resolveNativeConfigPath,
} from '../../src/daemon/native-config-path.js';

describe('getNativeConfigPathFromArgs', () => {
  it('returns undefined when --native-config is absent', () => {
    expect(getNativeConfigPathFromArgs(['run', '--human'])).toBeUndefined();
  });

  it('returns the value following --native-config', () => {
    expect(getNativeConfigPathFromArgs(['run', '--native-config', '/tmp/nc.json'])).toBe('/tmp/nc.json');
  });

  // Opus review: Node's parseArgs accepts both `--flag value` and `--flag=value` for a
  // `type: 'string'` option; a raw argv scan that only recognised the first form silently
  // dropped `--native-config=<path>` invocations onto the legacy path.
  it('returns the value from the --native-config=<path> equals form', () => {
    expect(getNativeConfigPathFromArgs(['run', '--native-config=/tmp/nc.json'])).toBe('/tmp/nc.json');
  });

  it('treats an empty --native-config=<path> value as absent', () => {
    expect(getNativeConfigPathFromArgs(['run', '--native-config='])).toBeUndefined();
  });
});

describe('resolveNativeConfigPath', () => {
  it('flag wins over env and default', () => {
    const path = resolveNativeConfigPath(
      ['--native-config', '/from/flag.json'],
      { HOME: '/home/op', JINN_NATIVE_CONFIG_PATH: '/from/env.json' },
    );
    expect(path).toBe('/from/flag.json');
  });

  it('env wins over the default when no flag is passed', () => {
    const path = resolveNativeConfigPath([], { HOME: '/home/op', JINN_NATIVE_CONFIG_PATH: '/from/env.json' });
    expect(path).toBe('/from/env.json');
  });

  it('defaults to <HOME>/.jinn-client/native-config.json', () => {
    const path = resolveNativeConfigPath([], { HOME: '/home/op' });
    expect(path).toBe(join('/home/op', '.jinn-client', 'native-config.json'));
  });
});

describe('loadNativeProductConfigFile', () => {
  // Async — the NativeProductFileSchema import inside is deliberately lazy (dynamic
  // import()), so every assertion here awaits the rejection/resolution rather than
  // expecting a synchronous throw. See the module doc comment for why.

  it('throws NativeConfigLoadError when the file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-native-config-path-'));
    await expect(loadNativeProductConfigFile(join(dir, 'missing.json'))).rejects.toThrow(NativeConfigLoadError);
  });

  it('throws NativeConfigLoadError on invalid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-native-config-path-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{not json', 'utf-8');
    await expect(loadNativeProductConfigFile(path)).rejects.toThrow(NativeConfigLoadError);
  });

  it('throws NativeConfigLoadError on a legacy-shaped file (unrecognized keys)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-native-config-path-'));
    const path = join(dir, 'legacy.json');
    writeFileSync(path, JSON.stringify({ network: 'testnet', rpcUrl: 'https://sepolia.base.org', tasks: [], apiPort: 7331 }), 'utf-8');
    await expect(loadNativeProductConfigFile(path)).rejects.toThrow(NativeConfigLoadError);
  });

  it('returns the strictly-parsed config on success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-native-config-path-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'native-config.json');
    writeFileSync(path, JSON.stringify(validNativeProductFileContent(), null, 2), 'utf-8');
    const config = await loadNativeProductConfigFile(path);
    expect(config.network).toBe('testnet');
    expect(config.operator.verticalMode).toBe('native-v1');
    expect(config.operator.native.role).toBe('solver');
  });
});
