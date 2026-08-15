/**
 * §14.2 finding fix — the daemon API bearer token is now persisted beside
 * daemon state (`earningDir`-derived, mode 0600) instead of regenerated
 * fresh every boot, so an externally-installed stop-hook (the only
 * production consumer of the bearer on the stop-hook route) can resolve a
 * stable value.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  daemonApiTokenPath,
  ensureDaemonApiToken,
  readDaemonApiToken,
  resolveEarningDirFromEnv,
} from '../../src/api/daemon-token.js';

let earningDir: string;

afterEach(() => {
  if (earningDir) rmSync(earningDir, { recursive: true, force: true });
});

describe('ensureDaemonApiToken', () => {
  it('generates and persists a fresh token (mode 0600) when none exists', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = daemonApiTokenPath(earningDir);

    const result = ensureDaemonApiToken(path);
    expect(result.source).toBe('generated');
    expect(result.token).toHaveLength(64);
    expect(readFileSync(path, 'utf-8').trim()).toBe(result.token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reuses the persisted token across calls — stable across boots', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = daemonApiTokenPath(earningDir);

    const first = ensureDaemonApiToken(path);
    const second = ensureDaemonApiToken(path);
    expect(second.source).toBe('file');
    expect(second.token).toBe(first.token);
  });

  it('regenerates when the persisted value is too short to trust', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = daemonApiTokenPath(earningDir);
    mkdirSync(earningDir, { recursive: true });
    writeFileSync(path, 'too-short\n');

    const result = ensureDaemonApiToken(path);
    expect(result.source).toBe('generated');
    expect(result.token.length).toBeGreaterThanOrEqual(32);
  });
});

describe('readDaemonApiToken', () => {
  it('returns null when the file does not exist — never generates', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    expect(readDaemonApiToken(daemonApiTokenPath(earningDir))).toBeNull();
  });

  it('reads back exactly what ensureDaemonApiToken persisted', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = daemonApiTokenPath(earningDir);
    const { token } = ensureDaemonApiToken(path);
    expect(readDaemonApiToken(path)).toBe(token);
  });
});

describe('resolveEarningDirFromEnv', () => {
  it('honors JINN_EARNING_DIR when set', () => {
    expect(resolveEarningDirFromEnv({ JINN_EARNING_DIR: '/custom/earning' })).toBe('/custom/earning');
  });

  it('falls back to the ~/.jinn-client/earning default', () => {
    expect(resolveEarningDirFromEnv({})).toBe(join(homedir(), '.jinn-client', 'earning'));
  });
});
