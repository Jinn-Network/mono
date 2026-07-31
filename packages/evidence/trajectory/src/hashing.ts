// SPDX-License-Identifier: Apache-2.0

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { snapshotByteView } from "./byte-snapshot.js";

function invalidBytesInput(message: string): never {
  throw new TypeError(message);
}

export function sha256Hex(bytes: Uint8Array): string {
  try {
    return bytesToHex(sha256(snapshotByteView(bytes, "sha256Hex input")));
  } catch {
    invalidBytesInput("sha256Hex requires a genuine Uint8Array");
  }
}

export function documentDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}
