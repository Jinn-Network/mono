// SPDX-License-Identifier: Apache-2.0

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { defensiveCopy } from "./bytes.js";
import { isGenuineUint8Array } from "./hostile-reflection.js";

function invalidBytesInput(message: string): never {
  throw new TypeError(message);
}

export function sha256Hex(bytes: Uint8Array): string {
  if (!isGenuineUint8Array(bytes)) {
    invalidBytesInput("sha256Hex requires a genuine Uint8Array");
  }
  return bytesToHex(sha256(defensiveCopy(bytes)));
}

export function documentDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}
