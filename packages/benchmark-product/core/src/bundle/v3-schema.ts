import { z } from "zod";
import { DigestBearingResourceDescriptorSchema } from "@jinn-network/benchmarking-records";

export const BUNDLE_V3_INDEX_FORMAT = "benchmark-product-public-bundle-index/3" as const;

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Rfc3339Schema = z.string().datetime({ offset: true });
const DescriptorSchema = DigestBearingResourceDescriptorSchema;

/**
 * An adapter-owned native artifact disclosure. The first four states are the exact
 * BenchmarkAccounting vocabulary. `scrub-derived` is a bundle-only projection: it never
 * changes an accounting record's source identity, and commits to a distinct derived byte string.
 */
export const BundleV3NativeDisclosureSchema = z.discriminatedUnion("state", [
  z.object({
    cellKey: z.string().min(1),
    dispatch: z.number().int().positive(),
    ordinal: z.number().int().positive(),
    role: z.string().min(1),
    state: z.literal("public"),
    artifact: DescriptorSchema,
    path: z.string().regex(/^native\/[a-f0-9]{64}\.bin$/),
  }),
  z.object({
    cellKey: z.string().min(1),
    dispatch: z.number().int().positive(),
    ordinal: z.number().int().positive(),
    role: z.string().min(1),
    state: z.literal("digest-only"),
    artifact: DescriptorSchema,
    reason: z.string().min(1),
  }),
  z.object({
    cellKey: z.string().min(1),
    dispatch: z.number().int().positive(),
    ordinal: z.number().int().positive(),
    role: z.string().min(1),
    state: z.literal("source-absent"),
    reason: z.string().min(1),
  }),
  z.object({
    cellKey: z.string().min(1),
    dispatch: z.number().int().positive(),
    ordinal: z.number().int().positive(),
    role: z.string().min(1),
    state: z.literal("collection-failed"),
    artifact: DescriptorSchema.optional(),
    reason: z.string().min(1),
  }),
  z.object({
    cellKey: z.string().min(1),
    dispatch: z.number().int().positive(),
    ordinal: z.number().int().positive(),
    role: z.string().min(1),
    state: z.literal("scrub-derived"),
    /** Exact original descriptor from BenchmarkAccounting. */
    source: DescriptorSchema,
    artifact: DescriptorSchema,
    path: z.string().regex(/^native\/[a-f0-9]{64}\.bin$/),
    derivation: z.object({
      procedure: z.string().min(1),
      version: z.string().min(1),
      responsible: z.string().min(1),
      producedAt: Rfc3339Schema,
    }),
  }),
]);
export type BundleV3NativeDisclosure = z.infer<typeof BundleV3NativeDisclosureSchema>;

const SourceReceiptSchema = z.object({
  /** A source position is carried as canonical JSON so a browser need not infer it from prose. */
  position: z.unknown(),
  sha256: Sha256HexSchema,
  path: z.string().regex(/^sources\/[a-f0-9]{64}\.json$/),
});

export const BundleV3IndexSchema = z.object({
  format: z.literal(BUNDLE_V3_INDEX_FORMAT),
  accounting: z.object({ sha256: Sha256HexSchema, path: z.literal("records/accounting.json") }),
  matrix: z.object({ sha256: Sha256HexSchema, path: z.literal("records/matrix.json") }),
  report: z.object({
    payload: z.object({ sha256: Sha256HexSchema, path: z.literal("records/report-payload.json") }),
    envelope: z.object({ sha256: Sha256HexSchema, path: z.literal("records/report-envelope.json") }),
  }).optional(),
  sourceReceipts: z.array(SourceReceiptSchema),
  nativeArtifacts: z.array(BundleV3NativeDisclosureSchema),
});
export type BundleV3Index = z.infer<typeof BundleV3IndexSchema>;
