// SPDX-License-Identifier: Apache-2.0

/**
 * The one sorted-unique helper this package uses (issue #3820).
 *
 * Ordering comes from the protocol's `compareCodeUnitStrings` rather than a local re-declaration:
 * the protocol's `isSortedUniqueBy` checks sealed records against that exact ordering, so a package
 * which must agree with the protocol imports the rule instead of restating it.
 */

import { compareCodeUnitStrings } from "@jinn-network/benchmarking-protocol";

import { NativeCaptureError, type NativeCaptureErrorCode } from "./errors.js";

/**
 * Sorts `values` by `key` in code-unit order and rejects a duplicate key. The caller supplies the
 * error code and message because the capture and commissioning paths classify a duplicate
 * differently -- a repeated native coordinate is a `DUPLICATE_NATIVE_UNIT`, a repeated
 * commissioning attempt or delivery is `CAPTURE_NONCONFORMING`.
 */
export function sortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  code: NativeCaptureErrorCode,
  message: string,
): T[] {
  const sorted = [...values].sort((left, right) => compareCodeUnitStrings(key(left), key(right)));
  if (sorted.some((value, index) => index > 0 && key(sorted[index - 1]!) === key(value))) {
    throw new NativeCaptureError(code, message);
  }
  return sorted;
}
