// SPDX-License-Identifier: Apache-2.0

/**
 * Compares by UTF-16 code unit. `localeCompare` and `Intl` are banned in
 * production source under `plugin/runtime/src/`; see
 * `.github/scripts/plugin-tree-source-boundaries.test.mjs`.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
