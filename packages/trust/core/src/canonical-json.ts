// SPDX-License-Identifier: Apache-2.0

import { TrustCoreError, invalidInput } from "./errors.js";
import { compareCodeUnitStrings } from "./order.js";
import type { JsonValue } from "./types.js";

// Prototype-safety pass, ported from
// packages/evidence/attestation-issuer/src/deterministic-json.ts's
// `cloneJsonValue` (verbatim structure; adapted to trust-core's own error
// type). Rejects prototype pollution, sparse arrays, non-finite numbers,
// symbol keys, and non-enumerable/accessor properties before anything
// reaches canonical bytes.
function cloneJsonValue(value: unknown): JsonValue {
  const active = new WeakSet<object>();

  const visit = (candidate: unknown): JsonValue => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) invalidInput("JSON numbers must be finite.");
      // Program ruling §7.14: every sealer rejects numbers that are not
      // exactly representable I-JSON integers -- fractional quantities must
      // be encoded as strings by the caller instead. This closes a
      // cross-language non-determinism gap in the generic seal path (typed
      // record schemas already constrain their numeric fields to
      // `z.number().int()`, so this is a latent-surface fix, not a change
      // to any current record shape).
      if (!Number.isSafeInteger(candidate)) {
        invalidInput(
          "JSON numbers must be exact I-JSON safe integers -- fractional or non-safe-integer "
            + "quantities must be encoded as strings (§7.14).",
        );
      }
      return candidate;
    }
    if (typeof candidate !== "object") {
      invalidInput("Expected a JSON value.");
    }
    const container = candidate as object;
    if (active.has(container)) invalidInput("JSON values must not contain cycles.");
    active.add(container);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          invalidInput("JSON arrays must have the standard Array prototype.");
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const lengthDescriptor = descriptors["length"] as
          | PropertyDescriptor
          | undefined;
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          lengthDescriptor.value > 0xffff_ffff
        ) {
          invalidInput("JSON arrays must have a valid data-property length.");
        }
        const length = lengthDescriptor.value as number;
        const keys = Reflect.ownKeys(descriptors);
        if (
          keys.some((key) =>
            typeof key !== "string" ||
            (
              key !== "length" &&
              (
                !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
                Number(key) >= length ||
                Number(key) > 0xffff_fffe
              )
            ))
        ) {
          invalidInput("JSON arrays must not contain non-index properties.");
        }
        const output: JsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true
          ) {
            invalidInput("JSON arrays must be dense data-property arrays.");
          }
          output.push(visit(descriptor.value));
        }
        return output;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        invalidInput("JSON objects must have a safe plain-object prototype.");
      }
      const output = Object.create(null) as Record<string, JsonValue>;
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") {
          invalidInput("JSON objects must not contain symbol properties.");
        }
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          invalidInput("JSON objects must contain only enumerable data properties.");
        }
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: visit(descriptor.value),
          writable: true,
        });
      }
      return output;
    } finally {
      active.delete(container);
    }
  };

  try {
    return visit(value);
  } catch (cause) {
    if (cause instanceof TrustCoreError && cause.code === "INVALID_INPUT") {
      throw cause;
    }
    invalidInput("Expected a readable JSON value.", cause);
  }
}

/**
 * Raw RFC 8785 JCS serialization under I-JSON, per program ruling §7.1 (the
 * stack-wide sealed-bytes rule): compact separators (no space after `,` or
 * `:`), no indentation, no trailing newline, ES Number-to-string formatting.
 *
 * Object keys are sorted via `compareCodeUnitStrings` (UTF-16 code-unit
 * order, never `localeCompare`) and the `{...}` string is built by explicit
 * iteration over that sorted key array -- never by relying on `JSON.stringify`
 * or native object insertion order, since integer-like string keys (`"10"`,
 * `"2"`) iterate numerically under JS object semantics and would diverge
 * from JCS's code-unit order (program ruling §7.14).
 */
function stringifyCanonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCanonical(item)).join(",")}]`;
  }
  const object = value as { readonly [key: string]: JsonValue };
  const sortedKeys = Object.keys(object).sort(compareCodeUnitStrings);
  let body = "";
  for (let index = 0; index < sortedKeys.length; index += 1) {
    const key = sortedKeys[index]!;
    if (index > 0) body += ",";
    body += `${JSON.stringify(key)}:${stringifyCanonical(object[key]!)}`;
  }
  return `{${body}}`;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(stringifyCanonical(cloneJsonValue(value)));
}
