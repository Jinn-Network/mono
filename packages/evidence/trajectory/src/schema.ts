// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { topLevelRecordSchema, closedObjectSchema } from "./extensions.js";
import { TRAJECTORY_PROTOCOL, TRAJECTORY_VOCABULARY_PROFILE } from "./identifiers.js";
import { deriveSpanId, deriveTraceId } from "./identity.js";
import { type SealedRecord, parseExactWithSchema, sealWithSchema } from "./sealing.js";
import { preflightCanonicalInput } from "./preflight.js";
import { SpanSchema } from "./span.js";
import { TIMEBASES } from "./timebase.js";

const LowercaseSha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "sha256 must be exactly 64 lowercase hexadecimal digits");

const AbsoluteIri = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u, "must be an absolute IRI");

/** A digest-bound reference: acquisition hints may vary, identity may not. */
const DigestBearingDescriptorSchema = closedObjectSchema({
  name: z.string().min(1).optional(),
  mediaType: z.string().min(1).optional(),
  uri: z.string().min(1).optional(),
  digest: z.strictObject({ sha256: LowercaseSha256Hex }),
});

const SourceSchema = z.strictObject({
  /** The exact bytes this trajectory was derived from. */
  nativeTrace: DigestBearingDescriptorSchema,
  /** What format those bytes are in — the decoder selection key. */
  formatIri: AbsoluteIri,
});

const DerivationSchema = z.strictObject({
  decoderId: z.string().regex(/^[a-z][a-z0-9-]*$/, "decoder id must be a lowercase slug"),
  decoderVersion: z.string().min(1),
  vocabularyProfile: z.literal(TRAJECTORY_VOCABULARY_PROFILE),
});

const CompletenessSchema = z.strictObject({
  decoded: z.enum(["full", "partial", "empty"]),
  /** Source records the decoder could not interpret, when `decoded` is `partial`. */
  skipped: z.number().int().nonnegative().optional(),
  reason: z.string().min(1).optional(),
});

const TrajectoryRecordCoreSchema = topLevelRecordSchema({
  protocol: z.literal(TRAJECTORY_PROTOCOL),
  source: SourceSchema,
  derivation: DerivationSchema,
  timebase: z.enum(TIMEBASES),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spans: z.array(SpanSchema),
  completeness: CompletenessSchema,
}).superRefine((record, ctx) => {
  const expectedTraceId = deriveTraceId({
    sourceDigest: `sha256:${record.source.nativeTrace.digest.sha256}`,
    formatIri: record.source.formatIri,
    decoderId: record.derivation.decoderId,
    decoderVersion: record.derivation.decoderVersion,
    vocabularyProfile: record.derivation.vocabularyProfile,
  });

  if (record.traceId !== expectedTraceId) {
    ctx.addIssue({
      code: "custom",
      path: ["traceId"],
      message:
        "traceId must equal the value derived from source, formatIri, and derivation",
    });
    return;
  }

  const seen = new Set<string>();
  record.spans.forEach((span, ordinal) => {
    const expectedSpanId = deriveSpanId(record.traceId, ordinal);
    if (span.spanId !== expectedSpanId) {
      ctx.addIssue({
        code: "custom",
        path: ["spans", ordinal, "spanId"],
        message: `spanId must equal the value derived from traceId and ordinal ${String(ordinal)}`,
      });
    }
    if (span.parentSpanId !== null && !seen.has(span.parentSpanId)) {
      ctx.addIssue({
        code: "custom",
        path: ["spans", ordinal, "parentSpanId"],
        message: "parentSpanId must reference an earlier span in this record",
      });
    }
    seen.add(span.spanId);
  });

  if (record.completeness.decoded === "empty" && record.spans.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["completeness", "decoded"],
      message: "an empty decode must carry no spans",
    });
  }
  if (record.completeness.decoded === "full" && record.completeness.skipped !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["completeness", "skipped"],
      message: "a full decode must not report skipped source records",
    });
  }
  if (
    record.completeness.decoded === "partial" &&
    (record.completeness.skipped === undefined || record.completeness.skipped < 1)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["completeness", "skipped"],
      message: "a partial decode must report at least one skipped source record",
    });
  }
});

/** Public facade: descriptor preflight before any Zod object traversal. */
export const TrajectoryRecordSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    try {
      preflightCanonicalInput(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "document failed canonical preflight at parse",
      });
    }
  })
  .pipe(TrajectoryRecordCoreSchema);

export type TrajectoryRecord = z.infer<typeof TrajectoryRecordCoreSchema>;

/** Parse sealed bytes, requiring them to be the one exact canonical encoding. */
export function parseTrajectory(bytes: Uint8Array): TrajectoryRecord {
  return parseExactWithSchema(TrajectoryRecordSchema, bytes);
}

/** Validate, then seal a trajectory document. Throws `InvalidDocumentError` on failure. */
export function sealTrajectory(document: unknown): SealedRecord {
  return sealWithSchema(TrajectoryRecordSchema, document);
}
