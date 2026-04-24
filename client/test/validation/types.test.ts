import { describe, it, expect } from 'vitest';
import {
  AttestationVerifyRequestSchema,
  AttestationVerifyResponseSchema,
} from '../../src/validation/types.js';

describe('AttestationVerifyRequestSchema', () => {
  const valid = {
    requestType: 'attestation-verify' as const,
    envelopeCid: 'bafy-env',
    envelopeHash: '0x' + 'ab'.repeat(32),
    challenger: '0x1111111111111111111111111111111111111111',
    sdkVersion: '1.0.0',
    createdAt: 1700000000000,
  };

  it('accepts a well-formed request', () => {
    expect(() => AttestationVerifyRequestSchema.parse(valid)).not.toThrow();
  });

  it('rejects wrong requestType', () => {
    expect(() =>
      AttestationVerifyRequestSchema.parse({ ...valid, requestType: 'other' }),
    ).toThrow();
  });
});

describe('AttestationVerifyResponseSchema', () => {
  const valid = {
    requestType: 'attestation-verify' as const,
    envelopeCid: 'bafy-env',
    verdict: 'valid' as const,
    checks: [{ name: 'quote', passed: true }],
    responder: '0x2222222222222222222222222222222222222222',
    respondedAt: 1700000000500,
  };

  it('accepts a valid verdict', () => {
    expect(() => AttestationVerifyResponseSchema.parse(valid)).not.toThrow();
  });

  it('accepts an invalid verdict with check detail', () => {
    const invalid = {
      ...valid,
      verdict: 'invalid' as const,
      checks: [{ name: 'measurement', passed: false, detail: 'mismatch' }],
    };
    expect(() => AttestationVerifyResponseSchema.parse(invalid)).not.toThrow();
  });

  it('rejects unknown verdict value', () => {
    expect(() =>
      AttestationVerifyResponseSchema.parse({ ...valid, verdict: 'maybe' }),
    ).toThrow();
  });
});
