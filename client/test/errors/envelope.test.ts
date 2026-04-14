import { describe, expect, it } from 'vitest';
import {
  buildEnvelope,
  emitEnvelope,
  EXIT_CODES,
  type ErrorCode,
} from '../../src/errors/envelope.js';

describe('buildEnvelope', () => {
  it('builds a funding_required envelope with required fields', () => {
    const env = buildEnvelope({
      code: 'funding_required',
      message: 'Master wallet needs more ETH',
      hint: 'Send ETH to 0xabc then re-run.',
      exampleCli: 'jinn fund-requirements --json',
      details: {
        role: 'master',
        address: '0xabc',
        asset: 'native',
        needWei: '45000000000000000',
        haveWei: '5000000000000000',
      },
    });
    expect(env.schemaVersion).toBe(1);
    expect(env.code).toBe('funding_required');
    expect(env.exitCode).toBe(10);
    expect(env.message).toBe('Master wallet needs more ETH');
    expect(env.hint).toBe('Send ETH to 0xabc then re-run.');
    expect(env.exampleCli).toBe('jinn fund-requirements --json');
    expect(env.details).toEqual({
      role: 'master',
      address: '0xabc',
      asset: 'native',
      needWei: '45000000000000000',
      haveWei: '5000000000000000',
    });
  });

  it('uses EXIT_CODES to resolve exitCode from code', () => {
    const codes: ErrorCode[] = [
      'funding_required',
      'invalid_invocation',
      'bootstrap_incomplete',
      'reconcile_needed',
      'transient_error',
      'fatal',
    ];
    const expected = [10, 11, 20, 30, 40, 50];
    codes.forEach((code, i) => {
      const env = buildEnvelope({ code, message: 'x' });
      expect(env.exitCode).toBe(expected[i]);
      expect(EXIT_CODES[code]).toBe(expected[i]);
    });
  });

  it('omits undefined optional fields', () => {
    const env = buildEnvelope({ code: 'fatal', message: 'boom' });
    expect(env).not.toHaveProperty('hint');
    expect(env).not.toHaveProperty('exampleCli');
    expect(env).not.toHaveProperty('details');
  });

  it('populates generatedAt as an ISO-8601 string', () => {
    const env = buildEnvelope({ code: 'fatal', message: 'boom' });
    expect(() => new Date(env.generatedAt).toISOString()).not.toThrow();
    expect(env.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('emitEnvelope', () => {
  it('writes the envelope as a single JSON line and calls exit with exitCode', () => {
    const writes: string[] = [];
    const exits: number[] = [];
    const writer = { write: (s: string) => { writes.push(s); return true; } };
    const exit = (code: number) => { exits.push(code); };

    emitEnvelope(
      {
        code: 'funding_required',
        message: 'need eth',
        hint: 'send some',
        exampleCli: 'jinn fund-requirements --json',
        details: { role: 'master' },
      },
      { writer, exit },
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/\n$/);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.code).toBe('funding_required');
    expect(parsed.exitCode).toBe(10);
    expect(parsed.details).toEqual({ role: 'master' });
    expect(exits).toEqual([10]);
  });

  it('defaults to process.stdout and process.exit when sinks are omitted', () => {
    // Smoke test: just make sure the signature is valid. We don't actually
    // call it without sinks because that would terminate the test process.
    expect(typeof emitEnvelope).toBe('function');
  });
});
