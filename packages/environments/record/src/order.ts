/**
 * Deterministic UTF-16 code-unit ordering.
 *
 * `String.prototype.localeCompare` depends on the host locale and the bundled ICU data, so
 * it must never decide the order of anything that reaches canonical bytes. It is banned in
 * production source under `packages/environments/`; see
 * `.github/scripts/environments-source-boundaries.test.mjs`.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
