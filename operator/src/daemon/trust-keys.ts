/**
 * Derives the host-side synchronous signer used solely by the bridge-era legacy execution
 * envelope. Native delivery and discovery signing use persistent Ed25519 role identities from
 * `role-identities.ts`; they are never derived from the agent EOA key.
 */
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
 * Byte order matches `operator/test/bridge/converged-delivery-legacy-evaluator.test.ts`'s `syncSign`
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
