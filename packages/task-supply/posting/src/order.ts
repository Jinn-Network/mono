// SPDX-License-Identifier: MIT

/**
 * UTF-16 code-unit ordering. `String.prototype.localeCompare` reads the host locale and the
 * bundled ICU data, so it must never decide a batch's order: two hosts would plan two different
 * batches from the same pool.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
