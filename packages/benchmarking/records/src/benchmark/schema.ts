import { z } from "zod";
import { AgentIriSchema, DigestBearingResourceDescriptorSchema } from "../descriptors.js";
import { BENCHMARKING_PROTOCOL } from "../identifiers.js";
import { parseExactWithSchema, sealWithSchema, type SealedRecord } from "../sealing.js";

// A SemVer 2.0.0 version string (§6.1/§6.2).
const SemVer = z.string().regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
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
  notBefore: z.string().datetime({ offset: true }).optional(),
});

export const BenchmarkRecordSchema = z
  .object({
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
  })
  .loose(); // open to namespaced extensions (TEP §21.3)

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
