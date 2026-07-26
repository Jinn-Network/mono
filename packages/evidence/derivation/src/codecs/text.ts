// SPDX-License-Identifier: Apache-2.0

import { copyBytes, decodeUtf8 } from "../bytes.js";

export function transformTextBytes(
  bytes: Uint8Array,
  replacement?: string,
): Uint8Array {
  if (replacement === undefined || replacement === decodeUtf8(bytes)) {
    return copyBytes(bytes);
  }
  return new TextEncoder().encode(replacement);
}
