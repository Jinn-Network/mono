import { describe, expect, it } from 'vitest';
import { parsePasswordFdFromArgv, resolveCliPassword } from '../../src/cli/password.js';

describe('resolveCliPassword', () => {
  it('returns env password when set', () => {
    const r = resolveCliPassword([], { JINN_PASSWORD: 'secret' });
    expect(r).toEqual({ ok: true, password: 'secret' });
  });

  it('fails when env missing and no fd flag', () => {
    const r = resolveCliPassword([], {});
    expect(r.ok).toBe(false);
  });

  it('parses --password-fd index from argv', () => {
    expect(parsePasswordFdFromArgv(['--password-fd', '3'])).toBe(3);
    expect(parsePasswordFdFromArgv([])).toBeUndefined();
  });
});
