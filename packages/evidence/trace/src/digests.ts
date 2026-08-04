// SPDX-License-Identifier: Apache-2.0

import { InvalidDocumentError } from "./sealing.js";

/** Repository digest form — capture/repository APIs and forward-link PropertyValue.value */
export type RepositorySha256Digest = `sha256:${string}`;

/** ResourceDescriptor / in-toto digest.sha256 form — bare 64 lowercase hex */
export type BareSha256Hex = string;

const REPOSITORY_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BARE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

function requirePrimitiveString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new InvalidDocumentError([{ path, message: `${path} must be a string` }]);
  }
  return value;
}

export function toBareSha256Hex(digest: unknown): BareSha256Hex {
  const value = requirePrimitiveString(digest, "digest");
  if (!REPOSITORY_SHA256_PATTERN.test(value)) {
    throw new InvalidDocumentError([
      { path: "digest", message: "repository digest must match sha256:<64 lowercase hex>" },
    ]);
  }
  return value.slice("sha256:".length);
}

export function toRepositorySha256Digest(hex: unknown): RepositorySha256Digest {
  const value = requirePrimitiveString(hex, "sha256");
  if (!BARE_SHA256_PATTERN.test(value)) {
    throw new InvalidDocumentError([
      { path: "sha256", message: "bare sha256 must be exactly 64 lowercase hexadecimal digits" },
    ]);
  }
  return `sha256:${value}`;
}
