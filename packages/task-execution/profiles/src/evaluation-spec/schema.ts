import { z } from "zod";
import { EVALUATION_SPEC_FORMAT_URI } from "../identifiers.js";
import { RESOURCE_DESCRIPTOR_SHAPE, resourceDescriptorHasLocator } from "../resource-descriptor.js";

/** Grader families (4, frozen, §7.1). */
export const GRADER_FAMILIES = [
  "deterministic-process",
  "model-graded",
  "human-review",
  "composite",
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
const GraderDescriptorSchema = z
  .looseObject({
    ...RESOURCE_DESCRIPTOR_SHAPE,
    accessClass: z.enum(["public", "private"]).optional(),
  })
  .refine(resourceDescriptorHasLocator, {
    message: "grader descriptor requires at least one of uri/digest/content (§6.4)",
  });

export const EvidenceConventionsSchema = z.looseObject({
  requiredRefs: z.array(z.string()),
});
export type EvidenceConventions = z.infer<typeof EvidenceConventionsSchema>;

/**
 * Top-level EvaluationSpec shape (§7.1). `verdictRule`, `unscorable`, and `familyBlock` are
 * `z.unknown()` placeholders here; later tasks edit this schema in place to replace each
 * placeholder with its typed shape (verdictRule: Task 4; unscorable: Task 5; familyBlock,
 * discriminated on `family`: Task 6).
 */
export const EvaluationSpecSchema = z.looseObject({
  protocol: z.literal(EVALUATION_SPEC_FORMAT_URI),
  semanticsVersion: z.string(),
  family: z.enum(GRADER_FAMILIES),
  grader: z.union([GraderDescriptorSchema, z.array(GraderDescriptorSchema)]),
  familyBlock: z.unknown(),
  measurements: z.array(MeasurementDeclarationSchema),
  verdictRule: z.unknown(),
  unscorable: z.unknown(),
  evidenceConventions: EvidenceConventionsSchema,
});

export type EvaluationSpec = z.infer<typeof EvaluationSpecSchema>;
