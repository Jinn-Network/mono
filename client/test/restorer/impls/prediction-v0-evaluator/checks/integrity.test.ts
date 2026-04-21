import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToHex } from 'viem';
import {
  checkWindowBounds,
  checkManifestFieldsPresent,
  checkManifestSignature,
  checkIntentRef,
} from '../../../../../src/restorer/impls/prediction-v0-evaluator/checks/integrity.js';

const validIntent = {
  window: { startTs: 0, endTs: 3_600_000 },
  spec: {
    question: { kind: 'threshold' as const, operator: 'GT' as const, threshold: '3500', resolveTs: 4_500_000 },
  },
};

describe('integrity.window_bounds', () => {
  it('PASS on valid bounds', () => {
    expect(checkWindowBounds(validIntent as any).status).toBe('PASS');
  });
  it('FAIL when window not exactly 1h', () => {
    const bad = { ...validIntent, window: { startTs: 0, endTs: 3_600_001 } };
    expect(checkWindowBounds(bad as any).status).toBe('FAIL');
  });
  it('FAIL when resolveTs != endTs + 15min', () => {
    const bad = {
      ...validIntent,
      spec: { ...validIntent.spec, question: { ...validIntent.spec.question, resolveTs: 4_500_001 } },
    };
    expect(checkWindowBounds(bad as any).status).toBe('FAIL');
  });
});

describe('integrity.manifest_fields_present', () => {
  it('PASS on valid probability + modelId + submittedAt', () => {
    const r = checkManifestFieldsPresent({ probability: '0.55', modelId: 'spot-carry.v1', submittedAt: 1000 } as any);
    expect(r.status).toBe('PASS');
  });
  it('FAIL on probability out of range', () => {
    expect(checkManifestFieldsPresent({ probability: '1.5', modelId: 'x', submittedAt: 1 } as any).status).toBe('FAIL');
    expect(checkManifestFieldsPresent({ probability: '-0.1', modelId: 'x', submittedAt: 1 } as any).status).toBe('FAIL');
  });
  it('FAIL on empty modelId', () => {
    expect(checkManifestFieldsPresent({ probability: '0.5', modelId: '', submittedAt: 1 } as any).status).toBe('FAIL');
  });
});

describe('integrity.manifest_signature', () => {
  it('PASS when signature verifies for the claimed signer', async () => {
    const pk = '0x' + '1'.repeat(64) as `0x${string}`;
    const account = privateKeyToAccount(pk);
    const canonicalHash = keccak256(stringToHex('canonical-json-without-signature'));
    const sig = await account.sign({ hash: canonicalHash });
    const r = await checkManifestSignature(canonicalHash, {
      algo: 'secp256k1' as const, signer: account.address, hash: canonicalHash, sig,
    });
    expect(r.status).toBe('PASS');
  });
  it('FAIL on bad sig', async () => {
    const r = await checkManifestSignature(
      '0x' + '0'.repeat(64) as `0x${string}`,
      { algo: 'secp256k1' as const, signer: '0x0000000000000000000000000000000000000001', hash: '0x' + '0'.repeat(64), sig: '0x' + '0'.repeat(130) } as any,
    );
    expect(r.status).toBe('FAIL');
  });
});

describe('integrity.intent_ref', () => {
  it('PASS when manifest.intent.cid matches expected', () => {
    const r = checkIntentRef('cid-match', 'cid-match');
    expect(r.status).toBe('PASS');
  });
  it('FAIL when mismatched', () => {
    const r = checkIntentRef('cid-a', 'cid-b');
    expect(r.status).toBe('FAIL');
  });
});
