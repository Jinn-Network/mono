import { z } from "zod";

import { ExactSemanticVersion, NonEmpty, PrefixedSha256 } from "./primitives.js";

/** v1 ships one runtime adapter (§10). A second family is a schema version bump. */
export const RUNTIME_FAMILIES = Object.freeze(["anvil"] as const);

/** Values a launch option or non-default EVM setting may take in a sealed document. */
const SettingValue = z.union([z.string(), z.boolean(), z.number().int()]);

/**
 * The image identity is the **platform-specific OCI manifest digest** — never the index
 * digest, never a config or layer digest. Behaviour is a per-platform fact, so one record
 * describes one platform.
 */
export const ChainRuntimeImageSchema = z
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
        message: "reference is advisory and MUST end with @<manifestDigest> (§4.3)",
      });
    }
    if (image.indexDigest !== undefined && image.indexDigest === image.manifestDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["indexDigest"],
        message:
          "indexDigest equals manifestDigest: an index digest is never its own platform "
          + "manifest digest, so one of the two is a confusion (§4.3)",
      });
    }
  });

/**
 * The pinned simulator (§4.3). Every field here is part of the world's identity: any change is
 * a new record. `evm.sandboxChainId` is the id the **sandbox** reports — deliberately named
 * apart from `sourceAnchor.nativeChainId`, because a sandbox reporting 1 for signature and
 * contract compatibility confers no mainnet authority (§4.3, §8).
 */
export const ChainRuntimeSchema = z.strictObject({
  family: z.enum(RUNTIME_FAMILIES),
  version: ExactSemanticVersion,
  image: ChainRuntimeImageSchema,
  binary: z.strictObject({
    name: NonEmpty,
    digest: PrefixedSha256,
    version: NonEmpty.optional(),
  }),
  evm: z.strictObject({
    hardfork: NonEmpty,
    sandboxChainId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    /** Every compatibility setting that departs from the runtime's own defaults. */
    nonDefaultSettings: z.record(z.string(), SettingValue),
  }),
  launch: z.strictObject({
    /** The canonical semantic launch configuration — authoritative. */
    options: z.record(z.string(), SettingValue),
    /** A CLI string may ride as evidence; it is never the definition (§4.3). */
    commandEvidence: NonEmpty.optional(),
  }),
});

export type ChainRuntime = z.infer<typeof ChainRuntimeSchema>;
