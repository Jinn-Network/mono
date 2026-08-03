// SPDX-License-Identifier: MIT

/**
 * NAIVE REFERENCE — tuple canonicalization, digest, validation, and the expression rule
 * (substrate §4.1).
 */

import { CORE_AXES, EXECUTION_TUPLE_FORMAT_TOKEN } from "../../src/tokens.js";
import type { ExecutionPolicyTuple, JsonValue, RequirementEntries } from "../../src/types.js";
import { canonicalJsonBytes, canonicalJsonText } from "./canonical.js";
import { fail } from "./errors.js";
import { prefixedDigest } from "./hashing.js";

/**
 * Substrate §4.1 step 5 — validation **fails closed on an omitted core axis key**: omission is
 * invalid input, not a different identity. A core axis that is present and `null` is valid and
 * canonicalizes to a byte sequence distinct from the omitted form; that non-collision is what
 * the `null-vs-absent` fixture pair demonstrates.
 */
export function assertValidTuple(value: unknown): asserts value is ExecutionPolicyTuple {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid-document", "", "execution-policy tuple must be a JSON object");
  }
  const tuple = value as Record<string, unknown>;

  if (tuple["formatToken"] !== EXECUTION_TUPLE_FORMAT_TOKEN) {
    fail(
      "invalid-document",
      "formatToken",
      `expected ${EXECUTION_TUPLE_FORMAT_TOKEN}, got ${JSON.stringify(tuple["formatToken"])}`,
    );
  }

  for (const axis of CORE_AXES) {
    if (!Object.hasOwn(tuple, axis)) {
      fail("omitted-core-axis", axis, "core axis key is absent; it must be present, `null` when unconstrained");
    }
    if (tuple[axis] === undefined) {
      // An explicit `undefined` would be *omitted* by canonicalization, i.e. the same defect
      // through a different door. Catch it here rather than let it seal.
      fail("omitted-core-axis", axis, "core axis key is `undefined`; it must be present, `null` when unconstrained");
    }
  }
}

/** Substrate §4.1 step 5 — I-JSON, JCS, UTF-16 string ordering. Those bytes are the identity. */
export function canonicalTupleBytes(tuple: ExecutionPolicyTuple): Uint8Array {
  assertValidTuple(tuple);
  return canonicalJsonBytes(tuple);
}

export function canonicalTupleText(tuple: ExecutionPolicyTuple): string {
  assertValidTuple(tuple);
  return canonicalJsonText(tuple);
}

/** `sha256:<64 lowercase hex>` over the canonical bytes. */
export function tupleDigest(tuple: ExecutionPolicyTuple): string {
  return prefixedDigest(canonicalTupleBytes(tuple));
}

/**
 * Substrate §4.1, the expression rule (the inverse): emit one requirement entry per non-null
 * axis, byte-exact; `null` core axes emit no entry.
 *
 * FINDING F4 (see README): the design says "one requirement entry per non-null **key**", which
 * read literally would emit `formatToken` as a run-pinning requirement. `formatToken` is
 * document metadata, not an axis, and no backend declares it in a `runPinning` inventory — so it
 * is excluded here. Proposed disposition: amend §4.1 to read "per non-null axis".
 */
export function expressAsRunPinning(tuple: ExecutionPolicyTuple): RequirementEntries {
  assertValidTuple(tuple);
  const entries: Record<string, JsonValue> = {};
  for (const key of Object.keys(tuple)) {
    if (key === "formatToken") continue;
    const value = tuple[key];
    if (value === null) continue;
    entries[key] = value;
  }
  return entries;
}
