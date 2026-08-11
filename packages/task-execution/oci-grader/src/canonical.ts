// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { refuse } from "./errors.js";

/**
 * Canonical JSON: sorted object keys (UTF-16 code-unit order — what JavaScript's `<`/`>` on
 * strings already give, since they compare code units, not code points), no insignificant
 * whitespace, UTF-8 bytes. This is the same spelling the sealed row material uses, so a
 * re-serialization can be compared byte-for-byte against the bytes whose digest the specification
 * committed to.
 *
 * Ported from `@jinn-network/policy-identity`'s canonicalizer
 * (`packages/policy/identity/src/canonical.ts`) to close the same digest-collision holes that
 * canonicalizer refuses:
 *
 * - Non-plain objects (`Date`, `Map`, class instances, ...) have no own enumerable members, so a
 *   walker that reads own keys silently serializes every one of them as `{}` — two different
 *   inputs seal to one digest.
 * - Sparse arrays: `Array.prototype.map` skips holes, so a naive `[1,,3].map(canonicalize)`
 *   produces `[1,,3]` — bytes `JSON.parse` cannot read back.
 * - Symbol-keyed and non-enumerable members are invisible to a key-based walk and visible to a
 *   reader of the object: the same disagreement in a different spelling.
 * - Cycles must fail closed with a typed refusal, not a raw `RangeError`.
 * - Numbers admit only safe, non-negative-zero integers: a fractional value serializes through a
 *   shortest-round-trip algorithm that is language-dependent, and `-0` is a distinct JS value
 *   that serializes as `0` — both are digest collisions reachable from ordinary input.
 * - Strings must be well-formed (no lone surrogate), so the bytes round-trip through a strict
 *   UTF-8 encoder in another language, not just through JavaScript.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value, new Set()));
}

/** Refuses a string that contains an unpaired UTF-16 surrogate (not a Unicode scalar sequence). */
function assertWellFormed(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd8_00 || unit > 0xdf_ff) continue;
    if (unit > 0xdb_ff) refuse("canonical JSON string contains an unpaired surrogate");
    const next = value.charCodeAt(index + 1);
    if (Number.isNaN(next) || next < 0xdc_00 || next > 0xdf_ff) {
      refuse("canonical JSON string contains an unpaired surrogate");
    }
    index += 1; // consume the well-formed pair
  }
}

function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value)) refuse("canonical JSON cannot encode a non-finite number");
  if (!Number.isInteger(value)) refuse("canonical JSON cannot encode a non-integer number");
  if (!Number.isSafeInteger(value)) {
    refuse("canonical JSON cannot encode an integer outside the safe range");
  }
  if (Object.is(value, -0)) refuse("canonical JSON cannot encode negative zero");
  return String(value);
}

function canonicalizeArray(value: readonly unknown[], ancestors: Set<object>): string {
  const elements: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    // A hole is the absence of the index, not `undefined` stored at it — checked with `in` so the
    // two cases (a sparse hole vs. an explicit `undefined` element) get distinct refusals.
    if (!(index in value)) refuse("canonical JSON cannot encode a sparse array hole");
    const element = value[index];
    if (element === undefined) {
      refuse("canonical JSON cannot encode an undefined array element");
    }
    elements.push(canonicalize(element, ancestors));
  }
  return `[${elements.join(",")}]`;
}

function canonicalizeObject(value: object, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    refuse("canonical JSON cannot encode a non-plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    refuse("canonical JSON cannot encode a symbol-keyed member");
  }
  const record = value as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(record);
  if (names.length !== Object.keys(record).length) {
    refuse("canonical JSON cannot encode a non-enumerable member");
  }
  const members: string[] = [];
  for (const key of names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    const member = record[key];
    if (member === undefined) continue; // omitted, exactly as `JSON.stringify` would omit it
    assertWellFormed(key);
    members.push(`${JSON.stringify(key)}:${canonicalize(member, ancestors)}`);
  }
  return `{${members.join(",")}}`;
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalizeNumber(value);
  if (typeof value === "string") {
    assertWellFormed(value);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    refuse(`canonical JSON cannot encode a value of type ${typeof value}`);
  }

  const container = value;
  if (ancestors.has(container)) refuse("canonical JSON cannot encode a cyclic structure");
  ancestors.add(container);
  try {
    return Array.isArray(container)
      ? canonicalizeArray(container, ancestors)
      : canonicalizeObject(container, ancestors);
  } finally {
    ancestors.delete(container);
  }
}

/** Lowercase hex sha256 of exact bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
