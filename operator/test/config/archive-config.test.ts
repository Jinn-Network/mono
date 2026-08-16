import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

function configFile(value: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-archive-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

const TOUCHED = [
  'JINN_PUBLIC_ARCHIVE',
  'JINN_PUBLIC_ARCHIVE_BIND_HOST',
  'JINN_PUBLIC_ARCHIVE_PORT',
];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

describe('publicArchive config', () => {
  it('defaults the public archive plane to disabled on loopback', () => {
    const cfg = loadConfig(configFile({ rpcUrl: 'http://x' }));
    expect(cfg.publicArchive).toEqual({ enabled: false, host: '127.0.0.1', port: 7332 });
  });

  it('reads the public archive block from the config FILE, not only from env', () => {
    const cfg = loadConfig(
      configFile({ rpcUrl: 'http://x', publicArchive: { enabled: true, host: '0.0.0.0', port: 7400 } }),
    );
    expect(cfg.publicArchive).toEqual({ enabled: true, host: '0.0.0.0', port: 7400 });
  });

  it('lets env override the config file, and enables on a bind-host env', () => {
    const path = configFile({ rpcUrl: 'http://x', publicArchive: { enabled: false, host: '0.0.0.0', port: 7400 } });
    process.env['JINN_PUBLIC_ARCHIVE_BIND_HOST'] = '127.0.0.1';
    process.env['JINN_PUBLIC_ARCHIVE_PORT'] = '7500';
    const cfg = loadConfig(path);
    expect(cfg.publicArchive.enabled).toBe(true);
    expect(cfg.publicArchive.host).toBe('127.0.0.1');
    expect(cfg.publicArchive.port).toBe(7500);
  });

  it('treats a bare JINN_PUBLIC_ARCHIVE as enable, and 0/false as disable', () => {
    const path = configFile({ rpcUrl: 'http://x' });
    process.env['JINN_PUBLIC_ARCHIVE'] = '';
    expect(loadConfig(path).publicArchive.enabled).toBe(true);
    process.env['JINN_PUBLIC_ARCHIVE'] = 'false';
    expect(loadConfig(path).publicArchive.enabled).toBe(false);
  });
});
