// SPDX-License-Identifier: MIT

/**
 * The execution-policy tuple: validation, canonical bytes, digest, and the expression rule
 * (substrate §4.1).
 *
 * A tuple is **derived, never authored** (`derive.ts` is the only sanctioned producer), but the
 * validator here is what every consumer of a tuple-shaped document runs — including
 * `validateCandidateManifest`, so a manifest cannot launder a malformed policy.
 */

import { canonicalJsonBytes, canonicalJsonText } from "./canonical.js";
import { prefixedDigest } from "./digest.js";
import { refuse } from "./errors.js";
import { CORE_AXES, EXECUTION_TUPLE_FORMAT_TOKEN } from "./tokens.js";
import type { ExecutionPolicyTuple, JsonValue, RequirementEntries } from "./types.js";

/**
 * Substrate §4.1 step 5 — fail-closed validation.
 *
 * The core-axis rule is the load-bearing one: **omission is invalid input, not a different
 * identity.** Without it a producer mints a second, cheaper identity for the same treatment by
 * leaving an axis out, and every consumer keying on `tupleDigest` silently splits its population.
 * `null` and absent are genuinely different byte sequences (see
 * `tuple/demonstrations/null-vs-absent-non-collision.json`), which is what makes refusing absence
 * principled rather than an arbitrary preference between two spellings.
 *
 * An explicitly-`undefined` axis is refused here rather than in the canonicalizer, because
 * canonicalization *omits* undefined members (F10): a presence check alone would pass such a
 * tuple and then seal it with no axis member at all.
 */
export function assertValidTuple(value: unknown): asserts value is ExecutionPolicyTuple {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse("invalid-document", "", "an execution-policy tuple must be a JSON object");
  }

  const tuple = value as Record<string, unknown>;

  if (tuple["formatToken"] !== EXECUTION_TUPLE_FORMAT_TOKEN) {
    refuse(
      "invalid-document",
      "formatToken",
      `formatToken must be ${EXECUTION_TUPLE_FORMAT_TOKEN}`,
    );
  }

  for (const axis of CORE_AXES) {
    if (!Object.hasOwn(tuple, axis) || tuple[axis] === undefined) {
      refuse(
        "omitted-core-axis",
        axis,
        "core axes are always present and are null when unconstrained; omission is invalid input",
      );
    }
  }
}

/** Canonical bytes of a validated tuple — the bytes `tupleDigest` names. */
export function canonicalTupleBytes(tuple: ExecutionPolicyTuple): Uint8Array {
  assertValidTuple(tuple);
  return canonicalJsonBytes(tuple);
}

/** The same bytes as text, for fixtures and for humans reading a diff. */
export function canonicalTupleText(tuple: ExecutionPolicyTuple): string {
  assertValidTuple(tuple);
  return canonicalJsonText(tuple);
}

/** `sha256:<hex>` over the canonical bytes. */
export function tupleDigest(tuple: ExecutionPolicyTuple): string {
  return prefixedDigest(canonicalTupleBytes(tuple));
}

/**
 * The inverse of the derivation (substrate §4.1's expression rule, as amended by FINDING F4):
 * one requirement entry per non-null **axis**, byte-exact.
 *
 * `formatToken` is a document member, never a requirement entry — read literally as "per non-null
 * key" the rule would emit it, and no backend declares `formatToken` in a `runPinning` inventory,
 * so the Submission would be rejected as carrying an unsupported requirement. A `null` core axis
 * emits nothing: the tuple says "unconstrained", and a pinning entry would say the opposite.
 */
export function expressAsRunPinning(tuple: ExecutionPolicyTuple): RequirementEntries {
  assertValidTuple(tuple);
  const entries: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(tuple)) {
    if (key === "formatToken") continue;
    if (value === null || value === undefined) continue;
    entries[key] = value;
  }
  return entries;
}
