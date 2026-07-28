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

function assertIJsonInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new IJsonNumberError(value);
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
  return serialize(value);
}
