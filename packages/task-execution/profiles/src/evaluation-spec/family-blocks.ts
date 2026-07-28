import { z } from "zod";
import { accessClassifiedResourceDescriptor, ResourceDescriptorSchema } from "../resource-descriptor.js";
import type { GraderFamily } from "./schema.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * A parser's semantic commitment is its digest, never inline source (§7.2/§11). The trusted
 * parser registry (parser-registry.ts) is a deployment-side execution allowlist over this
 * identity, not a document-validity condition: task/spec-supplied parser code is never
 * executed, so this schema is deliberately **strict** — an inline `code`/`source` field, or any
 * other extra key, is not a namespaced extension here, it is an attempt to smuggle executable
 * content into a sealed document, and is rejected.
 */
export const ParserIdentitySchema = z.strictObject({
  id: z.string(),
  version: z.string(),
  digest: Sha256DigestSchema,
});
export type ParserIdentity = z.infer<typeof ParserIdentitySchema>;

// --- deterministic-process (§7.2) ---

const TransitionsSchema = z.looseObject({
  failToPass: z.array(z.string()),
  passToPass: z.array(z.string()),
});

export const DeterministicProcessBlockSchema = z.looseObject({
  image: ResourceDescriptorSchema,
  platform: z.string(),
  workspace: z.looseObject({}),
  testMaterial: z.array(accessClassifiedResourceDescriptor()),
  parser: ParserIdentitySchema,
  transitions: TransitionsSchema,
  timeout: z.number().int().positive(),
  setupPolicy: z.looseObject({}).optional(),
});
export type DeterministicProcessBlock = z.infer<typeof DeterministicProcessBlockSchema>;

// --- model-graded (§7.2) ---

// No invented digests (Evidence opaque-component rules, §7.2/§11): a judge model is identified
// by provider/modelId/advertisedVersion only — strict so a fabricated `digest` (or any other
// extra key) is rejected rather than silently accepted as an extension.
const JudgeModelSchema = z.strictObject({
  provider: z.string(),
  modelId: z.string(),
  advertisedVersion: z.string().optional(),
  // Fractional judge parameters (e.g. `temperature`) are string decimals, never JSON numbers
  // (Global Constraints/§7.14). This field type stays permissive at the schema layer — the seal
  // path's I-JSON integer check (`assertIJsonNumbers`) is what actually rejects a fractional
  // JSON number when the document reaches sealed bytes.
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const ModelGradedBlockSchema = z.looseObject({
  rubric: ResourceDescriptorSchema,
  judgeModel: JudgeModelSchema,
  judgeOutputSchema: ResourceDescriptorSchema,
  structuralGates: z.looseObject({}),
});
export type ModelGradedBlock = z.infer<typeof ModelGradedBlockSchema>;

// --- human-review (§7.2) ---

export const HumanReviewBlockSchema = z.looseObject({
  reviewForm: ResourceDescriptorSchema,
  // An instrument declaration (which qualifications the review form requires), not a selection
  // of a specific reviewer — no identity, no PII (§7.2).
  reviewerQualifications: z.looseObject({}),
  attestationShape: z.looseObject({}),
});
export type HumanReviewBlock = z.infer<typeof HumanReviewBlockSchema>;

// --- composite (§7.1/§7.2/§7.14) ---

// A decimal string, e.g. "0.5" or "1" — never a JSON number: sealed bytes admit only I-JSON
// integers (Global Constraints/§7.14), so a `weight` authored as a JSON number fails this schema
// directly rather than surviving to the seal-time check.
const DecimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, "weight must be a decimal string");

const CompositeSubSpecSchema = z.looseObject({
  spec: ResourceDescriptorSchema,
  weight: DecimalStringSchema,
});

export const CompositeBlockSchema = z.looseObject({
  subSpecs: z.array(CompositeSubSpecSchema),
});
export type CompositeBlock = z.infer<typeof CompositeBlockSchema>;

/** Discriminates the `familyBlock` schema on `EvaluationSpec.family` (wired by schema.ts). */
export const FAMILY_BLOCK_SCHEMAS: Record<GraderFamily, z.ZodTypeAny> = {
  "deterministic-process": DeterministicProcessBlockSchema,
  "model-graded": ModelGradedBlockSchema,
  "human-review": HumanReviewBlockSchema,
  composite: CompositeBlockSchema,
};
