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
  it('throws NativeConfigLoadError when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-native-config-path-'));
    expect(() => loadNativeProductConfigFile(join(dir, 'missing.json'))).toThrow(NativeConfigLoadError);
  });

  it('throws NativeConfigLoadError on invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-native-config-path-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{not json', 'utf-8');
    expect(() => loadNativeProductConfigFile(path)).toThrow(NativeConfigLoadError);
  });

  it('throws NativeConfigLoadError on a legacy-shaped file (unrecognized keys)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-native-config-path-'));
    const path = join(dir, 'legacy.json');
    writeFileSync(path, JSON.stringify({ network: 'testnet', rpcUrl: 'https://sepolia.base.org', tasks: [], apiPort: 7331 }), 'utf-8');
    expect(() => loadNativeProductConfigFile(path)).toThrow(NativeConfigLoadError);
  });

  it('returns the strictly-parsed config on success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-native-config-path-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'native-config.json');
    writeFileSync(path, JSON.stringify(validNativeProductFileContent(), null, 2), 'utf-8');
    const config = loadNativeProductConfigFile(path);
    expect(config.network).toBe('testnet');
    expect(config.operator.verticalMode).toBe('native-v1');
    expect(config.operator.native.role).toBe('solver');
  });
});
