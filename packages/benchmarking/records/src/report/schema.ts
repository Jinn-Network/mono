import { z } from "zod";
import { ResourceDescriptorSchema } from "@jinn-network/task-execution-protocol";
import { BENCHMARKING_PROTOCOL } from "../identifiers.js";
import { InvalidDocumentError, sealWithSchema, type SealedRecord } from "../sealing.js";

/** A decimal-string quantity (program §7.1/§7.14: fractional numbers are strings). */
const DecimalString = z.string().regex(/^\d+(\.\d+)?$/, "must be a decimal string");

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

const DisclosureCompletenessSchema = z.object({
  expected: z.number().int().nonnegative(),
  judged: z.number().int().nonnegative(),
  floor: DecimalString,
  runOutcome: z.enum(["complete", "partial", "cancelled"]),
});

const DisclosureAttritionSchema = z.object({
  asymmetryFlags: z.array(z.string()),
  perArm: z.record(z.string(), z.object({ nonJudged: z.number().int().nonnegative() })),
});

const DisclosuresSchema = z.object({
  integrityTiers: IntegrityTiersSchema,
  pinning: PinningDisclosureSchema,
  independence: z.number().int().nonnegative(),
  completeness: DisclosureCompletenessSchema,
  attrition: DisclosureAttritionSchema,
});

export const ReportRecordSchema = z
  .object({
    protocol: z.literal(BENCHMARKING_PROTOCOL),
    subjects: z.array(ResourceDescriptorSchema).min(1),
    method: MethodRefSchema,
    preregistered: z.boolean().optional(),
    results: z.unknown(),
    // Required (§9.1: a report that hides attrition is malformed) — see the superRefine below,
    // which is what actually gates this: keeping the raw shape optional lets a document that
    // omits `disclosures` entirely reach a named, message-bearing refine issue instead of a
    // generic "required" type error.
    disclosures: DisclosuresSchema.optional(),
    limitations: z.array(z.string()).optional(),
    author: z.string(),
  })
  .loose() // open to namespaced extensions (TEP §21.3)
  .superRefine((report, ctx) => {
    if (report.disclosures === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "disclosures is required (§9.1: a report that hides attrition is malformed)",
        path: ["disclosures"],
      });
    }
  });

export type ReportRecord = z.infer<typeof ReportRecordSchema>;

/** Parse and validate raw sealed bytes into a `ReportRecord`; throws `InvalidDocumentError`. */
export function parseReport(bytes: Uint8Array): ReportRecord {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InvalidDocumentError([{ path: "", message: "not valid JSON" }]);
  }
  const parsed = ReportRecordSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidDocumentError(
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return parsed.data;
}

/**
 * Validate → seal a Report record document (§9.1). This produces the raw-JCS **record bytes**
 * (the DSSE payload); the DSSE envelope itself is added by `aggregate` via trust-core (M3,
 * program §7.15) — `records` exports no PAE/envelope primitive.
 */
export function sealReport(document: unknown): SealedRecord {
  return sealWithSchema(ReportRecordSchema, document);
}
