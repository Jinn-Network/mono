import { recoverAddress } from 'viem';
import type { Check } from '../types.js';
import type { PredictionV0Intent, PredictionSubmissionManifest } from '../../../../types/prediction.js';

/**
 * Window-bounds integrity. We no longer pin an exact duration — the schema
 * enforces sane min/max bounds (1min ≤ window ≤ 24h; 0 ≤ resolveGap ≤ 1h),
 * so this check just re-verifies those invariants at eval time in case the
 * manifest was built against an older schema version.
 */
const MIN_WINDOW_MS = 60_000;
const MAX_WINDOW_MS = 86_400_000;
const MAX_RESOLVE_GAP_MS = 3_600_000;

export function checkWindowBounds(intent: PredictionV0Intent): Check {
  const wDelta = intent.window.endTs - intent.window.startTs;
  if (wDelta < MIN_WINDOW_MS || wDelta > MAX_WINDOW_MS) {
    return {
      name: 'integrity.window_bounds',
      status: 'FAIL',
      detail: {
        reason: 'window out of bounds',
        got: wDelta,
        min: MIN_WINDOW_MS,
        max: MAX_WINDOW_MS,
      },
    };
  }
  const rDelta = intent.spec.question.resolveTs - intent.window.endTs;
  if (rDelta < 0 || rDelta > MAX_RESOLVE_GAP_MS) {
    return {
      name: 'integrity.window_bounds',
      status: 'FAIL',
      detail: {
        reason: 'resolve gap out of bounds',
        got: rDelta,
        min: 0,
        max: MAX_RESOLVE_GAP_MS,
      },
    };
  }
  return { name: 'integrity.window_bounds', status: 'PASS' };
}

export function checkManifestFieldsPresent(
  prediction: PredictionSubmissionManifest['prediction'],
): Check {
  const p = Number(prediction.probability);
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    return {
      name: 'integrity.manifest_fields_present',
      status: 'FAIL',
      detail: { field: 'probability', got: prediction.probability },
    };
  }
  if (!prediction.modelId || prediction.modelId.length === 0) {
    return {
      name: 'integrity.manifest_fields_present',
      status: 'FAIL',
      detail: { field: 'modelId' },
    };
  }
  if (!Number.isInteger(prediction.submittedAt)) {
    return {
      name: 'integrity.manifest_fields_present',
      status: 'FAIL',
      detail: { field: 'submittedAt' },
    };
  }
  return { name: 'integrity.manifest_fields_present', status: 'PASS' };
}

export async function checkManifestSignature(
  canonicalHash: `0x${string}`,
  signature: PredictionSubmissionManifest['signature'],
): Promise<Check> {
  if (signature.algo !== 'secp256k1') {
    return { name: 'integrity.manifest_signature', status: 'FAIL', detail: 'non-secp256k1 signature' };
  }
  if (signature.hash !== canonicalHash) {
    return { name: 'integrity.manifest_signature', status: 'FAIL', detail: 'hash mismatch' };
  }
  try {
    const recovered = await recoverAddress({ hash: canonicalHash, signature: signature.sig as `0x${string}` });
    const ok = recovered.toLowerCase() === signature.signer.toLowerCase();
    return {
      name: 'integrity.manifest_signature',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok ? undefined : { recovered, expected: signature.signer },
    };
  } catch (err) {
    return { name: 'integrity.manifest_signature', status: 'FAIL', detail: String(err) };
  }
}

/** Verify the restorer's claimed intent CID matches the on-chain request. */
export function checkIntentRef(manifestIntentCid: string, expectedIntentCid: string): Check {
  return {
    name: 'integrity.intent_ref',
    status: manifestIntentCid === expectedIntentCid ? 'PASS' : 'FAIL',
    detail: manifestIntentCid === expectedIntentCid ? undefined : { manifestIntentCid, expectedIntentCid },
  };
}
