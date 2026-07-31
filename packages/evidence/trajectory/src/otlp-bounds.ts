// SPDX-License-Identifier: Apache-2.0

export const UINT64_MAX = 18446744073709551615n;
export const INT64_MIN = -9223372036854775808n;
export const INT64_MAX = 9223372036854775807n;

/** Unsigned decimal without leading zeros (except lone `0`). */
export const DECIMAL_UNSIGNED_PATTERN = /^(0|[1-9]\d*)$/;

/** Signed decimal without leading zeros on the magnitude (except lone `0` / `-0`). */
export const DECIMAL_SIGNED_PATTERN = /^-?(0|[1-9]\d*)$/;

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

/** JSON Schema syntax gate for signed decimal strings (canonical form, including `-0`). */
export const DECIMAL_SIGNED_JSON_SCHEMA_PATTERN = "^-?(0|[1-9]\\d*)$";

/**
 * Positive int64 overflow branches for JSON Schema `not.anyOf` (canonical decimals only).
 * Matches values strictly greater than 9223372036854775807.
 */
export const INT64_POSITIVE_OVERFLOW_JSON_SCHEMA_PATTERNS = [
  "^922337203685477580[89]\\d*$",
  "^92233720368547759\\d+$",
  "^9223372036854776\\d+$",
  "^922337203685477[89]\\d*$",
  "^922337203685478\\d*$",
  "^92233720368548\\d*$",
  "^9223372036855\\d+$",
  "^9223372036856\\d+$",
  "^9223372036857\\d+$",
  "^9223372036858\\d+$",
  "^9223372036859\\d+$",
  "^922337203686\\d*$",
  "^92233720369\\d+$",
  "^9223372037\\d+$",
  "^922337203[89]\\d*$",
  "^922337204\\d+$",
  "^92233721\\d+$",
  "^9223373\\d+$",
  "^922338\\d+$",
  "^92234\\d+$",
  "^9224\\d+$",
  "^923\\d+$",
  "^93\\d+$",
  "^[1-9]\\d{19,}$",
] as const;

/**
 * Negative int64 underflow branches for JSON Schema `not.anyOf` (canonical decimals only).
 * Matches values strictly less than -9223372036854775808.
 */
export const INT64_NEGATIVE_OVERFLOW_JSON_SCHEMA_PATTERNS = [
  "^-9223372036854775809$",
  "^-92233720368547758[1-9]\\d*$",
  "^-92233720368547759\\d*$",
  "^-9223372036854776\\d+$",
  "^-922337203685477[89]\\d*$",
  "^-922337203685478\\d*$",
  "^-92233720368548\\d*$",
  "^-9223372036855\\d+$",
  "^-9223372036856\\d+$",
  "^-9223372036857\\d+$",
  "^-9223372036858\\d+$",
  "^-9223372036859\\d+$",
  "^-922337203686\\d*$",
  "^-92233720369\\d+$",
  "^-9223372037\\d+$",
  "^-922337203[89]\\d*$",
  "^-922337204\\d+$",
  "^-92233721\\d+$",
  "^-9223373\\d+$",
  "^-922338\\d+$",
  "^-92234\\d+$",
  "^-9224\\d+$",
  "^-923\\d+$",
  "^-93\\d+$",
  "^-[1-9]\\d{19,}$",
] as const;

/** Draft-2020-12 node for exact signed int64 decimal strings. */
export function int64DecimalJsonSchemaNode(): {
  readonly type: "string";
  readonly allOf: readonly [
    { readonly pattern: string },
    { readonly not: { readonly anyOf: readonly { readonly pattern: string }[] } },
  ];
} {
  return {
    type: "string",
    allOf: [
      { pattern: DECIMAL_SIGNED_JSON_SCHEMA_PATTERN },
      {
        not: {
          anyOf: [
            ...INT64_POSITIVE_OVERFLOW_JSON_SCHEMA_PATTERNS,
            ...INT64_NEGATIVE_OVERFLOW_JSON_SCHEMA_PATTERNS,
          ].map((pattern) => ({ pattern })),
        },
      },
    ],
  };
}
