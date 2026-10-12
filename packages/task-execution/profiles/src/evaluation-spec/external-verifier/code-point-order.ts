/**
 * Deterministic ordering by Unicode code point.
 *
 * `compareCodeUnitStrings` (../../order.ts) orders by UTF-16 code unit, which places a
 * supplementary-plane character (a surrogate pair, d800 to dfff) before the basic-plane
 * characters U+E000 to U+FFFF. The `external-verifier` family orders file paths by code point
 * (proposal 0002, sections 2 and 6), which is the order a harness gets when its language holds
 * a string as a sequence of code points. The two orders agree on every pair of strings that
 * holds no supplementary-plane character.
 */
export function compareCodePointStrings(left: string, right: string): number {
  const shared = Math.min(left.length, right.length);
  let index = 0;
  while (index < shared) {
    const leftPoint = left.codePointAt(index)!;
    const rightPoint = right.codePointAt(index)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    index += leftPoint > 0xffff ? 2 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}
