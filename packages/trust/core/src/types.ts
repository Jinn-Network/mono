// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

export type JsonScalar = string | number | boolean | null;
export type JsonValue =
  | JsonScalar
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** `sha256:<hex>` — the sealed-record digest form used throughout trust-core. */
export type Sha256Digest = `sha256:${string}`;

/** Zod schema for the `sha256:<64 lowercase hex digits>` digest string. */
export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 lowercase hex digits>");

/**
 * A time-anchor reference (design §7.3): a digest naming the anchor
 * observation, plus any deployment-specific extension fields (anchor
 * surfaces vary; the shared shape here is only the reference by digest --
 * `AnchorObservation`, the resolved shape, is owned by `interfaces.ts`, T9).
 */
export const AnchorReferenceSchema = z.looseObject({
  digest: Sha256DigestSchema,
});
export type AnchorReference = z.infer<typeof AnchorReferenceSchema>;
