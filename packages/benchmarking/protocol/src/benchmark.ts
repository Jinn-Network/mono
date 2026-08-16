// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  AbsoluteIriSchema,
  DigestBearingResourceDescriptorSchema,
  NonEmptyStringSchema,
  SemVerSchema,
  TimestampSchema,
  descriptorDigest,
  isSortedUniqueBy,
  topLevelRecordSchema,
} from "./common.js";
import { BENCHMARKING_PROTOCOL_V2 } from "./identifiers.js";
import {
  parseExactWithSchema,
  sealWithSchema,
  type SealedRecord,
} from "./sealing.js";

const BenchmarkItemSchema = z.strictObject({
  task: DigestBearingResourceDescriptorSchema,
  taskProfile: DigestBearingResourceDescriptorSchema.optional(),
  taskSchema: DigestBearingResourceDescriptorSchema.optional(),
  identifiers: z.array(
    z.strictObject({
      scheme: AbsoluteIriSchema,
      value: NonEmptyStringSchema,
    }),
  ),
});

const RevealSchema = z.strictObject({
  policy: z.enum(["immediate", "scheduled", "after-close"]),
  notBefore: TimestampSchema.optional(),
});

export const BenchmarkDefinitionV2Schema = topLevelRecordSchema({
  protocol: z.literal(BENCHMARKING_PROTOCOL_V2),
  name: NonEmptyStringSchema,
  description: z.string(),
  author: AbsoluteIriSchema.optional(),
  version: SemVerSchema,
  supersedes: DigestBearingResourceDescriptorSchema.optional(),
  items: z.array(BenchmarkItemSchema).min(1),
  reveal: RevealSchema,
  license: NonEmptyStringSchema.optional(),
  citation: NonEmptyStringSchema.optional(),
}).superRefine((benchmark, ctx) => {
  if (!isSortedUniqueBy(benchmark.items, (item) => descriptorDigest(item.task))) {
    ctx.addIssue({
      code: "custom",
      path: ["items"],
      message: "benchmark items must be sorted and unique by exact Task digest",
    });
  }
  benchmark.items.forEach((item, index) => {
    if (
      !isSortedUniqueBy(
        item.identifiers,
        (identifier) => `${identifier.scheme}\u0000${identifier.value}`,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "identifiers"],
        message: "identifiers must be sorted and unique",
      });
    }
  });
  if (benchmark.reveal.policy === "scheduled" && benchmark.reveal.notBefore === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["reveal", "notBefore"],
      message: "scheduled reveal requires notBefore",
    });
  }
  if (benchmark.reveal.policy !== "scheduled" && benchmark.reveal.notBefore !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["reveal", "notBefore"],
      message: "notBefore is only valid for scheduled reveal",
    });
  }
});

export type BenchmarkDefinitionV2 = z.infer<
  typeof BenchmarkDefinitionV2Schema
>;

export function sealBenchmarkDefinitionV2(document: unknown): SealedRecord {
  return sealWithSchema(BenchmarkDefinitionV2Schema, document);
}

export function parseBenchmarkDefinitionV2(
  bytes: Uint8Array,
): BenchmarkDefinitionV2 {
  return parseExactWithSchema(BenchmarkDefinitionV2Schema, bytes);
}
