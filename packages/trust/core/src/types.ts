// SPDX-License-Identifier: Apache-2.0

export type JsonScalar = string | number | boolean | null;
export type JsonValue =
  | JsonScalar
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** `sha256:<hex>` — the sealed-record digest form used throughout trust-core. */
export type Sha256Digest = `sha256:${string}`;
