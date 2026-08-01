import { createPrivateKey, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { Hex } from 'viem';
import { deriveDeliverySigningKey, deriveLegacyBridgeSigner } from '../../src/daemon/trust-keys.js';

const AGENT_PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex;
const OTHER_AGENT_PRIVATE_KEY = `0x${'22'.repeat(32)}` as Hex;

describe('deriveDeliverySigningKey', () => {
  it('derives a real Ed25519 key whose signatures verify against its own public key', () => {
    const key = deriveDeliverySigningKey(AGENT_PRIVATE_KEY);
    const payload = new TextEncoder().encode('hello delivery');
    const sig = key.sign(payload);
    expect(cryptoVerify(null, payload, key.publicKey, sig)).toBe(true);
  });

  it('is deterministic: the same agent key always derives the same delivery identity', () => {
    const a = deriveDeliverySigningKey(AGENT_PRIVATE_KEY);
    const b = deriveDeliverySigningKey(AGENT_PRIVATE_KEY);
    expect(a.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
      b.publicKey.export({ type: 'spki', format: 'der' }),
    );
    expect(a.keyId).toBe(b.keyId);
  });

  it('derives a distinct identity for a distinct agent key (domain-separated per operator)', () => {
    const a = deriveDeliverySigningKey(AGENT_PRIVATE_KEY);
    const b = deriveDeliverySigningKey(OTHER_AGENT_PRIVATE_KEY);
    expect(a.publicKey.export({ type: 'spki', format: 'der' })).not.toEqual(
      b.publicKey.export({ type: 'spki', format: 'der' }),
    );
  });

  it('is not the raw agent key reinterpreted as an Ed25519 seed (real domain separation)', () => {
    // If the derivation were `agentPrivateKey` used verbatim as the Ed25519 seed, the derived
    // public key would just be `ed25519(agentPrivateKeyBytes)`. It must not be.
    const key = deriveDeliverySigningKey(AGENT_PRIVATE_KEY);
    const rawSeedDer = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(AGENT_PRIVATE_KEY.slice(2), 'hex'),
    ]);
    const rawSeedPublicKey = createPublicKey(
      createPrivateKey({ key: rawSeedDer, format: 'der', type: 'pkcs8' }),
    );
    expect(key.publicKey.export({ type: 'spki', format: 'der' })).not.toEqual(
      rawSeedPublicKey.export({ type: 'spki', format: 'der' }),
    );
  });
});

describe('deriveLegacyBridgeSigner', () => {
  it('derives a synchronous secp256k1 signer whose signatures verify against the agent public key', () => {
    const sign = deriveLegacyBridgeSigner(AGENT_PRIVATE_KEY);
    const publicKey = secp256k1.getPublicKey(Buffer.from(AGENT_PRIVATE_KEY.slice(2), 'hex'), false);
    const hash = `0x${'ab'.repeat(32)}` as Hex;
    const sig = sign(hash);

    // 65-byte signature: r(32) || s(32) || recovery(1), hex-encoded.
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);

    const message = Buffer.from(hash.slice(2), 'hex');
    const rs = Buffer.from(sig.slice(2, 2 + 128), 'hex');
    expect(secp256k1.verify(rs, message, publicKey, { prehash: false })).toBe(true);
  });

  it('is deterministic for the same key and hash (RFC 6979)', () => {
    const sign = deriveLegacyBridgeSigner(AGENT_PRIVATE_KEY);
    const hash = `0x${'ab'.repeat(32)}` as Hex;
    expect(sign(hash)).toBe(sign(hash));
  });

  it('produces a signature that does not verify against an unrelated agent key', () => {
    const sign = deriveLegacyBridgeSigner(AGENT_PRIVATE_KEY);
    const otherPublicKey = secp256k1.getPublicKey(
      Buffer.from(OTHER_AGENT_PRIVATE_KEY.slice(2), 'hex'),
      false,
    );
    const hash = `0x${'ab'.repeat(32)}` as Hex;
    const sig = sign(hash);
    const message = Buffer.from(hash.slice(2), 'hex');
    const rs = Buffer.from(sig.slice(2, 2 + 128), 'hex');
    expect(secp256k1.verify(rs, message, otherPublicKey, { prehash: false })).toBe(false);
  });
});
