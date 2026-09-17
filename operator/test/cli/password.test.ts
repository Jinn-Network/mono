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

  function writePasswordFile(value: string, dirName = '.jinn-client'): void {
    const dir = join(fakeHome, dirName);
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

  it('reads ~/.jinn-operator/keystore-password on a fresh home', () => {
    writePasswordFile('from-operator\n', '.jinn-operator');
    const r = resolveCliPassword([], { HOME: fakeHome });
    expect(r).toEqual({ ok: true, password: 'from-operator' });
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

  // #4375: an unusable fd must surface as this verb's `invalid_invocation`
  // envelope, never fall through to the env password.
  it('fails instead of falling back to the env password on an unusable fd', () => {
    const r = resolveCliPassword(['--password-fd='], { HOME: fakeHome, JINN_PASSWORD: 'secret' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('--password-fd');
  });
});

/**
 * #4375 — the scan matched the two-token form only and swallowed every
 * unusable value, so `--password-fd=3` and `--password-fd abc` both fell
 * through to `JINN_PASSWORD` or the keystore-password file and decrypted with
 * a different secret than the operator supplied.
 */
describe('parsePasswordFdFromArgv (#4375)', () => {
  it('reads the equals form', () => {
    expect(parsePasswordFdFromArgv(['--password-fd=3'])).toBe(3);
  });

  it('accepts fd 0 in both forms', () => {
    expect(parsePasswordFdFromArgv(['--password-fd', '0'])).toBe(0);
    expect(parsePasswordFdFromArgv(['--password-fd=0'])).toBe(0);
  });

  it('throws on an empty equals value', () => {
    expect(() => parsePasswordFdFromArgv(['--password-fd='])).toThrow(
      'Missing or invalid value for --password-fd',
    );
  });

  it('throws on a trailing bare --password-fd', () => {
    expect(() => parsePasswordFdFromArgv(['--password-fd'])).toThrow(
      'Missing or invalid value for --password-fd',
    );
  });

  it('throws on a non-numeric value', () => {
    expect(() => parsePasswordFdFromArgv(['--password-fd', 'abc'])).toThrow(
      'Missing or invalid value for --password-fd',
    );
  });

  it('throws on a negative file descriptor', () => {
    expect(() => parsePasswordFdFromArgv(['--password-fd', '-1'])).toThrow(
      'Missing or invalid value for --password-fd',
    );
  });

  // `resolveCliPassword` merges the verb argv with `process.argv`, so the flag
  // routinely appears twice; an unusable occurrence must not terminate the
  // scan before a usable later one.
  it('falls through an unusable occurrence to a later usable one', () => {
    expect(parsePasswordFdFromArgv(['--password-fd=', '--password-fd', '3'])).toBe(3);
  });

  it('does not match flags that merely start with --password-fd', () => {
    expect(parsePasswordFdFromArgv(['--password-fdx=3'])).toBeUndefined();
  });
});
