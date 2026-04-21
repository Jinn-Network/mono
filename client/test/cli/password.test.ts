import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePasswordFdFromArgv, resolveCliPassword } from '../../src/cli/password.js';

describe('resolveCliPassword', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'jinn-pw-test-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function writePasswordFile(value: string): void {
    const dir = join(fakeHome, '.jinn-client');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keystore-password'), value, { mode: 0o600 });
  }

  it('returns env password when set', () => {
    const r = resolveCliPassword([], { HOME: fakeHome, JINN_PASSWORD: 'secret' });
    expect(r).toEqual({ ok: true, password: 'secret' });
  });

  it('prefers env over the keystore-password file', () => {
    writePasswordFile('from-file\n');
    const r = resolveCliPassword([], { HOME: fakeHome, JINN_PASSWORD: 'from-env' });
    expect(r).toEqual({ ok: true, password: 'from-env' });
  });

  it('falls back to the keystore-password file when env and fd are unset', () => {
    writePasswordFile('from-file\n');
    const r = resolveCliPassword([], { HOME: fakeHome });
    expect(r).toEqual({ ok: true, password: 'from-file' });
  });

  it('ignores an empty keystore-password file', () => {
    writePasswordFile('   \n');
    const r = resolveCliPassword([], { HOME: fakeHome });
    expect(r.ok).toBe(false);
  });

  it('fails when env, fd, and file are all absent', () => {
    const r = resolveCliPassword([], { HOME: fakeHome });
    expect(r.ok).toBe(false);
  });

  it('parses --password-fd index from argv', () => {
    expect(parsePasswordFdFromArgv(['--password-fd', '3'])).toBe(3);
    expect(parsePasswordFdFromArgv([])).toBeUndefined();
  });
});
