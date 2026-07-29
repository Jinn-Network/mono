// SPDX-License-Identifier: MIT

import { compareCodeUnitStrings } from "./order.js";

/**
 * The binding's own JSON-value domain for backend-internal canonical bytes only (program
 * §7.1/§7.14/§7.15): the broadcast-intent WAL record and the correspondence-assertion payload.
 * This is never a re-seal of a TEP or discovery document family -- those come from
 * `@jinn-network/task-execution-protocol` and `@jinn-network/record-discovery-serve` respectively
 * (see `canonical-equivalence.test.ts` for the documented "no new sealed family" assertion).
 */
export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

/** Thrown when a number is not an exact I-JSON integer (program §7.14: fractional quantities are strings). */
export class IJsonNumberError extends Error {
  constructor(readonly value: number) {
    super(`number is not an exact I-JSON integer: ${value}`);
    this.name = "IJsonNumberError";
  }
}

/** Thrown when a string is not an I-JSON Unicode scalar sequence (program §7.24). */
export class IJsonUnicodeError extends Error {
  constructor(
    readonly location: string,
    readonly codeUnitIndex: number,
  ) {
    super(`unpaired UTF-16 surrogate at ${location}, code-unit index ${codeUnitIndex}`);
    this.name = "IJsonUnicodeError";
  }
}

function assertIJsonInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new IJsonNumberError(value);
}

function assertUnicodeScalarString(value: string, location: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length
        || nextCodeUnit < 0xdc00
        || nextCodeUnit > 0xdfff
      ) {
        throw new IJsonUnicodeError(location, index);
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new IJsonUnicodeError(location, index);
    }
  }
}

/**
 * Recursively enforces I-JSON's Unicode-scalar requirement in both member names and values.
 * Exported for exact Delivery admission; it does not serialize or normalize its input.
 */
export function assertIJsonUnicode(value: unknown, location = "<root>"): void {
  if (typeof value === "string") {
    assertUnicodeScalarString(value, location);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      assertIJsonUnicode(element, `${location}[${index}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, member] of Object.entries(value)) {
      assertUnicodeScalarString(key, `object key at ${location}`);
      assertIJsonUnicode(member, `${location}.${key}`);
    }
  }
}

/**
 * RFC 8785 JCS-style deterministic JSON, built via explicit sorted-key iteration -- JS object
 * insertion order is never trusted, and integer-like string keys ("10", "2") sort by UTF-16 code
 * unit, not numeric value (program §7.14). Numbers must be exact I-JSON integers.
 */
function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    assertIJsonInteger(value);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((element) => serialize(element)).join(",")}]`;
  }
  const keys = Object.keys(value).sort(compareCodeUnitStrings);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`).join(",")}}`;
}

/** Serializes a `JsonValue` to its canonical (JCS-style, sorted-key) string form. */
export function serializeCanonical(value: JsonValue): string {
  assertIJsonUnicode(value);
  return serialize(value);
}
