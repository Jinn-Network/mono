// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic UTF-16 code-unit ordering.
 *
 * `String.prototype.localeCompare` depends on the host locale and the bundled
 * ICU data, so it must never decide the order of anything that reaches
 * canonical bytes or a reported ordering. It is banned in production source
 * under `packages/evidence/`; see
 * `.github/scripts/evidence-source-boundaries.test.mjs`.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
