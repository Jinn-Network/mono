// SPDX-License-Identifier: Apache-2.0

import { snapshotByteView } from "./byte-snapshot.js";

/** Returns an owned intrinsic copy; callers may mutate without affecting the source. */
export function defensiveCopy(bytes: Uint8Array): Uint8Array {
  return snapshotByteView(bytes, "byte view");
}

export { snapshotByteView } from "./byte-snapshot.js";

/** Constant-time length check then byte-wise equality. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
