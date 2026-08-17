import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultTokenPath,
  ensureUiToken,
  ensureUiTokenRecord,
  readUiTokenRecord,
  rotateUiToken,
  tokensEqual,
  resolveStoredUiToken,
} from '../../src/api/ui-token.js';

function tmpTokenPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'jinn-ui-token-')), 'ui-token');
}

describe('ui-token (§9)', () => {
  it('defaultTokenPath lives beside daemon state, not a hardcoded homedir leaf when stateDir is passed', () => {
    expect(defaultTokenPath('/data/jinn')).toBe('/data/jinn/ui-token');
  });

  it('ensureUiToken writes JSON with expiresAt ~30 days out', () => {
    const path = tmpTokenPath();
    const now = new Date('2026-08-17T00:00:00.000Z');
    const token = ensureUiToken(path, () => now);
    const record = JSON.parse(readFileSync(path, 'utf-8')) as { token: string; expiresAt: string };
    expect(record.token).toBe(token);
    expect(record.expiresAt).toBe('2026-09-16T00:00:00.000Z');
  });

  it('rewrites a legacy 64-char hex file to JSON on ensureUiToken', () => {
    const path = tmpTokenPath();
    const hex = 'ab'.repeat(32);
    writeFileSync(path, `${hex}\n`, { mode: 0o600 });
    const now = new Date('2026-08-17T00:00:00.000Z');
    const token = ensureUiToken(path, () => now);
    expect(token).toBe(hex);
    const record = readUiTokenRecord(path, () => now);
    expect(record?.token).toBe(hex);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ token: hex });
  });

  it('rotateUiToken replaces the token', () => {
    const path = tmpTokenPath();
    const first = ensureUiToken(path);
    const second = rotateUiToken(path);
    expect(second).not.toBe(first);
    expect(readUiTokenRecord(path)?.token).toBe(second);
  });

  it('resolveStoredUiToken prefers JINN_UI_TOKEN over the file', () => {
    const path = tmpTokenPath();
    ensureUiToken(path);
    expect(resolveStoredUiToken(path, { JINN_UI_TOKEN: 'env-token-value-env-token-value' })).toBe(
      'env-token-value-env-token-value',
    );
  });

  it('resolveStoredUiToken hides an expired JSON record', () => {
    const path = tmpTokenPath();
    writeFileSync(
      path,
      JSON.stringify({ token: 'a'.repeat(64), expiresAt: '2020-01-01T00:00:00.000Z' }) + '\n',
    );
    expect(resolveStoredUiToken(path, {}, () => new Date('2026-08-17T00:00:00.000Z'))).toBeUndefined();
  });

  it('ensureUiTokenRecord rotates an expired JSON record', () => {
    const path = tmpTokenPath();
    writeFileSync(
      path,
      JSON.stringify({ token: 'a'.repeat(64), expiresAt: '2020-01-01T00:00:00.000Z' }) + '\n',
    );
    const now = new Date('2026-08-17T00:00:00.000Z');
    const record = ensureUiTokenRecord(path, () => now);
    expect(record.token).not.toBe('a'.repeat(64));
    expect(record.expiresAt).toBe('2026-09-16T00:00:00.000Z');
  });

  it('tokensEqual is length-closed and agrees on equal secrets', () => {
    expect(tokensEqual('abc', 'ab')).toBe(false);
    expect(tokensEqual('same-token-same-token-same-token', 'same-token-same-token-same-token')).toBe(true);
    expect(tokensEqual('same-token-same-token-same-token', 'other-token-other-token-other-tok')).toBe(false);
  });
});
