import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isDefaultOperatorKeystore,
  passwordFileIsStale,
  writeKeystorePasswordFile,
} from '../../src/earning/password-file.js';

describe('password-file default-keystore gate', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jinn-pw-file-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('isDefaultOperatorKeystore is false when the default keystore path is absent', () => {
    const defaultEarningDir = join(home, '.jinn-operator', 'earning');
    const customEarningDir = join(home, 'op-b', 'earning');
    mkdirSync(customEarningDir, { recursive: true });
    const warnings: string[] = [];
    expect(isDefaultOperatorKeystore(defaultEarningDir, customEarningDir, (m) => warnings.push(m))).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('absent default keystore is not license to treat a legacy password file as stale', () => {
    const stateDir = join(home, '.jinn-operator');
    mkdirSync(stateDir, { recursive: true });
    const legacyPath = join(stateDir, 'keystore-password');
    const current = 'shared-legacy-password';
    writeFileSync(legacyPath, `${current}\n`, { mode: 0o600 });
    const defaultEarningDir = join(stateDir, 'earning');
    const dirA = join(home, 'op-a', 'earning');
    const dirB = join(home, 'op-b', 'earning');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const warnings: string[] = [];
    expect(
      passwordFileIsStale(
        legacyPath,
        defaultEarningDir,
        dirA,
        current,
        'brand-new-password',
        (m) => warnings.push(m),
      ),
    ).toBe(false);
  });

  it('tightens an existing password file to 0600 before rewriting the secret', () => {
    const dir = join(home, 'earning');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'keystore-password');
    writeFileSync(path, 'old-secret\n', { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    writeKeystorePasswordFile(path, 'new-secret');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf-8').trim()).toBe('new-secret');
  });
});
