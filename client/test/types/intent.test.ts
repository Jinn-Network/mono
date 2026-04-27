import { describe, it, expect } from 'vitest';
import {
  IntentV1Schema,
  SignedIntentV1Schema,
  parseIntentV1,
  parseSignedIntentV1,
} from '../../src/types/intent.js';

describe('IntentV1Schema', () => {
  const valid = {
    schemaVersion: 'intent.v1',
    id: '550e8400-e29b-41d4-a716-446655440000',
    kind: 'portfolio.v0',
    description: 'trade one day on HL',
    window: { startTs: 1000, endTs: 87400000 },
    spec: { kind: 'portfolio.v0', account: { venue: 'hyperliquid-testnet', masterAddress: '0xabc' } },
    eligibility: { minClosedTrades: 20 },
    creator: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    createdAt: 1700000000000,
  };

  it('accepts a well-formed intent', () => {
    expect(() => IntentV1Schema.parse(valid)).not.toThrow();
  });

  it('rejects wrong schemaVersion', () => {
    expect(() => IntentV1Schema.parse({ ...valid, schemaVersion: 'intent.v2' })).toThrow();
  });

  it('rejects missing creator', () => {
    const { creator: _c, ...missing } = valid;
    expect(() => IntentV1Schema.parse(missing)).toThrow();
  });

  it('rejects empty description', () => {
    expect(() => IntentV1Schema.parse({ ...valid, description: '' })).toThrow();
  });

  it('rejects non-integer timestamps', () => {
    expect(() => IntentV1Schema.parse({ ...valid, createdAt: 1700000000.5 })).toThrow();
  });

  it('rejects kind mismatch between top-level and spec.kind', () => {
    expect(() =>
      IntentV1Schema.parse({
        ...valid,
        kind: 'portfolio.v0',
        spec: { ...valid.spec, kind: 'prediction.v0' },
      }),
    ).toThrow();
  });
});

describe('SignedIntentV1Schema', () => {
  const validIntent = {
    schemaVersion: 'intent.v1',
    id: '550e8400-e29b-41d4-a716-446655440000',
    kind: 'portfolio.v0',
    description: 'trade one day on HL',
    window: { startTs: 1000, endTs: 87400000 },
    spec: { kind: 'portfolio.v0', account: { venue: 'hyperliquid-testnet', masterAddress: '0xabc' } },
    eligibility: {},
    creator: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    createdAt: 1700000000000,
  };

  const validSignature = {
    algo: 'secp256k1' as const,
    signer: '0x2222222222222222222222222222222222222222',
    hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    sig: '0x' + 'aa'.repeat(65),
  };

  it('accepts a valid signed intent', () => {
    const signed = { ...validIntent, signature: validSignature };
    expect(() => SignedIntentV1Schema.parse(signed)).not.toThrow();
  });

  it('rejects a signed intent missing signature', () => {
    expect(() => SignedIntentV1Schema.parse(validIntent)).toThrow();
  });

  it('rejects wrong signature algo', () => {
    const signed = {
      ...validIntent,
      signature: { ...validSignature, algo: 'ed25519' },
    };
    expect(() => SignedIntentV1Schema.parse(signed)).toThrow();
  });
});

describe('parseIntentV1', () => {
  it('returns a typed intent on valid input', () => {
    const valid = {
      schemaVersion: 'intent.v1',
      id: '550e8400-e29b-41d4-a716-446655440000',
      kind: 'portfolio.v0',
      description: 'x',
      window: { startTs: 1, endTs: 2 },
      spec: { kind: 'portfolio.v0' },
      eligibility: {},
      creator: { safeAddress: '0xaaa', agentEoa: '0xbbb' },
      createdAt: 1,
    };
    const parsed = parseIntentV1(valid);
    expect(parsed.kind).toBe('portfolio.v0');
    expect(parsed.schemaVersion).toBe('intent.v1');
  });

  it('throws ZodError on invalid input', () => {
    expect(() => parseIntentV1({ bogus: 'data' })).toThrow();
  });
});
