import { z } from "zod";
import { accessClassifiedResourceDescriptor, ResourceDescriptorSchema } from "../resource-descriptor.js";
import { COMPOSITE_MAX_FANOUT } from "./composite.js";
import { compareCodePointStrings } from "./external-verifier/code-point-order.js";
import type { GraderFamily } from "./schema.js";
import {
  EnvironmentRecordDescriptorSchema,
  EnvelopeTighteningsSchema,
  MEASUREMENT_ONLY_KINDS,
  PREDICATE_SEMANTICS_VERSION,
  PredicateSchema,
  SAFETY_CONSTRAINT_KINDS,
  STATE_PREDICATE_RESERVED_MEASUREMENTS,
  StatePredicateMeasurementSchema,
} from "./state-predicate/vocabulary.js";

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

// --- DeterministicProcess block schema (§7.2) ---

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

// --- state-predicate (chain-environment design §6.1/§6.2, CF1) ---

export const STATE_PREDICATE_FAMILY = "state-predicate" as const;

const STATE_PREDICATE_SHAPE = {
  // The COMPOSITE crypto-environment record, by digest (E11). Never inlined: this family has
  // no inline-match rule to enforce because there is nothing inline to match.
  environmentRecord: EnvironmentRecordDescriptorSchema,
  predicateSemanticsVersion: z.literal(PREDICATE_SEMANTICS_VERSION),
  successPredicates: z.array(PredicateSchema).min(1),
  safetyConstraints: z.array(PredicateSchema),
  measurements: z.array(StatePredicateMeasurementSchema),
  envelopeTightenings: EnvelopeTighteningsSchema.optional(),
  timeout: z.number().int().positive(),
};

export const StatePredicateBlockSchema = withNamespacedExtras(
  z.looseObject(STATE_PREDICATE_SHAPE),
  Object.keys(STATE_PREDICATE_SHAPE),
).superRefine((block, ctx) => {
  block.successPredicates.forEach((predicate, index) => {
    if ((MEASUREMENT_ONLY_KINDS as readonly string[]).includes(predicate.kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["successPredicates", index, "kind"],
        message: `"${predicate.kind}" records what the agent read; it never gates (design §6.2).`,
      });
    }
  });
  block.safetyConstraints.forEach((predicate, index) => {
    if (!(SAFETY_CONSTRAINT_KINDS as readonly string[]).includes(predicate.kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["safetyConstraints", index, "kind"],
        message:
          `safetyConstraints are bounded to log- and transaction-observable kinds in v1 `
          + `(${SAFETY_CONSTRAINT_KINDS.join(", ")}); "${predicate.kind}" reads state, and `
          + "per-operation state snapshots are a parked extension (design §6.2).",
      });
    }
  });
  const names = new Set<string>();
  for (const [index, measurement] of block.measurements.entries()) {
    if ((STATE_PREDICATE_RESERVED_MEASUREMENTS as readonly string[]).includes(measurement.name)) {
      ctx.addIssue({ code: "custom", path: ["measurements", index, "name"], message: `"${measurement.name}" is reserved by the state-predicate verdict rule.` });
    }
    if (names.has(measurement.name)) {
      ctx.addIssue({ code: "custom", path: ["measurements", index, "name"], message: `duplicate measurement name "${measurement.name}".` });
    }
    names.add(measurement.name);
  }
});
export type StatePredicateBlock = z.infer<typeof StatePredicateBlockSchema>;

// --- external-verifier (proposal 0002) ---
//
// The task is judged by a verifier that an external harness ships and runs itself. Whoever seals
// the spec runs no grader, so the block holds only what can be read from the harness's task
// package with nothing invented: which harness, the package's own test files, the image
// reference as the package declares it, and the declared timeout. It has no place for an image
// digest, a platform, a parser identity or a transition list. A block that carries one under a
// bare key is refused, like any other bare extra key.

export const EXTERNAL_VERIFIER_FAMILY = "external-verifier" as const;

/** Versions this family's own rules (how the block, the grader digest and the measurements are
 * read), apart from the top-level `semanticsVersion` every family shares. */
