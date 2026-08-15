// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { AttestationIssuerError, invalidInput } from "./errors.js";
import type { JsonValue } from "./types.js";

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  const copy: number[] = [];
  for (const byte of Uint8Array.prototype.values.call(bytes)) copy.push(byte);
  return new Uint8Array(copy);
}

export function cloneJsonValue(value: unknown): JsonValue {
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
    if (
      cause instanceof AttestationIssuerError &&
      cause.code === "INVALID_ISSUANCE_INPUT"
    ) {
      throw cause;
    }
    invalidInput("Expected a readable JSON value.", cause);
  }
}

function stringifyDeterministically(value: JsonValue, depth = 0): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const outerIndent = "  ".repeat(depth);
  const innerIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) =>
      `${innerIndent}${stringifyDeterministically(item, depth + 1)}`).join(",\n")}\n${outerIndent}]`;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  const object = value as { readonly [key: string]: JsonValue };
  return `{\n${keys.map((key) =>
    `${innerIndent}${JSON.stringify(key)}: ${
      stringifyDeterministically(object[key]!, depth + 1)
    }`).join(",\n")}\n${outerIndent}}`;
}

export function deterministicJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    `${stringifyDeterministically(cloneJsonValue(value))}\n`,
  );
}

export function standardBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
