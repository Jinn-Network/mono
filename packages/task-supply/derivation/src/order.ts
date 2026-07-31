// SPDX-License-Identifier: Apache-2.0

/**
 * UTF-16 code-unit comparison. Never `localeCompare`: canonical bytes must not depend on
 * the host locale or bundled ICU data.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left === right) return 0;
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.length < right.length ? -1 : 1;
}
