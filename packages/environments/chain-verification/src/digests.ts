// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

import { invalidInput } from "./errors.js";

const PREFIX = "sha256:";

/** Record-body and scalar predicate digest form (design §4.1). */
export const PrefixedSha256Schema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 lowercase hex digits>");

/**
 * in-toto DigestSet value form: BARE lowercase hex. A `sha256:`-prefixed value here is
 * non-conformant with in-toto and is rejected (design §5.3).
 */
export const BareHexSha256Schema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/,
    "in-toto DigestSet values are bare lowercase hex, never sha256:-prefixed",
  );

export const DigestSetSchema = z.strictObject({ sha256: BareHexSha256Schema });
export type DigestSet = z.infer<typeof DigestSetSchema>;

export const ResourceDescriptorSchema = z.strictObject({
  name: z.string().min(1).optional(),
  /** A locator. Never identity -- the digest is (design §4.1). */
  uri: z.string().min(1).optional(),
  mediaType: z.string().min(1).optional(),
  digest: DigestSetSchema,
});
export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>;

/** The only sanctioned prefixed -> DigestSet crossing. */
export function toDigestSet(digest: Sha256Digest): DigestSet {
  if (!PrefixedSha256Schema.safeParse(digest).success) {
    invalidInput(`Not a sha256:-prefixed lowercase-hex digest: ${String(digest)}`);
  }
  return { sha256: digest.slice(PREFIX.length) };
}

/** The only sanctioned DigestSet -> prefixed crossing. */
export function fromDigestSet(digestSet: DigestSet): Sha256Digest {
  if (!DigestSetSchema.safeParse(digestSet).success) {
    invalidInput("Not a conformant in-toto sha256 DigestSet (bare lowercase hex only).");
  }
  return `${PREFIX}${digestSet.sha256}`;
}
