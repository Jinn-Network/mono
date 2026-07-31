// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "./order.js";
import { isNamespacedExtensionKey } from "./extensions.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export class NonIJsonNumberError extends Error {
  readonly category = "non-ijson-number" as const;
  constructor(readonly value: number) {
    super(`number ${String(value)} is not an I-JSON safe integer`);
    this.name = "NonIJsonNumberError";
  }
}

export class NonIJsonStringError extends Error {
  readonly category = "non-ijson-string" as const;
  constructor(readonly value: string) {
    super("string contains an unpaired surrogate");
    this.name = "NonIJsonStringError";
  }
}

export class UndefinedArrayElementError extends Error {
  readonly category = "undefined-array-element" as const;
  constructor() {
    super("array elements must not be undefined");
    this.name = "UndefinedArrayElementError";
  }
}

export class UnsupportedCanonicalValueError extends Error {
  readonly category = "unsupported-canonical-value" as const;
  constructor(
    readonly valueType: string,
    readonly path: string,
  ) {
    super(`unsupported canonical value at ${path || "<root>"}: ${valueType}`);
    this.name = "UnsupportedCanonicalValueError";
  }
}

function assertPlainObject(value: object, path: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UnsupportedCanonicalValueError("non-plain object", path);
  }
}

function assertCanonicalizable(value: unknown, path: string): void {
  if (value === undefined) {
    if (path === "") {
      throw new UnsupportedCanonicalValueError("undefined", path);
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string" || typeof value === "number") return;
  if (typeof value === "bigint") {
    throw new UnsupportedCanonicalValueError("bigint", path);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new UnsupportedCanonicalValueError(typeof value, path);
  }
  if (value instanceof Date) {
    throw new UnsupportedCanonicalValueError("Date", path);
  }
  if (value instanceof Map || value instanceof Set) {
    throw new UnsupportedCanonicalValueError(value.constructor.name, path);
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      if (element === undefined) throw new UndefinedArrayElementError();
      assertCanonicalizable(element, `${path}[${String(index)}]`);
    });
    return;
  }
  if (typeof value === "object") {
    assertPlainObject(value, path);
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) continue;
      assertCanonicalizable(nested, path ? `${path}.${key}` : key);
      if (
        isNamespacedExtensionKey(key) &&
        nested !== null &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        assertPlainObject(nested, path ? `${path}.${key}` : key);
        for (const nestedKey of Object.keys(nested)) {
          if (!isNamespacedExtensionKey(nestedKey)) {
            throw new UnsupportedCanonicalValueError(
              `non-namespaced extension key "${nestedKey}"`,
              path ? `${path}.${key}.${nestedKey}` : `${key}.${nestedKey}`,
            );
          }
        }
      }
    }
  }
}

function assertIJsonNumber(value: number): void {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new NonIJsonNumberError(value);
  }
}

function assertIJsonString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new NonIJsonStringError(value);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new NonIJsonStringError(value);
    }
  }
}

function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    assertIJsonNumber(value);
    return String(value);
  }
  if (typeof value === "string") {
    assertIJsonString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((element) => {
      if (element === undefined) throw new UndefinedArrayElementError();
      return serialize(element as JsonValue);
    });
    return `[${parts.join(",")}]`;
  }
  const source = value as { readonly [key: string]: JsonValue | undefined };
  const keys = Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort(compareCodeUnitStrings);
  const members = keys.map((key) => {
    assertIJsonString(key);
    return `${JSON.stringify(key)}:${serialize(source[key] as JsonValue)}`;
  });
  return `{${members.join(",")}}`;
}

const encoder = new TextEncoder();

/** RFC 8785 JCS over the I-JSON-integer subset; those bytes are the document forever. */
export function serializeCanonicalJson(value: JsonValue): Uint8Array {
  assertCanonicalizable(value, "");
  return encoder.encode(serialize(value));
}
