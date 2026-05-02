import { describe, it, expect } from 'vitest';
import {
  TaskV1Schema,
  SignedTaskV1Schema,
  parseTaskV1,
  parseSignedTaskV1,
} from '../../src/types/task-document.js';

describe('TaskV1Schema', () => {
  const valid = {
    schemaVersion: 'task.v1',
    id: '550e8400-e29b-41d4-a716-446655440000',
    solverType: 'portfolio.v0',
    role: 'restoration',
    description: 'trade one day on HL',
    window: { startTs: 1000, endTs: 87400000 },
    spec: { account: { venue: 'hyperliquid-testnet', masterAddress: '0xabc' } },
    eligibility: { minClosedTrades: 20 },
    creator: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    createdAt: 1700000000000,
  };

  it('accepts a well-formed Task', () => {
    expect(() => TaskV1Schema.parse(valid)).not.toThrow();
  });

  it('rejects wrong schemaVersion', () => {
    expect(() => TaskV1Schema.parse({ ...valid, schemaVersion: 'task.v2' })).toThrow();
  });

  it('rejects missing creator', () => {
    const { creator: _c, ...missing } = valid;
    expect(() => TaskV1Schema.parse(missing)).toThrow();
  });

  it('rejects empty description', () => {
    expect(() => TaskV1Schema.parse({ ...valid, description: '' })).toThrow();
  });

  it('rejects non-integer timestamps', () => {
    expect(() => TaskV1Schema.parse({ ...valid, createdAt: 1700000000.5 })).toThrow();
  });

  it('rejects retired spec.kind', () => {
    expect(() =>
      TaskV1Schema.parse({
        ...valid,
        spec: { ...valid.spec, kind: 'prediction.v0' },
      }),
    ).toThrow();
  });
});

describe('SignedTaskV1Schema', () => {
  const validTask = {
    schemaVersion: 'task.v1',
    id: '550e8400-e29b-41d4-a716-446655440000',
    solverType: 'portfolio.v0',
    role: 'restoration',
    description: 'trade one day on HL',
    window: { startTs: 1000, endTs: 87400000 },
    spec: { account: { venue: 'hyperliquid-testnet', masterAddress: '0xabc' } },
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

  it('accepts a valid signed Task', () => {
    const signed = { ...validTask, signature: validSignature };
    expect(() => SignedTaskV1Schema.parse(signed)).not.toThrow();
  });

  it('rejects a signed Task missing signature', () => {
    expect(() => SignedTaskV1Schema.parse(validTask)).toThrow();
  });

  it('rejects wrong signature algo', () => {
    const signed = {
      ...validTask,
      signature: { ...validSignature, algo: 'ed25519' },
    };
    expect(() => SignedTaskV1Schema.parse(signed)).toThrow();
  });
});

describe('parseTaskV1', () => {
  it('returns a typed Task on valid input', () => {
    const valid = {
      schemaVersion: 'task.v1',
      id: '550e8400-e29b-41d4-a716-446655440000',
      solverType: 'portfolio.v0',
      role: 'restoration',
      description: 'x',
      window: { startTs: 1, endTs: 2 },
      spec: {},
      eligibility: {},
      creator: { safeAddress: '0xaaa', agentEoa: '0xbbb' },
      createdAt: 1,
    };
    const parsed = parseTaskV1(valid);
    expect(parsed.solverType).toBe('portfolio.v0');
    expect(parsed.schemaVersion).toBe('task.v1');
  });

  it('throws ZodError on invalid input', () => {
    expect(() => parseTaskV1({ bogus: 'data' })).toThrow();
  });
});
