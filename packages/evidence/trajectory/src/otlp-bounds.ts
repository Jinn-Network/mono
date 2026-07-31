// SPDX-License-Identifier: Apache-2.0

export const UINT64_MAX = 18446744073709551615n;
export const INT64_MIN = -9223372036854775808n;
export const INT64_MAX = 9223372036854775807n;

/** Unsigned decimal without leading zeros (except lone `0`). */
export const DECIMAL_UNSIGNED_PATTERN = /^(0|[1-9]\d*)$/;

/** Signed decimal without leading zeros on the magnitude (except lone `0` / `-0`). */
export const DECIMAL_SIGNED_PATTERN = /^-?(0|[1-9]\d*)$/;

/**
 * Deterministic JSON Schema pattern for canonical unsigned decimals 0..maxInclusive.
 * Branches by decimal length and lexicographic prefix against MAX; no leading zero except `0`.
 */
function effectiveMaxDigitString(maxInclusive: bigint, digitLength: number): string {
  const maxStr = maxInclusive.toString();
  if (digitLength >= maxStr.length) return maxStr;
  const allNines = "9".repeat(digitLength);
  return BigInt(allNines) <= maxInclusive ? allNines : maxStr.slice(0, digitLength);
}

function buildUnsignedDecimalBranches(maxInclusive: bigint, includeZero: boolean): string[] {
  const maxStr = maxInclusive.toString();
  const branchSet = new Set<string>();
  if (includeZero) branchSet.add("0");

  for (let digitLength = 1; digitLength <= maxStr.length; digitLength += 1) {
    const bound = effectiveMaxDigitString(maxInclusive, digitLength);
    for (let index = 0; index < bound.length; index += 1) {
      const prefix = bound.slice(0, index);
      const maxDigit = Number(bound[index]);
      for (let digit = 0; digit < maxDigit; digit += 1) {
        if (index === 0 && digit === 0) continue;
        const remaining = bound.length - index - 1;
        const digitPart = `${prefix}${String(digit)}`;
        branchSet.add(remaining === 0 ? digitPart : `${digitPart}[0-9]{${String(remaining)}}`);
      }
    }
    branchSet.add(bound);
  }

  return [...branchSet];
}

export function buildCanonicalUnsignedDecimalJsonSchemaPattern(maxInclusive: bigint): string {
  return `^(?:${buildUnsignedDecimalBranches(maxInclusive, true).join("|")})$`;
}

/** JSON Schema pattern for uint64 OTLP decimal strings. */
export function uint64DecimalJsonSchemaPattern(): string {
  return buildCanonicalUnsignedDecimalJsonSchemaPattern(UINT64_MAX);
}

function buildNegativeMagnitudeJsonSchemaPattern(maxMagnitudeInclusive: bigint): string {
  return `^-(?:${buildUnsignedDecimalBranches(maxMagnitudeInclusive, false).join("|")})$`;
}

/** Draft-2020-12 node for exact signed int64 decimal strings (including `-0`). */
export function int64DecimalJsonSchemaNode(): {
  readonly type: "string";
  readonly anyOf: readonly [
    { readonly pattern: string },
    { readonly pattern: string },
    { readonly pattern: string },
  ];
} {
  return {
    type: "string",
    anyOf: [
      { pattern: "^-0$" },
      { pattern: buildCanonicalUnsignedDecimalJsonSchemaPattern(INT64_MAX) },
      { pattern: buildNegativeMagnitudeJsonSchemaPattern(-INT64_MIN) },
    ],
  };
}

export function isValidDecimalUint64(value: string): boolean {
  if (!DECIMAL_UNSIGNED_PATTERN.test(value)) return false;
  try {
    return BigInt(value) <= UINT64_MAX;
  } catch {
    return false;
  }
}

export function isValidDecimalInt64(value: string): boolean {
  if (value === "-0") return true;
  if (!DECIMAL_SIGNED_PATTERN.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed >= INT64_MIN && parsed <= INT64_MAX;
  } catch {
    return false;
  }
}

/** Compile a JSON Schema pattern string to a RegExp (anchors preserved). */
export function jsonSchemaPatternToRegExp(pattern: string): RegExp {
  return new RegExp(pattern);
}
