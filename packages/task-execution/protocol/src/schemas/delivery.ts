import { z } from "zod";
import {
  EvidenceRecordReferenceSchema,
  ResourceDescriptorSchema,
  Rfc3339,
  Sha256Digest,
  UrnUuid,
} from "./common.js";

const DeliveryOutputSchema = ResourceDescriptorSchema.and(
  z.object({ name: z.string() }),
);

/** Bounded human-readable summary — no artifact content (§11.2). */
const SummarySchema = z.string().max(4096);

export const DeliveryRecordSchema = z
  .object({
    protocol: z.string().url(),
    attempt: UrnUuid,
    task: Sha256Digest,
    outputs: z.array(DeliveryOutputSchema),
    outcome: z.enum(["fulfilled", "partial", "escalation"]),
    escalationReason: z.string().optional(),
    executionIds: z.array(UrnUuid).optional(),
    evidenceRecords: z.array(EvidenceRecordReferenceSchema).optional(),
    summary: SummarySchema.optional(),
    supersedes: Sha256Digest.optional(), // digest of an earlier Delivery of the SAME Attempt
    createdAt: Rfc3339,
  })
  .loose() // open to namespaced extensions (§21.3)
  .superRefine((delivery, ctx) => {
    if (delivery.outcome === "escalation" && delivery.escalationReason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "outcome \"escalation\" requires escalationReason (§11.2)",
        path: ["escalationReason"],
      });
    }
  });

export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;
