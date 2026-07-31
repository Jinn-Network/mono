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
