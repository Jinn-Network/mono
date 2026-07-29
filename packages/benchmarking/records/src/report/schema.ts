import { z } from "zod";
import { AgentIriSchema, DigestBearingResourceDescriptorSchema, LowercaseSha256HexSchema } from "../descriptors.js";
import { BENCHMARKING_PROTOCOL } from "../identifiers.js";
import { AttritionSchema, CompletenessSchema } from "../matrix/schema.js";
import { isJsonValue } from "../json.js";
import { parseExactWithSchema, sealWithSchema, type SealedRecord } from "../sealing.js";

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

export const ReportRecordSchema = z
  .object({
    protocol: z.literal(BENCHMARKING_PROTOCOL),
    subjects: z.array(DigestBearingResourceDescriptorSchema).min(1),
    method: MethodRefSchema,
    preregistered: z.boolean().optional(),
    results: JsonValueSchema,
    // Required (§9.1: a report that hides attrition is malformed) — see the superRefine below,
    // which is what actually gates this: keeping the raw shape optional lets a document that
    // omits `disclosures` entirely reach a named, message-bearing refine issue instead of a
    // generic "required" type error.
    disclosures: DisclosuresSchema.optional(),
    limitations: z.array(z.string()).optional(),
    author: AgentIriSchema,
  })
  .loose() // open to namespaced extensions (TEP §21.3)
  .superRefine((report, ctx) => {
    if (report.disclosures === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "disclosures is required (§9.1: a report that hides attrition is malformed)",
        path: ["disclosures"],
      });
      return;
    }

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
