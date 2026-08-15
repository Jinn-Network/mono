import { z } from "zod";
import { parseExactDsseEnvelope, recordDigest, type DsseEnvelopeSignature } from "@jinn-network/trust-core";
import { AgentIriSchema, DigestBearingResourceDescriptorSchema, LowercaseSha256HexSchema } from "../descriptors.js";
import { topLevelRecordSchema } from "../extensions.js";
import { BENCHMARKING_PROTOCOL, REPORT_MEDIA_TYPE } from "../identifiers.js";
import { sumAttritionExcluded, validateCompletenessOutcome } from "../completeness.js";
import { AttritionSchema, CompletenessSchema } from "../matrix/schema.js";
import { isJsonValue } from "../json.js";
import { InvalidDocumentError, parseExactWithSchema, sealWithSchema, type SealedRecord } from "../sealing.js";

const JsonValueSchema = z.unknown().refine(isJsonValue, {
  message: "must be a losslessly representable JSON value",
});

const MethodRefSchema = z.object({
  id: z.string(),
  version: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

const IntegrityTiersSchema = z.object({
  "re-derivable": z.number().int().nonnegative(),
  "attested-only": z.number().int().nonnegative(),
});

const PinningAxisCountsSchema = z.object({
  match: z.number().int().nonnegative(),
  mismatch: z.number().int().nonnegative(),
  unverifiable: z.number().int().nonnegative(),
});

const PinningDisclosureSchema = z.object({
  harness: PinningAxisCountsSchema,
  model: PinningAxisCountsSchema,
  loadout: PinningAxisCountsSchema,
  isolation: PinningAxisCountsSchema,
});

const PerSubjectDisclosureSchema = z.object({
  subjectSha256: LowercaseSha256HexSchema,
  integrityTiers: IntegrityTiersSchema,
  pinning: PinningDisclosureSchema,
  independence: z.number().int().nonnegative(),
  completeness: CompletenessSchema,
  attrition: AttritionSchema,
});

const DisclosuresSchema = z.object({
  perSubject: z.array(PerSubjectDisclosureSchema),
});

export const ReportRecordSchema = topLevelRecordSchema({
    protocol: z.literal(BENCHMARKING_PROTOCOL),
    subjects: z.array(DigestBearingResourceDescriptorSchema).min(1),
    method: MethodRefSchema,
    preregistered: z.boolean().optional(),
    results: JsonValueSchema,
    // Required in both runtime and exported Draft 2020-12 wire contracts (§7.113).
    disclosures: DisclosuresSchema,
    limitations: z.array(z.string()).optional(),
    author: AgentIriSchema,
  })
  .superRefine((report, ctx) => {
    if (report.disclosures.perSubject.length !== report.subjects.length) {
      ctx.addIssue({
        code: "custom",
        message: "disclosures.perSubject must have the same length and order as subjects",
        path: ["disclosures", "perSubject"],
      });
    }

    const seen = new Set<string>();
    report.subjects.forEach((subject, index) => {
      const digest = subject.digest.sha256;
      if (seen.has(digest)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate Report subject digest "${digest}"`,
          path: ["subjects", index],
        });
      }
      seen.add(digest);
      const disclosure = report.disclosures?.perSubject[index];
      if (disclosure !== undefined && disclosure.subjectSha256 !== digest) {
        ctx.addIssue({
          code: "custom",
          message: "per-subject disclosure digest/order does not match subjects",
          path: ["disclosures", "perSubject", index, "subjectSha256"],
        });
      }
      if (disclosure !== undefined) {
        const attritionPath = ["disclosures", "perSubject", index, "attrition"] as const;
        const excludedCount = sumAttritionExcluded(disclosure.attrition, ctx, attritionPath);
        validateCompletenessOutcome(
          disclosure.completeness,
          disclosure.completeness.judged,
          excludedCount,
          ctx,
          ["disclosures", "perSubject", index, "completeness"],
          attritionPath,
        );
      }
    });
  });

export type ReportRecord = z.infer<typeof ReportRecordSchema>;

/** Parse and validate raw sealed bytes into a `ReportRecord`; throws `InvalidDocumentError`. */
export function parseReport(bytes: Uint8Array): ReportRecord {
  return parseExactWithSchema(ReportRecordSchema, bytes);
}

/**
 * Validate → seal a Report record document (§9.1). This produces the raw-JCS **record bytes**
 * (the DSSE payload); the DSSE envelope itself is added by `aggregate` via trust-core (M3,
 * program §7.15) — `records` exports no PAE/envelope primitive.
 */
export function sealReport(document: unknown): SealedRecord {
  return sealWithSchema(ReportRecordSchema, document);
}

/**
 * The exact signed Report v2 record. The payload stays Report v1 and retains its raw-JCS
 * identity; the published record identity is the exact DSSE envelope digest.
 * Structural parsing does not claim envelope binding, signature validity, or signer trust.
 */
export interface SignedReportRecord {
  readonly payload: ReportRecord;
  readonly payloadBytes: Uint8Array;
  readonly signatures: readonly DsseEnvelopeSignature[];
  readonly recordDigest: `sha256:${string}`;
}

export function parseSignedReportRecord(envelopeBytes: Uint8Array): SignedReportRecord {
  const envelope = parseExactDsseEnvelope(envelopeBytes);
  if (envelope.payloadType !== REPORT_MEDIA_TYPE) {
    throw new InvalidDocumentError([{
      path: "payloadType",
      message: `signed Report payloadType must be ${REPORT_MEDIA_TYPE}`,
    }]);
  }
  return {
    payload: parseReport(envelope.payloadBytes),
    payloadBytes: envelope.payloadBytes,
    signatures: envelope.signatures,
    recordDigest: recordDigest(envelopeBytes),
  };
}
