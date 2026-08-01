// SPDX-License-Identifier: Apache-2.0

/** Canonical dense-array index key: "0" or [1-9][0-9]*, in range, round-trips through String(index). */
export function isCanonicalArrayIndexKey(key: string, length: number): boolean {
  if (key === "length") return false;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  if (!Number.isInteger(index) || index < 0 || index >= length) return false;
  return String(index) === key;
}
