import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { Hex } from 'viem';
import { deriveLegacyBridgeSigner } from '../../src/daemon/trust-keys.js';

const AGENT_PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex;
const OTHER_AGENT_PRIVATE_KEY = `0x${'22'.repeat(32)}` as Hex;

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
