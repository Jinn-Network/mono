// SPDX-License-Identifier: Apache-2.0

import { ScenarioError } from "./errors.js";
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
    throw new ScenarioError(
      "invalid-input",
      `Canonical JSON ${what} must not contain unpaired UTF-16 surrogates.`,
    );
  }
}

/**
 * RFC 8785 JCS over the I-JSON subset this package authors: state-artifact and
 * coverage-manifest bytes. Record sealing is owned by CE1 (program §5 contract 3).
 */
export function serializeCanonicalJson(value: CanonicalJsonValue): string {
  if (value === undefined) {
    throw new ScenarioError("invalid-input", "Canonical JSON does not admit undefined.");
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ScenarioError(
        "invalid-input",
        `Canonical JSON numbers must be finite; got ${value}.`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new ScenarioError(
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
  if (typeof value === "bigint") {
    throw new ScenarioError("invalid-input", "Canonical JSON does not admit bigint.");
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => serializeCanonicalJson(element)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new ScenarioError("invalid-input", "Canonical JSON admits only JSON values.");
  }
  const keys = Object.keys(value).sort(compareCodeUnitStrings);
  return `{${keys
    .map((key) => {
      assertScalarString(key, "keys");
      const member = value[key];
      if (member === undefined) {
        throw new ScenarioError(
          "invalid-input",
          `Canonical JSON object members must not be undefined; key ${JSON.stringify(key)}.`,
        );
      }
      return `${JSON.stringify(key)}:${serializeCanonicalJson(member)}`;
    })
    .join(",")}}`;
}

const encoder = new TextEncoder();

export function canonicalJsonBytes(value: CanonicalJsonValue): Uint8Array {
  return encoder.encode(serializeCanonicalJson(value));
}
