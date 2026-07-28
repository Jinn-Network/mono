import { z } from "zod";
import { accessClassifiedResourceDescriptor, ResourceDescriptorSchema } from "../resource-descriptor.js";
import { COMPOSITE_MAX_FANOUT } from "./composite.js";
import type { GraderFamily } from "./schema.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

// TEP §21.3: "Extension fields use namespaced keys (reverse-DNS or absolute-URI names)." A bare
// key like `code` or `hook` is neither, and at the block level it is not a governed extension —
// it is indistinguishable from an attempt to smuggle ungoverned content into a sealed document
// (the same concern that makes ParserIdentitySchema/JudgeModelSchema strict, below).
const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

function isNamespacedExtensionKey(key: string): boolean {
  if (REVERSE_DNS_KEY_PATTERN.test(key)) return true;
  try {
    // An absolute URI has a scheme; the WHATWG URL parser rejects anything without one.
    return new URL(key).protocol.length > 1;
  } catch {
    return false;
  }
}

/**
 * Adds a `superRefine` to a `z.looseObject(shape)` block schema so that any key beyond `shape`'s
 * own MUST be a namespaced extension (§21.3) — a bare extra key is rejected as `invalid-document`,
 * mirroring the strictness already applied to `ParserIdentitySchema`/`JudgeModelSchema` below,
 * just scoped to unknown keys rather than every key.
 */
function withNamespacedExtras<S extends z.ZodTypeAny>(schema: S, knownKeys: readonly string[]): S {
  const known = new Set(knownKeys);
  return schema.superRefine((value, ctx) => {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (known.has(key)) continue;
      if (!isNamespacedExtensionKey(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Extension key "${key}" must be namespaced (reverse-DNS or absolute URI, TEP §21.3).`,
        });
      }
    }
  });
}

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

const DETERMINISTIC_PROCESS_SHAPE = {
  image: ResourceDescriptorSchema,
  platform: z.string(),
  workspace: z.looseObject({}),
  testMaterial: z.array(accessClassifiedResourceDescriptor()),
  parser: ParserIdentitySchema,
  transitions: TransitionsSchema,
  timeout: z.number().int().positive(),
  setupPolicy: z.looseObject({}).optional(),
};

export const DeterministicProcessBlockSchema = withNamespacedExtras(
  z.looseObject(DETERMINISTIC_PROCESS_SHAPE),
  Object.keys(DETERMINISTIC_PROCESS_SHAPE),
);
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

const MODEL_GRADED_SHAPE = {
  rubric: ResourceDescriptorSchema,
  judgeModel: JudgeModelSchema,
  judgeOutputSchema: ResourceDescriptorSchema,
  structuralGates: z.looseObject({}),
};

export const ModelGradedBlockSchema = withNamespacedExtras(
  z.looseObject(MODEL_GRADED_SHAPE),
  Object.keys(MODEL_GRADED_SHAPE),
);
export type ModelGradedBlock = z.infer<typeof ModelGradedBlockSchema>;

// --- human-review (§7.2) ---

const HUMAN_REVIEW_SHAPE = {
  reviewForm: ResourceDescriptorSchema,
  // An instrument declaration (which qualifications the review form requires), not a selection
  // of a specific reviewer — no identity, no PII (§7.2).
  reviewerQualifications: z.looseObject({}),
  attestationShape: z.looseObject({}),
};

export const HumanReviewBlockSchema = withNamespacedExtras(
  z.looseObject(HUMAN_REVIEW_SHAPE),
  Object.keys(HUMAN_REVIEW_SHAPE),
);
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

const COMPOSITE_SHAPE = {
  // Bounded at schema/seal time (§7.1: fan-out ≤ 32) so an out-of-bounds composite is rejected
  // as `invalid-document` on parse, not only by the separately-invoked, resolution-dependent
  // `checkCompositeBounds` (depth stays consumer-invoked — it genuinely needs sub-spec
  // resolution that this schema does not have).
  subSpecs: z.array(CompositeSubSpecSchema).max(COMPOSITE_MAX_FANOUT),
};

export const CompositeBlockSchema = withNamespacedExtras(
  z.looseObject(COMPOSITE_SHAPE),
  Object.keys(COMPOSITE_SHAPE),
);
export type CompositeBlock = z.infer<typeof CompositeBlockSchema>;

/** Discriminates the `familyBlock` schema on `EvaluationSpec.family` (wired by schema.ts). */
export const FAMILY_BLOCK_SCHEMAS: Record<GraderFamily, z.ZodTypeAny> = {
  "deterministic-process": DeterministicProcessBlockSchema,
  "model-graded": ModelGradedBlockSchema,
  "human-review": HumanReviewBlockSchema,
  composite: CompositeBlockSchema,
};
