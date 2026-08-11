// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { refuse } from "./errors.js";

/**
 * Canonical JSON: sorted object keys, no insignificant whitespace, UTF-8 bytes. This is the same
 * spelling the sealed row material uses, so a re-serialization can be compared byte-for-byte
 * against the bytes whose digest the specification committed to.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse("canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
  }
  refuse("canonical JSON cannot encode this value");
}

/** Lowercase hex sha256 of exact bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
