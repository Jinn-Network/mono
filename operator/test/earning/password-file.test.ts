import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isDefaultOperatorKeystore,
  passwordFileIsStale,
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
});
