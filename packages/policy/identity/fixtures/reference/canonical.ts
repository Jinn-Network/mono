// SPDX-License-Identifier: MIT

/**
 * NAIVE REFERENCE — RFC 8785 JCS over the I-JSON subset (substrate §4.1 step 5).
 *
 * Deliberately simple: correctness over elegance, one rule per branch, no shared machinery with
 * whatever the real implementation does. It exists so the package's canonicalizer has something
 * structurally different to byte-match against.
 *
 * The rules, each traceable to a line of the stack's sealing discipline:
 *
 * 1. Object member names are emitted in **UTF-16 code-unit order**. JavaScript's `<`/`>` on
 *    strings *is* code-unit order, so the comparison is written out longhand rather than
 *    delegated to `localeCompare` (locale- and ICU-dependent, and therefore banned anywhere near
 *    canonical bytes). Insertion order is never trusted.
 * 2. Numbers must be exact I-JSON integers. Fractional quantities are strings in this stack;
 *    `-0`, `NaN`, `Infinity`, and any non-safe integer are rejected.
 * 3. Strings must be I-JSON: Unicode scalar sequences, never isolated UTF-16 surrogates.
 * 4. An object member whose value is `undefined` is **omitted**, mirroring `JSON.stringify` — so
 *    an omitted optional field and an explicit-`undefined` one seal to identical bytes. An
 *    *array element* that is `undefined` has no key to omit by and is **rejected**: JCS has no
 *    undefined token, and emitting `null` there would silently corrupt the bytes.
 * 5. Escaping is `JSON.stringify`'s, which is JCS's minimal escaping for well-formed strings.
 */

import { fail } from "./errors.js";

const encoder = new TextEncoder();

/** UTF-16 code-unit ordering, written out so no locale-sensitive comparator can creep in. */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** I-JSON strings contain Unicode scalar values, never isolated UTF-16 surrogate code units. */
export function assertIJsonString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail("invalid-document", path, "string contains an unpaired high surrogate (not I-JSON)");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("invalid-document", path, "string contains an unpaired low surrogate (not I-JSON)");
    }
  }
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";

  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("invalid-document", path, `number is not an exact I-JSON integer: ${String(value)}`);
    }
    // `Object.is(-0, 0)` is false: negative zero is a distinct value that serializes as "0",
    // which would make two distinct inputs seal to identical bytes. Reject it outright.
    if (Object.is(value, -0)) {
      fail("invalid-document", path, "negative zero is not a distinct I-JSON integer");
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
        fail("invalid-document", elementPath, "sparse arrays are not representable as JSON");
      }
      if (value[index] === undefined) {
        fail("invalid-document", elementPath, "array elements must not be undefined; JCS has no undefined token");
      }
      parts.push(serialize(value[index], elementPath));
    }
    return `[${parts.join(",")}]`;
  }

  if (typeof value !== "object") {
    fail("invalid-document", path, `value of type ${typeof value} is not representable as JSON`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid-document", path, "non-plain objects are not representable as JSON");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("invalid-document", path, "symbol-keyed values are not representable as JSON");
  }

  const record = value as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(record);
  if (names.length !== Object.keys(record).length) {
    fail("invalid-document", path, "non-enumerable members are not representable as JSON");
  }

  // Emit from an explicitly sorted array. Never iterate the object and hope.
  const keys = names.filter((key) => record[key] !== undefined).sort(compareCodeUnitStrings);
  const members: string[] = [];
  for (const key of keys) {
    assertIJsonString(key, path === "" ? key : `${path}.${key}`);
    members.push(`${JSON.stringify(key)}:${serialize(record[key], path === "" ? key : `${path}.${key}`)}`);
  }
  return `{${members.join(",")}}`;
}

/** The canonical JSON *text*. The bytes are its UTF-8 encoding. */
export function canonicalJsonText(value: unknown): string {
  assertAcyclic(value, new Set(), "");
  return serialize(value, "");
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJsonText(value));
}

function assertAcyclic(value: unknown, ancestors: ReadonlySet<object>, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) {
    fail("invalid-document", path, "cyclic values are not representable as JSON");
  }
  const next = new Set(ancestors);
  next.add(value);
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    assertAcyclic(member, next, path === "" ? key : `${path}.${key}`);
  }
}

/** Structural equality by canonical bytes — the only equality this package recognizes. */
export function canonicallyEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}
