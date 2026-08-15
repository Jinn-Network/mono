// SPDX-License-Identifier: Apache-2.0

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DerivationError } from "./errors.js";

export type Sha256Digest = `sha256:${string}`;

const PREFIXED = /^sha256:[0-9a-f]{64}$/;
const BARE = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function documentDigest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${sha256Hex(bytes)}`;
}

/** Record-body form: `sha256:<64 lowercase hex>` (design §4.2). */
export function assertPrefixedDigest(value: string, field: string): Sha256Digest {
  if (!PREFIXED.test(value)) {
    throw new DerivationError(
      "invalid-input",
      `${field} must be a "sha256:"-prefixed lowercase-hex digest; got ${JSON.stringify(value)}.`,
    );
  }
  return value as Sha256Digest;
}

/** DigestSet form: bare lowercase hex (design §5.1; every `digest.sha256` in profiles). */
export function assertBareHex(value: string, field: string): string {
  if (!BARE.test(value)) {
    throw new DerivationError(
      "invalid-input",
      `${field} must be bare lowercase hex with no "sha256:" prefix; got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export function toBareHex(prefixed: string, field: string): string {
  return assertPrefixedDigest(prefixed, field).slice("sha256:".length);
}

/**
 * Encoding-tolerant equality, used at exactly one seam: comparing a digest this package
 * computed against one produced by a package whose encoding choice is not ours to dictate
 * (the admission receipt's gold-patch hash, run.ts). Everywhere else the strict guards
 * above apply.
 */
export function digestsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string | undefined => {
    if (PREFIXED.test(value)) return value.slice("sha256:".length);
    if (BARE.test(value)) return value;
    return undefined;
  };
  const a = normalize(left);
  const b = normalize(right);
  return a !== undefined && a === b;
}
