import { z } from "zod";
import { AgentIriSchema, DigestBearingResourceDescriptorSchema } from "../descriptors.js";
import { topLevelRecordSchema } from "../extensions.js";
import { BENCHMARKING_PROTOCOL } from "../identifiers.js";
import { parseExactWithSchema, sealWithSchema, type SealedRecord } from "../sealing.js";
import { isCalendarStrictRfc3339 } from "../rfc3339.js";

// The complete SemVer 2.0.0 grammar (§6.1/§6.2): core numeric identifiers and numeric
// prerelease identifiers forbid leading zeroes; build identifiers deliberately do not.
const SemVer = z.string().regex(
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  "must be a SemVer 2.0.0 version string",
);

// §6.1: a Benchmark item's task reference always commits to a sha256 digest — unlike a general
// ResourceDescriptor (satisfiable by uri/digest/content alone), an item's identity is content.
const BenchmarkTaskReferenceSchema = DigestBearingResourceDescriptorSchema;

const BenchmarkItemSchema = z.object({
  task: BenchmarkTaskReferenceSchema,
});

const RevealSchema = z.object({
  policy: z.enum(["immediate", "scheduled", "after-run"]),
  notBefore: z.string().refine(isCalendarStrictRfc3339, "must be a calendar-valid RFC 3339 timestamp").optional(),
});

export const BenchmarkRecordSchema = topLevelRecordSchema({
  protocol: z.literal(BENCHMARKING_PROTOCOL),
  name: z.string(),
  description: z.string(),
  author: AgentIriSchema.optional(),
  version: SemVer,
  supersedes: DigestBearingResourceDescriptorSchema.optional(),
  items: z.array(BenchmarkItemSchema),
  reveal: RevealSchema,
  license: z.string().optional(),
  citation: z.string().optional(),
});

export type BenchmarkRecord = z.infer<typeof BenchmarkRecordSchema>;
export type BenchmarkItem = BenchmarkRecord["items"][number];

/** The item's Task digest, guaranteed present by the schema's sha256-digest refinement. */
export function itemTaskDigest(item: BenchmarkItem): string {
  const digest = item.task.digest?.sha256;
  if (typeof digest !== "string") {
    throw new Error("Benchmark item's task descriptor lacks a sha256 digest (schema invariant violated)");
  }
  return digest;
}

/** Parse and validate raw sealed bytes into a `BenchmarkRecord`; throws `InvalidDocumentError`. */
export function parseBenchmark(bytes: Uint8Array): BenchmarkRecord {
  return parseExactWithSchema(BenchmarkRecordSchema, bytes);
}

/** Validate → seal a Benchmark record document (§6.1). */
export function sealBenchmark(document: unknown): SealedRecord {
  return sealWithSchema(BenchmarkRecordSchema, document);
}
