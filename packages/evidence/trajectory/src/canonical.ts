// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "./order.js";
import { preflightCanonicalInput } from "./preflight.js";

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

function assertCanonicalizable(value: unknown, path: string): void {
  try {
    preflightCanonicalInput(value);
  } catch (error) {
    if (error instanceof UndefinedArrayElementError) throw error;
    if (error instanceof NonIJsonNumberError) throw error;
    if (error instanceof UnsupportedCanonicalValueError) throw error;
    throw new UnsupportedCanonicalValueError(
      error instanceof Error ? error.message : "preflight failed",
      path,
    );
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
