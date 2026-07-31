import { z } from "zod";

import { CommandSpecSchema } from "./command.js";
import { topLevelRecordSchema } from "./extensions.js";
import { ENVIRONMENT_RECORD_KIND } from "./identifiers.js";
import { parseExactWithSchema, sealWithSchema } from "./sealing.js";

/**
 * Every digest in the record *body* is `sha256:`-prefixed lowercase hex (§4.2). In-toto
 * DigestSet subjects, by contrast, are bare hex — see `bareHexDigest` in hashing.ts.
 */
const PrefixedSha256 = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "record-body digests are sha256:<64 lowercase hex> (§4.2)");

const BareSha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hexadecimal digits");

const NonEmpty = z.string().min(1);

export const EnvironmentSourceSchema = z.strictObject({
  /** Display slug, e.g. `owner/name`. */
  repo: z.string().regex(/^[^\s/]+\/[^\s/]+$/, "repo is a display slug of the form owner/name"),
  repoUrl: z.url(),
  /** The exact tree the environment is declared to contain. */
  commit: z.string().regex(/^[0-9a-f]{40}$/, "commit is a 40-character lowercase hex sha"),
});

/**
 * The image identity is the **platform-specific OCI manifest digest** — never the index
 * digest, never a config or layer digest. Behavior claims are per-platform facts, so one
 * record describes one platform (§4.2).
 */
export const EnvironmentImageSchema = z
  .strictObject({
    manifestDigest: PrefixedSha256,
    platform: z
      .string()
      .regex(/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/, "platform is os/arch[/variant]"),
    /** Advisory pull hint. Identity is `manifestDigest`; this may only agree with it. */
    reference: NonEmpty.optional(),
    /** Optional provenance: the multi-arch index this platform manifest came from. */
    indexDigest: PrefixedSha256.optional(),
  })
  .superRefine((image, ctx) => {
    if (image.reference !== undefined && !image.reference.endsWith(`@${image.manifestDigest}`)) {
      ctx.addIssue({
        code: "custom",
        path: ["reference"],
        message: "reference is advisory and MUST end with @<manifestDigest> (§4.2)",
      });
    }
    if (image.indexDigest !== undefined && image.indexDigest === image.manifestDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["indexDigest"],
        message:
          "indexDigest equals manifestDigest: an index digest is never its own platform "
          + "manifest digest, so one of the two is a confusion (§4.2)",
      });
    }
  });

export const EnvironmentInvocationsSchema = z.strictObject({
  /** Optional — empty when the image is pre-installed (§4.2). */
  install: z.array(CommandSpecSchema).optional(),
  /**
   * Required. This is the **declared verification scope**: an attestation about this
   * environment claims exactly as far as these commands reach and no further. Two records
   * over one image with different scopes are different environments by identity.
   */
  test: z.array(CommandSpecSchema).min(1, "invocations.test is the declared scope and cannot be empty"),
});

/**
 * A parser commits by digest, never by inline source — strict, so a `code`/`source` key is
 * refused rather than accepted as an extension. `uri` is an advisory acquisition hint:
 * without one, a third party cannot execute re-verification even though the digest still
 * tells them whether they have the right parser (§4.2, adversarial review #8).
 */
export const EnvironmentParserSchema = z.strictObject({
  id: NonEmpty,
  version: NonEmpty,
  digest: PrefixedSha256,
  uri: NonEmpty.optional(),
});

/** in-toto v1 ResourceDescriptor shape, structurally mirrored (no cross-package import). */
const ResourceDescriptorSchema = z
  .looseObject({
    name: NonEmpty.optional(),
    uri: NonEmpty.optional(),
    digest: z.record(z.string(), BareSha256Hex).optional(),
    mediaType: NonEmpty.optional(),
    downloadLocation: NonEmpty.optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (descriptor) =>
      descriptor.uri !== undefined
      || (descriptor.digest !== undefined && Object.keys(descriptor.digest).length > 0),
    { message: "a ResourceDescriptor requires at least one of uri/digest" },
  );

export const REPRODUCIBILITY_TIERS = Object.freeze({
  pinnedImage: 0,
  rebuildable: 1,
  bitReproducible: 2,
} as const);

export const EnvironmentBuildSchema = z
  .strictObject({
    /** 0 pinned-image | 1 rebuildable | 2 bit-reproducible (§4.2). */
    reproducibilityTier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    recipe: ResourceDescriptorSchema.optional(),
    /** Declaration of the time-travel mechanism used to pin dependencies. */
    dependencyPinning: z.looseObject({ mechanism: NonEmpty }).optional(),
    provider: z.strictObject({ id: NonEmpty, version: NonEmpty }).optional(),
  })
  .superRefine((build, ctx) => {
    if (build.reproducibilityTier === 0) return;
    if (build.recipe === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["recipe"],
        message: "build.recipe is required at reproducibilityTier >= 1 (§4.2)",
      });
    }
    if (build.dependencyPinning === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["dependencyPinning"],
        message: "build.dependencyPinning is required at reproducibilityTier >= 1 (§4.2)",
      });
    }
  });

/**
 * `sourceLicense` is the owner's **declared** upstream SPDX expression, not a detected one
 * — the record states what the producer asserts and does not claim to have checked it.
 * `basis` is an optional open vocabulary: a producer's provenance note, never pipeline
 * policy (v1 producers write `upstream-permissive-filter`).
 */
export const EnvironmentRightsSchema = z.strictObject({
  sourceLicense: NonEmpty,
  basis: NonEmpty.optional(),
});

/** Present for imported environments; absent for environments described from scratch. */
export const EnvironmentLineageSchema = z.strictObject({
  upstream: z.strictObject({
    dataset: NonEmpty,
    revision: NonEmpty,
    keys: z.array(NonEmpty).min(1),
  }),
});

/**
 * One record = one environment = one `(source, image, platform, invocations, parser)`
 * binding (§4.2). Sealed forever: there is no expiry field and no status field, because
 * staleness is a derived signal consumers compute from attestation history, never a
 * mutation of the record (§4.3).
 */
export const EnvironmentRecordSchema = topLevelRecordSchema({
  kind: z.literal(ENVIRONMENT_RECORD_KIND),
  source: EnvironmentSourceSchema,
  image: EnvironmentImageSchema,
  workspace: z.string().regex(/^\/[^\s]*$/, "workspace is an absolute path inside the image"),
  invocations: EnvironmentInvocationsSchema,
  parser: EnvironmentParserSchema,
  build: EnvironmentBuildSchema,
  rights: EnvironmentRightsSchema,
  lineage: EnvironmentLineageSchema.optional(),
});

export type EnvironmentRecord = z.infer<typeof EnvironmentRecordSchema>;

/**
 * Validate, then canonicalize once. The returned bytes are the record forever; its identity
 * is `environmentRecordDigest(bytes)`.
 */
export function sealEnvironmentRecord(record: unknown): Uint8Array {
  return sealWithSchema(EnvironmentRecordSchema, record);
}

/** Parse sealed bytes, requiring them to be the one exact canonical encoding. */
export function parseEnvironmentRecord(bytes: Uint8Array): EnvironmentRecord {
  return parseExactWithSchema(EnvironmentRecordSchema, bytes);
}
