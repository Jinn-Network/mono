import { z } from "zod";
import { EVALUATION_SPEC_FORMAT_URI } from "../identifiers.js";
import { accessClassifiedResourceDescriptor } from "../resource-descriptor.js";
import { VerdictRuleSchema } from "./verdict-rule.js";
import { UnscorableSchema } from "./unscorable.js";
import { FAMILY_BLOCK_SCHEMAS, STATE_PREDICATE_FAMILY } from "./family-blocks.js";
import { checkStatePredicateSpec } from "./state-predicate/spec-checks.js";

/** Grader families (5, §7.1 + chain-environment design §6/CF1: `state-predicate` added
 * additively — an enum amendment plus a typed block, proposed explicitly, never an appeal to
 * extension rules the profiles design does not carry). */
export const GRADER_FAMILIES = [
  "deterministic-process",
  "model-graded",
  "human-review",
  "composite",
  "state-predicate",
] as const;
export type GraderFamily = (typeof GRADER_FAMILIES)[number];

/** measurement value types the grader family block may deliver (§7.1). */
export const MEASUREMENT_TYPES = ["number", "boolean", "string"] as const;
export const MEASUREMENT_DIRECTIONS = ["higher-better", "lower-better", "none"] as const;

export const MeasurementDeclarationSchema = z.looseObject({
  name: z.string(),
  type: z.enum(MEASUREMENT_TYPES),
  unit: z.string().optional(),
  direction: z.enum(MEASUREMENT_DIRECTIONS).optional(),
  required: z.boolean(),
});
export type MeasurementDeclaration = z.infer<typeof MeasurementDeclarationSchema>;

/** A grader MAY be private — the sealed spec carries only its digest/locator, never a secret. */
const GraderDescriptorSchema = accessClassifiedResourceDescriptor();

export const EvidenceConventionsSchema = z.looseObject({
  requiredRefs: z.array(z.string()),
});
export type EvidenceConventions = z.infer<typeof EvidenceConventionsSchema>;

/**
 * Top-level EvaluationSpec shape (§7.1). `familyBlock` is declared `z.unknown()` at the field
 * level and cross-validated against the schema `family` selects (`FAMILY_BLOCK_SCHEMAS`) in the
 * `superRefine` below — the family/familyBlock pair spans two sibling top-level fields, so a
 * single-field `z.discriminatedUnion` cannot express the pairing.
 */
export const EvaluationSpecSchema = z
  .looseObject({
    protocol: z.literal(EVALUATION_SPEC_FORMAT_URI),
    semanticsVersion: z.string(),
    family: z.enum(GRADER_FAMILIES),
    grader: z.union([GraderDescriptorSchema, z.array(GraderDescriptorSchema)]),
    familyBlock: z.unknown(),
    measurements: z.array(MeasurementDeclarationSchema),
    verdictRule: VerdictRuleSchema,
    unscorable: UnscorableSchema,
    evidenceConventions: EvidenceConventionsSchema,
  })
  .superRefine((spec, ctx) => {
    const blockSchema = FAMILY_BLOCK_SCHEMAS[spec.family];
    const result = blockSchema.safeParse(spec.familyBlock);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: "custom", path: ["familyBlock", ...issue.path], message: issue.message });
      }
    }
    if (spec.family === STATE_PREDICATE_FAMILY) {
      const check = checkStatePredicateSpec(spec);
      if (!check.ok) {
        ctx.addIssue({ code: "custom", message: check.reason });
      }
    }
  });

export type EvaluationSpec = z.infer<typeof EvaluationSpecSchema>;
