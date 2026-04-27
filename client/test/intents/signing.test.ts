import { describe, it, expect } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { signIntentV1 } from '../../src/intents/signing.js';
import { parseSignedIntentV1, type IntentV1 } from '../../src/types/intent.js';

describe('signIntentV1', () => {
  it('produces a SignedIntentV1 that round-trips through parseSignedIntentV1', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const intent: IntentV1 = {
      schemaVersion: 'intent.v1',
      id: '550e8400-e29b-41d4-a716-446655440000',
      kind: 'portfolio.v0',
      description: 'trade',
      window: { startTs: 1, endTs: 86400001 },
      spec: { kind: 'portfolio.v0' },
      eligibility: {},
      creator: {
        safeAddress: '0x3333333333333333333333333333333333333333',
        agentEoa: account.address,
      },
      createdAt: 1700000000000,
    };

    const signed = await signIntentV1(intent, pk);

    expect(signed.signature.algo).toBe('secp256k1');
    expect(signed.signature.signer.toLowerCase()).toBe(account.address.toLowerCase());
    expect(signed.signature.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.signature.sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(() => parseSignedIntentV1(signed)).not.toThrow();
  });

  it('is deterministic for the same input', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const intent: IntentV1 = {
      schemaVersion: 'intent.v1',
      id: 'abc',
      kind: 'portfolio.v0',
      description: 'trade',
      window: { startTs: 1, endTs: 86400001 },
      spec: { kind: 'portfolio.v0' },
      eligibility: {},
      creator: {
        safeAddress: '0x3333333333333333333333333333333333333333',
        agentEoa: account.address,
      },
      createdAt: 1700000000000,
    };

    const s1 = await signIntentV1(intent, pk);
    const s2 = await signIntentV1(intent, pk);
    expect(s1.signature.hash).toBe(s2.signature.hash);
    expect(s1.signature.sig).toBe(s2.signature.sig);
  });

  it('produces hash = keccak256(JCS(intent without signature))', async () => {
    const { keccak256, toBytes } = await import('viem');
    const { canonicalJson } = await import('../../src/restorer/engine/canonical-json.js');

    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const intent: IntentV1 = {
      schemaVersion: 'intent.v1',
      id: 'xyz',
      kind: 'portfolio.v0',
      description: 'x',
      window: { startTs: 1, endTs: 86400001 },
      spec: { kind: 'portfolio.v0' },
      eligibility: {},
      creator: {
        safeAddress: '0x3333333333333333333333333333333333333333',
        agentEoa: account.address,
      },
      createdAt: 1,
    };

    const expectedHash = keccak256(toBytes(canonicalJson(intent)));

    const signed = await signIntentV1(intent, pk);
    expect(signed.signature.hash).toBe(expectedHash);
  });
});
