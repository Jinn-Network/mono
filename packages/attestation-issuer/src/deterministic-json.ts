// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { invalidInput } from "./errors.js";
import type { JsonValue } from "./types.js";

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
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
      if (Array.isArray(candidate)) return candidate.map(visit);
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        invalidInput("JSON objects must have a safe plain-object prototype.");
      }
      const output: Record<string, JsonValue> = {};
      for (const key of Object.keys(candidate).sort()) {
        output[key] = visit((candidate as Record<string, unknown>)[key]);
      }
      return output;
    } finally {
      active.delete(container);
    }
  };

  return visit(value);
}

export function deterministicJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(cloneJsonValue(value), null, 2)}\n`);
}

export function standardBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
