import {
  assertValidTuple,
  compareCodeUnitStrings,
  type ExecutionPolicyTuple,
  type JsonValue,
} from "@jinn-network/policy-identity";

/**
 * The tuple's axis values, denormalized onto the row for filtering (substrate §6.1). `formatToken`
 * is document metadata, not an axis (design finding F4), and is excluded.
 *
 * F-C2-1 closure: this is the one piece of `tuple-support.ts` that survives. Canonicalization and
 * digesting are now imported straight through from `@jinn-network/policy-identity`
 * (`canonicalTupleBytes`/`canonicalTupleText`/`tupleDigest`, re-exported from `./index.js`) now
 * that C1 ships them; `denormalizeAxes` has no counterpart there -- it is outcomes-specific
 * row-shaping, not identity's concern.
 */
export function denormalizeAxes(tuple: ExecutionPolicyTuple): Readonly<Record<string, JsonValue>> {
  assertValidTuple(tuple);
  const axes: Record<string, JsonValue> = {};
  for (const key of Object.keys(tuple).sort(compareCodeUnitStrings)) {
    if (key === "formatToken") continue;
    axes[key] = (tuple as Record<string, JsonValue>)[key];
  }
  return axes;
}
