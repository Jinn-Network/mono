/**
 * Layer 1 envelope check: canonical hash + signature validity.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §4.10.
 *
 * Two assertions combined into one check:
 *   1. Hash integrity — recompute keccak256(JCS(envelope minus signature)) and
 *      verify it matches envelope.signature.hash.
 *   2. Signature validity — recover the signer from (hash, sig) via secp256k1
 *      ECDSA and verify it matches envelope.signature.signer.
 *
 * Both must pass for the check to pass.
 */

import { keccak256, toBytes, recoverAddress, type Hex } from 'viem';
import { canonicalJson } from '../../util/canonical-json.js';
import type { CheckResult, ConformanceContext } from '../types.js';

/**
 * Check id: `envelope.hash-signature`
 * Layer: 1
 *
 * Steps:
 *   1. Strip `signature` from the envelope object.
 *   2. Compute `keccak256(toBytes(canonicalJson(envelopeMinusSignature)))`.
 *   3. Compare to `envelope.signature.hash` — fail if mismatch.
 *   4. Call `recoverAddress({ hash, signature: sig })` — fail if throws or
 *      recovered address does not match `envelope.signature.signer`.
 */
export async function checkHashAndSignature(ctx: ConformanceContext): Promise<CheckResult> {
  const id = 'envelope.hash-signature';
  const layer = 1 as const;

  if (!ctx.envelope) {
    return { id, layer, passed: false, detail: 'envelope not loaded' };
  }

  const rawEnvelope = ctx.rawEnvelope ?? ctx.envelope;
  const { signature: _rawSignature, ...unsigned } = rawEnvelope;
  const { signature } = ctx.envelope;

  // Step 1: Recompute hash over the unsigned wire fields (JCS → keccak256).
  // The schema normalizes legacy role='restoration' to role='solution' on
  // parse, but old artifacts were signed over the original wire value.
  const recomputed = keccak256(toBytes(canonicalJson(unsigned)));

  // Step 2: Verify the stored hash matches the recomputed hash.
  if (recomputed.toLowerCase() !== signature.hash.toLowerCase()) {
    return {
      id,
      layer,
      passed: false,
      detail: `signature.hash ${signature.hash} does not match keccak256(JCS(envelope-signature))=${recomputed}`,
    };
  }

  // Step 3: Recover signer from (hash, sig) and compare to declared signer.
  try {
    const recovered = await recoverAddress({
      hash: signature.hash as Hex,
      signature: signature.sig as Hex,
    });
    if (recovered.toLowerCase() !== signature.signer.toLowerCase()) {
      return {
        id,
        layer,
        passed: false,
        detail: `recovered signer ${recovered} does not match declared signer ${signature.signer}`,
      };
    }
  } catch (err) {
    return {
      id,
      layer,
      passed: false,
      detail: `signature recovery failed: ${(err as Error).message}`,
    };
  }

  return { id, layer, passed: true };
}
