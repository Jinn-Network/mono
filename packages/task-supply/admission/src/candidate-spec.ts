// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, compareCodeUnitStrings } from "@jinn-network/trust-core";
import { readInlineProcessBlock, testMaterialDigestsOf } from "./inline-match.js";
import { refuse } from "./refusals.js";

/** What admission proves over, as the candidate declares it (design §7.1, first bullet). */
export interface DeclaredCandidateGrading {
  readonly transitions: {
    readonly failToPass: readonly string[];
    readonly passToPass: readonly string[];
  };
  readonly testMaterialDigests: readonly `sha256:${string}`[];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnitStrings);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => b[index] === value);
}

/**
 * The receipt's EvaluationSpec subject is `recordDigest(evaluationSpecBytes)`, so bytes that are
 * not the document's canonical sealing mint a receipt no consumer can ever match against the
 * sealed spec. Checked before any container run: four runs and a signature on a dead artifact is
 * the expensive failure, and it fails silently until a consumer tries to use the receipt.
 */
export function assertCanonicalSpecBytes(bytes: Uint8Array, parsed: unknown): void {
  let canonical: Uint8Array;
  try {
    canonical = canonicalJsonBytes(parsed);
  } catch (cause) {
    refuse("invalid-candidate", `the candidate EvaluationSpec is not canonicalizable JSON: ${String(cause)}`);
  }
  if (!bytesEqual(bytes, canonical)) {
    refuse(
      "invalid-candidate",
      "the candidate EvaluationSpec bytes are not the document's canonical sealing, so the "
        + "receipt's evaluation-spec subject would name bytes no sealed spec has",
    );
  }
}

/**
 * The candidate declares one grading; its EvaluationSpec grades another only if nobody checks.
 * Design §7.1's first bullet is scoped to *the candidate's* fail-to-pass and pass-to-pass tests,
 * and the receipt records `task.transitions` and `task.testMaterialDigests` as the proven sets —
 * so both must be the sets the sealed spec actually grades against, or the receipt attests over
 * material and assertions the grader will not use.
 */
export function checkCandidateSpecConsistency(
  evaluationSpec: unknown,
  candidate: DeclaredCandidateGrading,
): void {
  const block = readInlineProcessBlock(evaluationSpec);
  if (!sameSet(block.transitions.failToPass, candidate.transitions.failToPass)) {
    refuse(
      "transitions-mismatch",
      `the spec grades fail-to-pass [${sortedUnique(block.transitions.failToPass).join(", ")}], `
        + `not the candidate's declared [${sortedUnique(candidate.transitions.failToPass).join(", ")}]`,
    );
  }
  if (!sameSet(block.transitions.passToPass, candidate.transitions.passToPass)) {
    refuse(
      "transitions-mismatch",
      `the spec grades pass-to-pass [${sortedUnique(block.transitions.passToPass).join(", ")}], `
        + `not the candidate's declared [${sortedUnique(candidate.transitions.passToPass).join(", ")}]`,
    );
  }
  const inlineMaterial = testMaterialDigestsOf(block);
  if (!sameSet(inlineMaterial, candidate.testMaterialDigests)) {
    refuse(
      "invalid-candidate",
      `the spec grades test material [${sortedUnique(inlineMaterial).join(", ")}], `
        + `not the candidate's declared [${sortedUnique(candidate.testMaterialDigests).join(", ")}]`,
    );
  }
}
