// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  AbsoluteIriSchema,
  DigestBearingResourceDescriptorSchema,
  EvidenceRecordReferenceSchema,
  NonEmptyStringSchema,
  TimestampSchema,
  TypedRecordReferenceSchema,
  isSortedUniqueBy,
  topLevelRecordSchema,
  typedReferenceKey,
} from "./common.js";
import { BENCHMARKING_PROTOCOL_V2 } from "./identifiers.js";
import {
  parseExactWithSchema,
  sealWithSchema,
  type SealedRecord,
} from "./sealing.js";

export const ExecutionCommissioningLinkSchema = topLevelRecordSchema({
  protocol: z.literal(BENCHMARKING_PROTOCOL_V2),
  execution: EvidenceRecordReferenceSchema,
  submission: TypedRecordReferenceSchema,
  attempts: z.array(NonEmptyStringSchema).min(1),
  deliveries: z.array(TypedRecordReferenceSchema),
  observations: DigestBearingResourceDescriptorSchema.optional(),
  accounting: TypedRecordReferenceSchema.optional(),
  publisher: AbsoluteIriSchema,
  linkedAt: TimestampSchema,
}).superRefine((link, ctx) => {
  if (link.execution.family !== "execution-evidence") {
    ctx.addIssue({
      code: "custom",
      path: ["execution", "family"],
      message: "commissioning link must subject execution-evidence",
    });
  }
  if (!isSortedUniqueBy(link.attempts, (value) => value)) {
    ctx.addIssue({
      code: "custom",
      path: ["attempts"],
      message: "attempts must be sorted and unique",
    });
  }
  if (!isSortedUniqueBy(link.deliveries, typedReferenceKey)) {
    ctx.addIssue({
      code: "custom",
      path: ["deliveries"],
      message: "deliveries must be sorted and unique",
    });
  }
});

export type ExecutionCommissioningLink = z.infer<
  typeof ExecutionCommissioningLinkSchema
>;

export function sealExecutionCommissioningLink(
  document: unknown,
): SealedRecord {
  return sealWithSchema(ExecutionCommissioningLinkSchema, document);
}

export function parseExecutionCommissioningLink(
  bytes: Uint8Array,
): ExecutionCommissioningLink {
  return parseExactWithSchema(ExecutionCommissioningLinkSchema, bytes);
}
