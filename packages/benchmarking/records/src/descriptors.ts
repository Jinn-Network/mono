import { ResourceDescriptorSchema } from "@jinn-network/task-execution-protocol";
import { z } from "zod";

/** Canonical digest-map value used by benchmarking record-to-record identity links. */
export const LowercaseSha256HexSchema = z.string().regex(
  /^[0-9a-f]{64}$/,
  "sha256 must be exactly 64 lowercase hexadecimal digits",
);

/**
 * A ResourceDescriptor whose identity is fixed by sha256. Acquisition URIs and the other
 * generic descriptor hints remain permitted, but can never substitute for the digest.
 */
export const DigestBearingResourceDescriptorSchema = ResourceDescriptorSchema.and(
  z.object({
    digest: z.object({ sha256: LowercaseSha256HexSchema }).loose(),
  }),
);

/** Protocol-layer local mirror of trust-core's absolute Agent IRI rule. */
export const AgentIriSchema = z.string().refine(
  (value) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value),
  { message: "Agent IRI must be an absolute IRI" },
);

export type DigestBearingResourceDescriptor = z.infer<typeof DigestBearingResourceDescriptorSchema>;
