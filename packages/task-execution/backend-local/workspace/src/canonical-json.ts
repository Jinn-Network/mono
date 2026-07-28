// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "./order.js";

/**
 * Deterministic canonical-JSON serialization for this package's OWN backend-internal bytes
 * (sorted output manifests — never TEP-sealed documents, which the protocol package's exported
 * sealer owns exclusively; program §7.4/plan Finding (b)).
 *
 * Re-implemented per package (Global Constraints — never a shared runtime dep): object keys are
 * emitted via explicit sorted-key iteration using `compareCodeUnitStrings` (program §7.14 —
 * insertion order, including numeric-string-key iteration order, is never trusted), and every
 * number must be an exactly representable I-JSON integer (program §7.14) — fractional
 * quantities are strings, matching the TEP sealing rule this backend-internal serializer mirrors
 * for consistency, never for TEP document production.
 */

export class NonIntegerNumberError extends Error {
  constructor(value: number) {
    super(`serializeCanonical: ${value} is not an exactly representable I-JSON integer`);
    this.name = "NonIntegerNumberError";
  }
}

export class UndefinedArrayElementError extends Error {
  constructor() {
    super("serializeCanonical: array elements must not be undefined");
    this.name = "UndefinedArrayElementError";
  }
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) throw new NonIntegerNumberError(value);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value
      .map((element) => {
        if (element === undefined) throw new UndefinedArrayElementError();
        return serialize(element);
      })
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareCodeUnitStrings);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`serializeCanonical: unsupported value type "${typeof value}"`);
}

/** Deterministic canonical-JSON string for this package's backend-internal bytes. */
export function serializeCanonical(value: unknown): string {
  return serialize(value);
}
