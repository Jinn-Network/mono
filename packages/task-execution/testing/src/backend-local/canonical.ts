// SPDX-License-Identifier: Apache-2.0

/**
 * Test-infra-only canonicalization for PINNING fixture digests (design §16, program §7.14). This
 * is NOT one of the tree's per-package sealing implementations (Global Constraints — those live
 * in each of the four backend-local packages' own `order.ts`/`canonical-json.ts`, copied
 * verbatim and re-implemented per package); it exists only so this kit's fixtures can carry a
 * golden sha256 digest that a real implementation (Milestone A5 onward) is expected to
 * reproduce once it seals the same logical record through its OWN canonical serializer. The
 * sorting rule is identical (UTF-16 code-unit order, never `localeCompare`) so the pinned
 * digests are meaningful golden values, not incidental to this file's own ordering choice.
 */

/** UTF-16 code-unit order — never `localeCompare` (see any package's `order.ts`). */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`fixture canonicalization: ${value} is not an exactly representable I-JSON integer`);
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((element) => serialize(element)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareCodeUnitStrings);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`fixture canonicalization: unsupported value type "${typeof value}"`);
}

/** Deterministic canonical-JSON string for a fixture record (sorted keys, code-unit order). */
export function serializeCanonicalFixture(value: unknown): string {
  return serialize(value);
}
