// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic UTF-16 code-unit ordering.
 *
 * Canonical Evidence bytes must not depend on the host locale, the bundled ICU
 * data, or the JavaScript engine. `String.prototype.localeCompare` depends on
 * all three and is banned in production source under `packages/evidence/`; see
 * `.github/scripts/evidence-source-boundaries.test.mjs`.
 *
 * This matches `compareKeys` in `@jinn-network/execution-recorder`'s canonical
 * JSON serializer, so array ordering and object-key ordering use one rule.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
