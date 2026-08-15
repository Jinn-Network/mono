// SPDX-License-Identifier: Apache-2.0

import { DerivationError } from "./errors.js";
import { compareCodeUnitStrings } from "./order.js";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

// RFC 8785 delegates string serialization to ECMA-262 JSON.stringify, which is only
// well-defined over Unicode scalar values — a lone surrogate can serialize differently
// across hosts, which would move a digest.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function assertScalarString(value: string, what: string): void {
  if (LONE_SURROGATE.test(value)) {
    throw new DerivationError(
      "invalid-input",
      `Canonical JSON ${what} must not contain unpaired UTF-16 surrogates.`,
    );
  }
}

/**
 * RFC 8785 JCS over the I-JSON subset this package authors: the source-commitment
 * pre-image and the pool's entry manifest. Sealed Task/EvaluationSpec bytes are NOT
 * produced here — their owning packages' sealers produce them (program §5 contract 3).
 */
export function serializeCanonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new DerivationError(
        "invalid-input",
        `Canonical JSON numbers must be exact I-JSON safe integers; got ${value}. `
          + "Encode fractional values as decimal strings.",
      );
    }
    return String(value);
  }
  if (typeof value === "string") {
    assertScalarString(value, "strings");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => serializeCanonicalJson(element)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new DerivationError("invalid-input", "Canonical JSON admits only JSON values.");
  }
  const keys = Object.keys(value).sort(compareCodeUnitStrings);
  return `{${keys
    .map((key) => {
      assertScalarString(key, "keys");
      return `${JSON.stringify(key)}:${serializeCanonicalJson(value[key]!)}`;
    })
    .join(",")}}`;
}

const encoder = new TextEncoder();

export function canonicalJsonBytes(value: CanonicalJsonValue): Uint8Array {
  return encoder.encode(serializeCanonicalJson(value));
}
