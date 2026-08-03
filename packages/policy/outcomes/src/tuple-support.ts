import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  CORE_AXES,
  EXECUTION_TUPLE_FORMAT_TOKEN,
  type ExecutionPolicyTuple,
  type JsonValue,
} from "@jinn-network/policy-identity";
import { PolicyOutcomesInputError } from "./schema.js";

/**
 * Canonical-bytes and digest support for `ExecutionPolicyTuple` (substrate §4.1 step 5: I-JSON,
 * JCS, UTF-16 code-unit member ordering, sha256 -> `sha256:<hex>`), plus the row's `axes`
 * denormalization (substrate §6.1).
 *
 * FINDING (interface-availability, not a design disagreement -- see README "Findings" F-C2-1):
 * substrate §2 declares the dependency direction "outcomes imports identity for the tuple type
 * and digest -- one direction, declared", so this package is meant to import a digest FUNCTION
 * from `@jinn-network/policy-identity`, not merely its types. At the time this package was
 * written, `@jinn-network/policy-identity` ships only C1's conformance KIT (program §1 C1
 * "Produces"; see `packages/policy/identity/README.md` "Handover") -- its public surface exports
 * the frozen type and token vocabulary only (`ExecutionPolicyTuple`, `CORE_AXES`,
 * `EXECUTION_TUPLE_FORMAT_TOKEN`, all consumed below), not yet `canonicalTupleBytes`/
 * `tupleDigest`. Per program rule R1, C2 builds against C1's kit, not its implementation, so
 * this package cannot depend on functions the kit does not yet export.
 *
 * Disposition: this file implements the SAME normative procedure locally rather than importing a
 * function that does not exist yet. Unlike `deriveExecutionTuple` (C1's actual hard problem --
 * merging Task and Submission requirements under profile-declared comparison classes),
 * canonicalizing an ALREADY-CONSTRUCTED tuple has no implementation-defined behavior: RFC 8785
 * JCS and sha256 are both fully specified. This file's output is pinned for byte-parity against
 * C1's own committed golden fixtures (`packages/policy/identity/fixtures/tuple/golden/*.json`) in
 * `tuple-support.test.ts`, so drift would be caught immediately. This precedent (every
 * sealing/canonicalizing package in the stack owns its own canonicalizer rather than importing a
 * shared one -- `packages/environments/record/src/canonical.ts`,
 * `packages/benchmarking/records/src/canonical.ts`, and C1's own
 * `fixtures/reference/canonical.ts` all independently implement the identical rule) means this is
 * not a novel duplication of business logic; it is the stack's established sealing discipline.
 * Follow-up: once C1 ships `canonicalTupleBytes`/`tupleDigest`, delete this file and import them
 * directly.
 */

const encoder = new TextEncoder();

function compareCodeUnitStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertIJsonString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new PolicyOutcomesInputError(`${path}: string contains an unpaired high surrogate (not I-JSON)`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new PolicyOutcomesInputError(`${path}: string contains an unpaired low surrogate (not I-JSON)`);
    }
  }
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new PolicyOutcomesInputError(`${path}: number is not an exact I-JSON integer: ${String(value)}`);
    }
    if (Object.is(value, -0)) {
      throw new PolicyOutcomesInputError(`${path}: negative zero is not a distinct I-JSON integer`);
    }
    return String(value);
  }

  if (typeof value === "string") {
    assertIJsonString(value, path);
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const elementPath = path === "" ? String(index) : `${path}.${index}`;
      if (!(index in value)) {
        throw new PolicyOutcomesInputError(`${elementPath}: sparse arrays are not representable as JSON`);
      }
      if (value[index] === undefined) {
        throw new PolicyOutcomesInputError(`${elementPath}: array elements must not be undefined; JCS has no undefined token`);
      }
      parts.push(serialize(value[index], elementPath));
    }
    return `[${parts.join(",")}]`;
  }

  if (typeof value !== "object") {
    throw new PolicyOutcomesInputError(`${path}: value of type ${typeof value} is not representable as JSON`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PolicyOutcomesInputError(`${path}: non-plain objects are not representable as JSON`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new PolicyOutcomesInputError(`${path}: symbol-keyed values are not representable as JSON`);
  }

  const record = value as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(record);
  if (names.length !== Object.keys(record).length) {
    throw new PolicyOutcomesInputError(`${path}: non-enumerable members are not representable as JSON`);
  }

  const keys = names.filter((key) => record[key] !== undefined).sort(compareCodeUnitStrings);
  const members: string[] = [];
  for (const key of keys) {
    const memberPath = path === "" ? key : `${path}.${key}`;
    assertIJsonString(key, memberPath);
    members.push(`${JSON.stringify(key)}:${serialize(record[key], memberPath)}`);
  }
  return `{${members.join(",")}}`;
}

function assertAcyclic(value: unknown, ancestors: ReadonlySet<object>, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) {
    throw new PolicyOutcomesInputError(`${path}: cyclic values are not representable as JSON`);
  }
  const next = new Set(ancestors);
  next.add(value);
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    assertAcyclic(member, next, path === "" ? key : `${path}.${key}`);
  }
}

/** Substrate §4.1 step 5 -- validation fails closed on an omitted core axis key: omission is
 * invalid input, not a different identity. */
export function assertValidTuple(value: unknown): asserts value is ExecutionPolicyTuple {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolicyOutcomesInputError("execution-policy tuple must be a JSON object");
  }
  const tuple = value as Record<string, unknown>;
  if (tuple.formatToken !== EXECUTION_TUPLE_FORMAT_TOKEN) {
    throw new PolicyOutcomesInputError(
      `tuple.formatToken: expected ${EXECUTION_TUPLE_FORMAT_TOKEN}, got ${JSON.stringify(tuple.formatToken)}`,
    );
  }
  for (const axis of CORE_AXES) {
    if (!Object.hasOwn(tuple, axis)) {
      throw new PolicyOutcomesInputError(
        `tuple.${axis}: core axis key is absent; it must be present, null when unconstrained`,
      );
    }
    if (tuple[axis] === undefined) {
      throw new PolicyOutcomesInputError(
        `tuple.${axis}: core axis key is undefined; it must be present, null when unconstrained`,
      );
    }
  }
}

/** I-JSON, JCS, UTF-16 code-unit ordering -- those bytes are the identity (substrate §4.1 step 5). */
export function canonicalTupleText(tuple: ExecutionPolicyTuple): string {
  assertValidTuple(tuple);
  assertAcyclic(tuple, new Set(), "");
  return serialize(tuple, "");
}

export function canonicalTupleBytes(tuple: ExecutionPolicyTuple): Uint8Array {
  return encoder.encode(canonicalTupleText(tuple));
}

/** `sha256:<64 lowercase hex>` over the canonical bytes. */
export function tupleDigest(tuple: ExecutionPolicyTuple): string {
  return `sha256:${bytesToHex(sha256(canonicalTupleBytes(tuple)))}`;
}

/**
 * The tuple's axis values, denormalized onto the row for filtering (substrate §6.1). `formatToken`
 * is document metadata, not an axis (design finding F4), and is excluded.
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