export const EXTERNAL_VERIFIER_SEMANTICS_VERSION = "1" as const;

/** A closed set. The grader digest and the reward map mean nothing without the harness's own
 * rule, so a harness is named here only once the family text states that rule. */
export const EXTERNAL_VERIFIER_HARNESSES = ["harbor"] as const;
export type ExternalVerifierHarness = (typeof EXTERNAL_VERIFIER_HARNESSES)[number];

/** A digest in this family is 64 lowercase hexadecimal digits, never `sha256:`-prefixed. */
export const EXTERNAL_VERIFIER_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

// One of the task package's own test files: named by its path inside the package, pinned by the
// SHA-256 of its bytes, never inlined.
const ExternalVerifierTestMaterialSchema = accessClassifiedResourceDescriptor().superRefine((entry, ctx) => {
  if (entry.name === undefined || entry.name.length === 0) {
    ctx.addIssue({ code: "custom", path: ["name"], message: "testMaterial entry requires name, the file's path inside the task package." });
  }
  const sha256 = entry.digest?.["sha256"];
  if (typeof sha256 !== "string" || !EXTERNAL_VERIFIER_DIGEST_PATTERN.test(sha256)) {
    ctx.addIssue({ code: "custom", path: ["digest", "sha256"], message: "testMaterial entry requires digest.sha256 as bare lowercase hex." });
  }
  if (entry.content !== undefined) {
    ctx.addIssue({ code: "custom", path: ["content"], message: "testMaterial entry is referenced by digest; no file content is inlined." });
  }
});

const EXTERNAL_VERIFIER_SHAPE = {
  harness: z.enum(EXTERNAL_VERIFIER_HARNESSES),
  verifierSemanticsVersion: z.literal(EXTERNAL_VERIFIER_SEMANTICS_VERSION),
  testMaterial: z.array(ExternalVerifierTestMaterialSchema).min(1),
  // The image reference exactly as the task package declares it. A plain string, not a
  // descriptor: a tag is not a reference to fixed bytes, and this field does not pin an image.
  declaredImage: z.string().min(1).optional(),
  // The timeout the task package declares, in seconds.
  timeout: z.number().int().positive(),
};

// An own key named "__proto__" is a bare extra key like any other. zod leaves that one key out
// of a loose object's parsed value, so the extras check below never meets it. It is refused
// here, on the raw value, before the block is parsed.
const ExternalVerifierRawBlockSchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")) {
    ctx.addIssue({
      code: "custom",
      path: ["__proto__"],
      message: 'Extension key "__proto__" must be namespaced (reverse-DNS or absolute URI, TEP §21.3).',
    });
  }
});

export const ExternalVerifierBlockSchema = ExternalVerifierRawBlockSchema.pipe(
  withNamespacedExtras(
    z.looseObject(EXTERNAL_VERIFIER_SHAPE),
    Object.keys(EXTERNAL_VERIFIER_SHAPE),
  ).superRefine((block, ctx) => {
    // Names are unique and ascend by Unicode code point, so one set of files has one block.
    for (let index = 1; index < block.testMaterial.length; index += 1) {
      const previous = block.testMaterial[index - 1]?.name;
      const current = block.testMaterial[index]?.name;
      if (typeof previous !== "string" || typeof current !== "string") continue;
      if (compareCodePointStrings(previous, current) >= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["testMaterial", index, "name"],
          message: `testMaterial names must be unique and ascend by Unicode code point; "${current}" does not follow "${previous}".`,
        });
      }
    }
  }),
);
export type ExternalVerifierBlock = z.infer<typeof ExternalVerifierBlockSchema>;

/** Discriminates the `familyBlock` schema on `EvaluationSpec.family` (wired by schema.ts). */
export const FAMILY_BLOCK_SCHEMAS: Record<GraderFamily, z.ZodTypeAny> = {
  "deterministic-process": DeterministicProcessBlockSchema,
  "model-graded": ModelGradedBlockSchema,
  "human-review": HumanReviewBlockSchema,
  composite: CompositeBlockSchema,
  "state-predicate": StatePredicateBlockSchema,
  "external-verifier": ExternalVerifierBlockSchema,
};
