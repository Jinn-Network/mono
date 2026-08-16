// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  AbsoluteIriSchema,
  DigestBearingResourceDescriptorSchema,
  NonEmptyStringSchema,
  topLevelRecordSchema,
} from "./common.js";
import { BENCHMARKING_PROTOCOL_V2 } from "./identifiers.js";
import { isJsonValue } from "./json.js";
import {
  parseExactWithSchema,
  sealWithSchema,
  type SealedRecord,
} from "./sealing.js";

const JsonValueSchema = z.unknown().refine(isJsonValue, {
  message: "must be losslessly representable I-JSON",
});

export const EvidenceNativeReportV2Schema = topLevelRecordSchema({
  protocol: z.literal(BENCHMARKING_PROTOCOL_V2),
  subjects: z.tuple([DigestBearingResourceDescriptorSchema]),
  manifest: DigestBearingResourceDescriptorSchema,
  cohort: DigestBearingResourceDescriptorSchema,
  method: z.strictObject({
    id: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    parameters: JsonValueSchema,
    implementation: DigestBearingResourceDescriptorSchema,
  }),
  preregistration: z.enum([
    "prospectively-registered",
    "local-sealed-before-selection",
    "post-hoc-exploratory",
    "unverifiable",
  ]),
  results: JsonValueSchema,
  disclosures: z.strictObject({
    evidenceOrigin: z.record(z.string(), z.number().int().nonnegative()),
    timing: z.record(z.string(), z.number().int().nonnegative()),
    closure: z.record(z.string(), z.number().int().nonnegative()),
    taskRelation: z.record(z.string(), z.number().int().nonnegative()),
    availability: z.record(z.string(), z.number().int().nonnegative()),
    conflictsPreserved: z.number().int().nonnegative(),
    commissioningRequired: z.literal(false),
  }),
  limitations: z.array(NonEmptyStringSchema),
  author: AbsoluteIriSchema,
});

export type EvidenceNativeReportV2 = z.infer<
  typeof EvidenceNativeReportV2Schema
>;

export function sealEvidenceNativeReportV2(document: unknown): SealedRecord {
  return sealWithSchema(EvidenceNativeReportV2Schema, document);
}

export function parseEvidenceNativeReportV2(
  bytes: Uint8Array,
): EvidenceNativeReportV2 {
  return parseExactWithSchema(EvidenceNativeReportV2Schema, bytes);
}
