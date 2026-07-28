// SPDX-License-Identifier: Apache-2.0
import { hashExactBytes } from "@jinn-network/evidence-publication";
import type { Sha256Digest } from "@jinn-network/evidence-repository";

import { canonicalJsonBytes } from "./canonical-json.js";
import type { ContributionReceipt } from "./types.js";

// Generous, fixed, internal bound on the operational payload a fingerprint
// is computed over. This is a DoS/sanity floor, independent of any
// caller-supplied `ContributionResourceLimits` (those are enforced by the
// commands that build the payload, not by the hashing primitive itself).
export const MAX_CONTRIBUTION_FINGERPRINT_INPUT_BYTES = 16 * 1024 * 1024;

/**
 * Compare two strings by UTF-16 code unit. Never locale-sensitive --
 * canonical Evidence and Contribution bytes must not depend on the host
 * locale or bundled ICU data. Use this (or a bare `.sort()`, which is
 * already code-unit by default) instead of `localeCompare`/`Intl`.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Fingerprint an arbitrary private operational record: canonicalize it to
 * exact bytes, then SHA-256 those bytes via Publication's hash helper. This
 * is Contribution's single fingerprinting primitive; every other identity
 * function in this package composes it rather than hashing independently.
 */
export function fingerprintContributionRecord(value: unknown): Sha256Digest {
  return hashExactBytes(
    canonicalJsonBytes(value, MAX_CONTRIBUTION_FINGERPRINT_INPUT_BYTES),
  );
}

export function createContributionReceiptFingerprint(
  receipt: ContributionReceipt,
): Sha256Digest {
  return fingerprintContributionRecord({
    schemaVersion: receipt.schemaVersion,
    requestId: receipt.requestId,
    status: receipt.status,
    previewFingerprint: receipt.previewFingerprint ?? null,
    destinations: [...receipt.destinations]
      .map((outcome) => ({
        destination: outcome.destination,
        status: outcome.status,
        deactivated: outcome.deactivated,
        reasonCode: outcome.reasonCode ?? null,
        publishedAt: outcome.publishedAt ?? null,
      }))
      .sort((left, right) =>
        compareCodeUnitStrings(left.destination, right.destination)),
    generatedAt: receipt.generatedAt,
  });
}
