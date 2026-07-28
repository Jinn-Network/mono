import { z } from "zod";

/** SHA-256 over exact bytes, written `sha256:<64 lowercase hex digits>` (§6.1). */
export const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** A minted `urn:uuid:` IRI (§6.2). */
export const UrnUuid = z.string().regex(
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);

/** RFC 3339 timestamp with an explicit offset. */
export const Rfc3339 = z.string().datetime({ offset: true });

/** in-toto v1 digest set: algorithm name -> hex digest. At least one algorithm required. */
export const DigestMapSchema = z
  .record(z.string(), z.string())
  .refine((digests) => Object.keys(digests).length > 0, {
    message: "digest map must name at least one algorithm",
  });

/**
 * in-toto v1 ResourceDescriptor (§6.4): name, uri, digest, mediaType, downloadLocation,
 * annotations, content — at least one of uri/digest/content is required.
 */
export const ResourceDescriptorSchema = z
  .looseObject({
    name: z.string().optional(),
    uri: z.string().optional(),
    digest: DigestMapSchema.optional(),
    mediaType: z.string().optional(),
    downloadLocation: z.string().optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
    content: z.string().optional(),
  })
  .refine(
    (descriptor) =>
      descriptor.uri !== undefined
      || (descriptor.digest !== undefined && Object.keys(descriptor.digest).length > 0)
      || descriptor.content !== undefined,
    { message: "ResourceDescriptor requires at least one of uri/digest/content (§6.4)" },
  );

/** The structural Evidence Protocol seam (§6.4) — a reference by family + digest only. */
export const EVIDENCE_RECORD_FAMILIES = [
  "execution-evidence",
  "result-evaluation",
  "execution-verification",
] as const;

export const EvidenceRecordReferenceSchema = z.object({
  family: z.enum(EVIDENCE_RECORD_FAMILIES),
  digest: Sha256Digest,
});

/** `effort` core vocabulary tiers (§7.2), ordered low → max for `floor`-class comparison. */
export const EFFORT_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortTier = (typeof EFFORT_TIERS)[number];
export const EffortTierSchema = z.enum(EFFORT_TIERS);

/**
 * Run-pinning key shapes (carried TEP amendment 1, profiles §5): Submission-level execution
 * pinning that shares the Task-requirements vocabulary, extended with these keys.
 */
export const HarnessPinSchema = z
  .looseObject({
    id: z.string(),
    version: z.string().optional(),
    digest: Sha256Digest.optional(),
  })
  .refine((harness) => harness.version !== undefined || harness.digest !== undefined, {
    message: "harness pin requires a version or a digest",
  });

export const ModelPinSchema = z
  .looseObject({
    provider: z.string().optional(),
    id: z.string().optional(),
  })
  .refine((model) => model.provider !== undefined || model.id !== undefined, {
    message: "model constraint/pin requires a provider or an id",
  });

/** Loadout kind namespace: `jinn.skill.v1` is core; other kinds are namespaced extensions. */
export const LoadoutSchema = ResourceDescriptorSchema.and(
  z.object({ kind: z.string() }),
);

export const IsolationPolicySchema = z.string();

/**
 * `requirements` / `preferences` are namespaced-key maps (§7.2). Runtime value shape per key is
 * documented, not exhaustively schema-enforced here — unknown namespaced keys are §21.3
 * extensions and MUST be preserved, so the map stays structurally open.
 */
export const RequirementsMap = z.record(z.string(), z.unknown());
export const PreferencesMap = z.record(z.string(), z.unknown());
