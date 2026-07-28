// SPDX-License-Identifier: Apache-2.0

// ---------------------------------------------------------------------------
// Cross-package sealing algorithm-equivalence (design §17; program ruling
// §7.15). This module is deliberately generic over the two "sealing
// algorithm implementations" it compares -- it imports neither
// `@jinn-network/trust-core` nor `@jinn-network/evidence-protocol` directly.
// The caller (this package's own `.test.ts` files -- and, per Task T17, a
// second leg against `@jinn-network/task-execution-protocol`) supplies both
// implementations. This keeps `evidence-protocol` a devDependency-only
// concern: it never needs to be a *production* dependency of this package,
// because no production module here imports it.
// ---------------------------------------------------------------------------

/** The minimal "sealing algorithm" surface every leg compares: DSSE
 * pre-authentication encoding and record-digest computation, both
 * operating on already-serialized bytes (never on unserialized values --
 * canonical-byte equivalence, where assertable at all, is a *separate*
 * concern from algorithm identity; see the module doc above). */
export interface SealingAlgorithmImplementation {
  readonly dssePreAuthEncoding: (payloadType: string, payloadBytes: Uint8Array) => Uint8Array;
  readonly recordDigest: (bytes: Uint8Array) => string;
}

export interface SealingEquivalenceCase {
  readonly name: string;
  readonly payloadType: string;
  readonly payloadBytes: Uint8Array;
}

export type SealingEquivalenceCheck = "dssePreAuthEncoding" | "recordDigest";

export interface SealingEquivalenceMismatch {
  readonly case: string;
  readonly check: SealingEquivalenceCheck;
  readonly leftHex: string;
  readonly rightHex: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Compares two sealing algorithm implementations over the same set of
 * already-serialized payload cases, returning every DSSE-PAE or
 * record-digest mismatch found. An empty result means the implementations
 * agree on every case.
 */
export function findSealingEquivalenceMismatches(
  left: SealingAlgorithmImplementation,
  right: SealingAlgorithmImplementation,
  cases: readonly SealingEquivalenceCase[],
): readonly SealingEquivalenceMismatch[] {
  const mismatches: SealingEquivalenceMismatch[] = [];

  for (const testCase of cases) {
    const leftPae = left.dssePreAuthEncoding(testCase.payloadType, testCase.payloadBytes);
    const rightPae = right.dssePreAuthEncoding(testCase.payloadType, testCase.payloadBytes);
    if (!bytesEqual(leftPae, rightPae)) {
      mismatches.push({
        case: testCase.name,
        check: "dssePreAuthEncoding",
        leftHex: bytesToHex(leftPae),
        rightHex: bytesToHex(rightPae),
      });
    }

    const leftDigest = left.recordDigest(testCase.payloadBytes);
    const rightDigest = right.recordDigest(testCase.payloadBytes);
    if (leftDigest !== rightDigest) {
      mismatches.push({
        case: testCase.name,
        check: "recordDigest",
        leftHex: leftDigest,
        rightHex: rightDigest,
      });
    }
  }

  return mismatches;
}

/**
 * Asserts that two sealing algorithm implementations agree on every case
 * (§16, program ruling §7.15). Throws with every mismatch found, not just
 * the first, so a divergence across multiple cases is fully visible at
 * once.
 */
export function assertSealingEquivalence(
  left: SealingAlgorithmImplementation,
  right: SealingAlgorithmImplementation,
  cases: readonly SealingEquivalenceCase[],
): void {
  const mismatches = findSealingEquivalenceMismatches(left, right, cases);
  if (mismatches.length > 0) {
    throw new Error(`sealing algorithm divergence found:\n${JSON.stringify(mismatches, null, 2)}`);
  }
}
