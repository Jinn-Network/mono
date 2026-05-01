import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnvelope } from '../../src/errors/envelope.js';
import {
  clearBootstrapError,
  persistBootstrapError,
  readBootstrapError,
} from '../../src/errors/persisted-bootstrap-error.js';

describe('persistBootstrapError', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-boot-err-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the envelope to bootstrap-error.json with mode 0600', () => {
    const env = buildEnvelope({
      code: 'fatal',
      message: 'stOLAS stake() reverted',
      hint: 'check the L2 distributor',
      details: { txHash: '0xabc', cause: 'reverted' },
    });
    persistBootstrapError(env, dir);

    const path = join(dir, 'bootstrap-error.json');
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);

    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(parsed.code).toBe('fatal');
    expect(parsed.message).toBe('stOLAS stake() reverted');
    expect(parsed.details).toEqual({ txHash: '0xabc', cause: 'reverted' });
  });

  it('roundtrips through readBootstrapError', () => {
    const env = buildEnvelope({ code: 'fatal', message: 'boom' });
    persistBootstrapError(env, dir);
    const got = readBootstrapError(dir);
    expect(got).not.toBeNull();
    expect(got!.code).toBe('fatal');
    expect(got!.message).toBe('boom');
    expect(got!.exitCode).toBe(50);
  });

  it('readBootstrapError returns null when no file exists', () => {
    expect(readBootstrapError(dir)).toBeNull();
  });

  it('readBootstrapError returns null on malformed JSON', () => {
    const path = join(dir, 'bootstrap-error.json');
    require('node:fs').writeFileSync(path, 'not-json');
    expect(readBootstrapError(dir)).toBeNull();
  });

  it('clearBootstrapError removes the file (idempotent)', () => {
    const env = buildEnvelope({ code: 'fatal', message: 'boom' });
    persistBootstrapError(env, dir);
    expect(readBootstrapError(dir)).not.toBeNull();

    clearBootstrapError(dir);
    expect(readBootstrapError(dir)).toBeNull();

    // second call is a no-op
    expect(() => clearBootstrapError(dir)).not.toThrow();
  });

  it('persistBootstrapError creates the dir if missing', () => {
    const nested = join(dir, 'does-not-exist-yet');
    const env = buildEnvelope({ code: 'fatal', message: 'boom' });
    persistBootstrapError(env, nested);
    expect(existsSync(join(nested, 'bootstrap-error.json'))).toBe(true);
  });
});
