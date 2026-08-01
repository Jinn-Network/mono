/**
 * Derives the two host-side synchronous signing surfaces `composition-root.ts`'s
 * `CompositionRootInput` accepts — `deliverySigningKey` (finding E31) and `legacyBridgeSigner`
 * (C7 / finding E24) — ruled "wire it" (E36 ruling 3). Both derive from the SAME agent-EOA
 * secp256k1 private key `main.ts` already decrypts from the operator's keystore for every other
 * trust surface (`envelopeDeps.agentEoaPrivateKey`, `identityPublisher`'s signer, `deliveryDeps`'s
 * wallet client). No new custody surface: both are pure, host-side, in-memory functions of that
 * one already-decrypted key — neither is written to disk, persisted separately, or exported from
 * this process.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { Hex } from 'viem';

/**
 * `legacyBridgeSigner` (secp256k1, C7 / finding E24): the operator's own agent-EOA key, signing
 * synchronously. `composition-root.ts`'s only prior signer (`input.walletClient`) is async-only
 * (remote-signer/hardware-wallet compatible) — this supplies the missing synchronous surface,
 * the SAME raw key already reused across this daemon's other on-chain signing contexts
 * (`envelopeDeps`, `deliveryDeps`, `identityPublisher`), with no domain separation from those
 * uses — matching that existing precedent, where this key already crosses those contexts
 * unseparated.
 *
 * Byte order matches `client/test/bridge/converged-delivery-legacy-evaluator.test.ts`'s `syncSign`
 * fixture and `harnesses/engine/signing.ts`'s convention: `@noble/curves`' own `'recovered'`
 * format puts the recovery byte FIRST; this reorders to r||s||recovery.
 */
export function deriveLegacyBridgeSigner(agentPrivateKey: Hex): (hash: Hex) => Hex {
  const privateKeyBytes = new Uint8Array(Buffer.from(agentPrivateKey.slice(2), 'hex'));
  return (hash: Hex): Hex => {
    const message = Buffer.from(hash.slice(2), 'hex');
    const recovered = secp256k1.sign(message, privateKeyBytes, { prehash: false, format: 'recovered' });
    const recovery = recovered[0]!;
    const rs = Buffer.from(recovered.slice(1));
    return `0x${rs.toString('hex')}${recovery.toString(16).padStart(2, '0')}` as Hex;
  };
}

export interface DeliverySigningKey {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  sign(payload: Uint8Array): Uint8Array;
}

/** Domain-separation label for the Ed25519 delivery-signing seed derivation below. */
const DELIVERY_KEY_DOMAIN = 'jinn.daemon.delivery-signing-key.v1';

/** Minimal PKCS8 DER prefix for a raw 32-byte Ed25519 private-key seed (RFC 8410 §7). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * `deliverySigningKey` (Ed25519, finding E31): NOT the agent EOA key directly — Ed25519 and
 * secp256k1 are different curves, and Node's public API has no seed-accepting Ed25519 keygen, so
 * the agent EOA key is hashed together with a fixed domain label into a 32-byte seed (keeping this
 * key's use domain-separated from the EOA key's own secp256k1 signing use, per
 * `composition-root.ts`'s own documented follow-up: "deterministically derived from the
 * operator's own wallet keystore, domain-separated from its secp256k1 signing use"), then wrapped
 * in the minimal PKCS8 DER envelope `crypto.createPrivateKey` needs for an Ed25519 key. This is
 * deterministic: the same wallet always derives the same delivery-signing identity across
 * restarts, matching `client/test/daemon/settlement-grade.test.ts`'s "REAL LocalTaskExecutionBackend
 * delivery (finding E31)" fixture shape exactly (`{keyId, sign}` signing over the digest via
 * `crypto.sign(null, payload, privateKey)`).
 */
export function deriveDeliverySigningKey(agentPrivateKey: Hex): DeliverySigningKey {
  const seed = createHash('sha256')
    .update(DELIVERY_KEY_DOMAIN)
    .update(Buffer.from(agentPrivateKey.slice(2), 'hex'))
    .digest();
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  return {
    keyId: 'operator-delivery-signing-key',
    publicKey,
    sign: (payload) => new Uint8Array(cryptoSign(null, payload, privateKey)),
  };
}
