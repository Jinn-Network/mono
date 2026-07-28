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

// ---------------------------------------------------------------------------
// Genuine cross-impl canonical-byte equivalence (Task T17; program ruling
// §7.1/§7.15). Unlike the algorithm-identity leg above -- which compares two
// implementations' PAE/digest primitives over bytes ALREADY serialized by
// the caller -- this leg feeds the *same unserialized JSON value* to two
// independent canonical-JSON serializers and asserts the emitted bytes are
// identical. This is only assertable between trees that share the raw RFC
// 8785 JCS rule (program §7.1): trust-core and task-execution-protocol both
// do; evidence-protocol exports no canonical serializer at all (§7.15), so
// no leg of this shape exists against it.
// ---------------------------------------------------------------------------

/** The minimal "canonical serializer" surface a canonical-byte equivalence
 * leg compares: a pure function from an arbitrary JSON-compatible value to
 * its canonical serialized bytes. */
export interface CanonicalSerializerImplementation {
  readonly canonicalJsonBytes: (value: unknown) => Uint8Array;
}

export interface CanonicalByteEquivalenceCase {
  readonly name: string;
  readonly value: unknown;
}

export interface CanonicalByteMismatch {
  readonly case: string;
  readonly leftHex: string;
  readonly rightHex: string;
}

/**
 * Compares two canonical-JSON serializers over the same set of unserialized
 * values, returning every byte mismatch found. An empty result means the
 * serializers agree on every case.
 */
export function findCanonicalByteMismatches(
  left: CanonicalSerializerImplementation,
  right: CanonicalSerializerImplementation,
  cases: readonly CanonicalByteEquivalenceCase[],
): readonly CanonicalByteMismatch[] {
  const mismatches: CanonicalByteMismatch[] = [];

  for (const testCase of cases) {
    const leftBytes = left.canonicalJsonBytes(testCase.value);
    const rightBytes = right.canonicalJsonBytes(testCase.value);
    if (!bytesEqual(leftBytes, rightBytes)) {
      mismatches.push({
        case: testCase.name,
        leftHex: bytesToHex(leftBytes),
        rightHex: bytesToHex(rightBytes),
      });
    }
  }

  return mismatches;
}

/**
 * Asserts that two canonical-JSON serializers agree on every case (Task
 * T17; program ruling §7.1). The convention (raw JCS, no indent, no
 * trailing newline) is already fixed by the coordinator ruling -- this
 * function VERIFIES byte-identity, it does not negotiate one. A mismatch is
 * a bug against §7.1 in one of the two implementations; the caller must
 * surface it rather than retuning either serializer to make the assertion
 * pass.
 */
export function assertCanonicalByteEquivalence(
  left: CanonicalSerializerImplementation,
  right: CanonicalSerializerImplementation,
  cases: readonly CanonicalByteEquivalenceCase[],
): void {
  const mismatches = findCanonicalByteMismatches(left, right, cases);
  if (mismatches.length > 0) {
    throw new Error(
      `canonical-byte divergence found against the fixed §7.1 convention -- this is a bug in one implementation, not a convention to retune:\n${JSON.stringify(mismatches, null, 2)}`,
    );
  }
}
