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
  resolveDaemonApiToken,
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

  it('falls back to the ~/.jinn-operator/earning default on a fresh home', () => {
    expect(resolveEarningDirFromEnv({})).toBe(join(homedir(), '.jinn-operator', 'earning'));
  });
});

describe('resolveEarningDirFromEnv — JINN_STATE_DIR (issue #2418)', () => {
  it('derives <stateDir>/earning from JINN_STATE_DIR, matching config.ts', () => {
    expect(resolveEarningDirFromEnv({ JINN_STATE_DIR: '/srv/jinn-state' }))
      .toBe(join('/srv/jinn-state', 'earning'));
  });

  it('lets an explicit JINN_EARNING_DIR win over JINN_STATE_DIR, matching config.ts precedence', () => {
    expect(resolveEarningDirFromEnv({
      JINN_STATE_DIR: '/srv/jinn-state',
      JINN_EARNING_DIR: '/custom/earning',
    })).toBe('/custom/earning');
  });
});

describe('resolveDaemonApiToken', () => {
  it('persists a trusted env token so an external hook resolves the live value', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = daemonApiTokenPath(earningDir);
    const stale = ensureDaemonApiToken(path).token;
    const envToken = 'e'.repeat(64);

    const resolved = resolveDaemonApiToken({ path, envToken });

    expect(resolved).toEqual({ token: envToken, source: 'env', persisted: 'written' });
    expect(readDaemonApiToken(path)).toBe(envToken);
    expect(readDaemonApiToken(path)).not.toBe(stale);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('creates the token file when an env token boots against a fresh state dir', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = join(earningDir, 'nested', 'daemon-api-token');
    const envToken = 'f'.repeat(64);

    expect(resolveDaemonApiToken({ path, envToken }).persisted).toBe('written');
    expect(readDaemonApiToken(path)).toBe(envToken);
  });

  it('reports the already-current file as unchanged rather than rewriting it', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = daemonApiTokenPath(earningDir);
    const { token } = ensureDaemonApiToken(path);

    expect(resolveDaemonApiToken({ path, envToken: token }))
      .toEqual({ token, source: 'env', persisted: 'unchanged' });
  });

  it('trims the env token before persisting it', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = daemonApiTokenPath(earningDir);
    const envToken = 'a'.repeat(64);

    expect(resolveDaemonApiToken({ path, envToken: `  ${envToken}\n` }).token).toBe(envToken);
    expect(readDaemonApiToken(path)).toBe(envToken);
  });

  it('refuses to overwrite the file with an env token below the reader trust floor, and says so', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = daemonApiTokenPath(earningDir);
    const existing = ensureDaemonApiToken(path).token;
    const warnings: string[] = [];

    const resolved = resolveDaemonApiToken({ path, envToken: 'short', warn: (m) => warnings.push(m) });

    expect(resolved).toEqual({ token: 'short', source: 'env', persisted: 'skipped' });
    expect(readDaemonApiToken(path)).toBe(existing);
    expect(warnings.join('\n')).toContain('32');
  });

  it('still boots on the env token when the file cannot be written, and warns loudly', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    // A file where the parent directory must be — mkdir/write below it must fail.
    const blocker = join(earningDir, 'blocker');
    writeFileSync(blocker, 'not-a-directory\n');
    const envToken = 'b'.repeat(64);
    const warnings: string[] = [];

    const resolved = resolveDaemonApiToken({
      path: join(blocker, 'daemon-api-token'),
      envToken,
      warn: (m) => warnings.push(m),
    });

    expect(resolved).toEqual({ token: envToken, source: 'env', persisted: 'failed' });
    expect(warnings.join('\n')).toContain('daemon-api-token');
  });

  it('falls back to the persisted file when no env token is set', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = daemonApiTokenPath(earningDir);
    const { token } = ensureDaemonApiToken(path);

    expect(resolveDaemonApiToken({ path })).toEqual({ token, source: 'file', persisted: 'unchanged' });
  });

  it('generates and persists when neither an env token nor a file exists', () => {
    earningDir = mkdtempSync(join(tmpdir(), 'jinn-daemon-token-'));
    const path = daemonApiTokenPath(earningDir);

    const resolved = resolveDaemonApiToken({ path, envToken: '   ' });

    expect(resolved.source).toBe('generated');
    expect(resolved.persisted).toBe('written');
    expect(readDaemonApiToken(path)).toBe(resolved.token);
  });
});
