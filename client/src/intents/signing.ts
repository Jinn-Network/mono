/**
 * intent.v1 signing.
 *
 * Produces a SignedIntentV1 from an IntentV1 + a private key, matching the
 * envelope signing pattern in scope v0.9 §4.2a: JCS(intent minus signature)
 * → keccak256 → sign with agent EOA key.
 *
 * Reuses the signCanonical primitive from the restorer engine — one signing
 * implementation for the whole client.
 */

import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { signCanonical } from '../restorer/engine/signing.js';
import type { IntentV1, SignedIntentV1 } from '../types/intent.js';

export async function signIntentV1(intent: IntentV1, privateKey: Hex): Promise<SignedIntentV1> {
  const account = privateKeyToAccount(privateKey);
  const signerAddress = account.address as `0x${string}`;
  const signed = await signCanonical(intent, privateKey, signerAddress);
  return {
    ...intent,
    signature: {
      algo: 'secp256k1',
      signer: account.address,
      hash: signed.hash,
      sig: signed.sig,
    },
  };
}
