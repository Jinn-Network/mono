// SPDX-License-Identifier: Apache-2.0

/** RFC 8785 property ordering: lexicographic UTF-16 code-unit order. */
export function compareCodeUnitStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
