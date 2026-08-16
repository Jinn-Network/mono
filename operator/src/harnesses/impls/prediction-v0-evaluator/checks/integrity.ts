import { keccak256, recoverAddress } from 'viem';
import { canonicalJson } from '../../../../util/canonical-json.js';
import type { Check } from '../types.js';
import type { PredictionV0Task } from '../../../../types/prediction.js';
import type { PredictionV0RestorationPayload } from '../../../../types/payloads/prediction-v0.js';
import type { SignedEnvelope } from '../../../../types/envelope.js';

/**
 * Window-bounds integrity. We no longer pin an exact duration — the schema
 * enforces sane min/max bounds (1min ≤ window ≤ 24h; 0 ≤ resolveGap ≤ 1h),
 * so this check just re-verifies those invariants at eval time in case the
 * manifest was built against an older schema version.
 */
const MIN_WINDOW_MS = 60_000;
const MAX_WINDOW_MS = 86_400_000;
const MAX_RESOLVE_GAP_MS = 3_600_000;

export function checkWindowBounds(task: PredictionV0Task): Check {
  const wDelta = task.window.endTs - task.window.startTs;
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
  const rDelta = task.spec.question.resolveTs - task.window.endTs;
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
  prediction: PredictionV0RestorationPayload['prediction'],
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

/**
 * Recompute keccak256 over the canonical JSON of the top-level object after
 * removing `signature` — the same pre-image the harness `signCanonical` hashes.
 */
export function recomputeTopLevelSignatureHash(manifest: Record<string, unknown>): `0x${string}` {
  const { signature: _sig, ...unsigned } = manifest;
  return keccak256(new TextEncoder().encode(canonicalJson(unsigned))) as `0x${string}`;
}

export async function checkManifestSignature(
  canonicalHash: `0x${string}`,
  signature: SignedEnvelope['signature'],
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

/** Verify the harness's claimed task CID matches the on-chain request. */
export function checkTaskRef(manifestTaskCid: string, expectedTaskCid: string): Check {
  return {
    name: 'integrity.signedTask_ref',
    status: manifestTaskCid === expectedTaskCid ? 'PASS' : 'FAIL',
    detail: manifestTaskCid === expectedTaskCid ? undefined : { manifestTaskCid, expectedTaskCid },
  };
}

export function checkTaskRefMissingExpected(): Check {
  return {
    name: 'integrity.signedTask_ref',
    status: 'INDETERMINATE',
    detail: {
      reason:
        'context.solutionTaskCid missing; cannot verify submission.task.cid trustlessly',
    },
  };
}
