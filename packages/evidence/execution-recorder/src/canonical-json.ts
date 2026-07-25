// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "./types.js";

const encoder = new TextEncoder();

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function order(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => order(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, entry]) => [key, order(entry)]),
    );
  }
  return value;
}

export function serializeCanonicalJson(value: JsonValue): Uint8Array {
  return encoder.encode(`${JSON.stringify(order(value), null, 2)}\n`);
}
