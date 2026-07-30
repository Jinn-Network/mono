// SPDX-License-Identifier: Apache-2.0
import { isProxy } from "node:util/types";

import { parseSha256Digest, type Sha256Digest } from
  "@jinn-network/evidence-repository";

import { EvidenceContributionError } from "./errors.js";

const MAX_INERT_DEPTH = 32;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

// The closed-message error class selects its message from `code` alone, so
// validators cannot attach a free-text reason -- field context is dropped
// by design and callers see only the closed INVALID_INPUT code.
function fail(): never {
  throw new EvidenceContributionError("INVALID_INPUT");
}

/**
 * Recursively snapshot `value` into inert, JSON-compatible data: plain
 * objects and dense arrays of strings, finite numbers, booleans, null, and
 * nested objects/arrays only. Rejects proxies, accessor properties, symbol
 * keys, sparse arrays, non-finite numbers, functions, and any prototype
 * other than `Object.prototype`/`null`. Rejects cycles and depth beyond
 * `MAX_INERT_DEPTH`.
 */
export function snapshotInertJsonValue(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
  depth = 0,
): unknown {
  if (depth > MAX_INERT_DEPTH) fail();
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (typeof value !== "object") fail();
  if (isProxy(value)) fail();
  if (ancestors.has(value)) fail();
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (
      keys.length !== value.length ||
      keys.some((key) =>
        !/^(?:0|[1-9]\d*)$/u.test(key) ||
        Number(key) >= value.length ||
        !("value" in descriptors[key]!))
    ) {
      fail();
    }
    return keys
      .sort((left, right) => Number(left) - Number(right))
      .map((key) =>
        snapshotInertJsonValue(
          (descriptors[key] as PropertyDescriptor).value,
          nextAncestors,
          depth + 1,
        ));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const clone: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail();
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) fail();
    if (descriptor.value === undefined) continue;
    clone[key] = snapshotInertJsonValue(
      descriptor.value,
      nextAncestors,
      depth + 1,
    );
  }
  return clone;
}

export function parseContributionDigest(
  value: unknown,
  _field: string,
): Sha256Digest {
  try {
    return parseSha256Digest(value);
  } catch {
    fail();
  }
}

export function parseAbsoluteIri(value: unknown, _field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value)
  ) {
    fail();
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail();
  }
  if (
    parsed.protocol.length < 2 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    fail();
  }
  return value;
}

export function parseContributionTimestamp(
  value: unknown,
  _field: string,
): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) fail();
  if (Number.isNaN(Date.parse(value))) fail();
  return value;
}

export function parseBoundedCount(
  value: unknown,
  _field: string,
  options: { readonly min?: number; readonly max?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail();
  if (options.min !== undefined && value < options.min) fail();
  if (options.max !== undefined && value > options.max) fail();
  return value;
}
