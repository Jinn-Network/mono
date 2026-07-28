import { z } from "zod";
import type { ComparisonClass } from "@jinn-network/task-execution-protocol";
import { TASK_PROFILE_FORMAT_URI } from "../identifiers.js";
import { ResourceDescriptorSchema } from "../resource-descriptor.js";

/**
 * Comparison classes (5, frozen, design §5.1) — the runtime source of truth is this local array
 * (profile-added `requirementKeys` are validated against it), type-bound to protocol's
 * `ComparisonClass` export via `satisfies` so a change to protocol's vocabulary fails this file
 * to compile rather than silently drifting (program §7.3; the same `Extract`-binding philosophy
 * as `errors.ts`'s `ProfilesErrorCode`).
 */
export const COMPARISON_CLASSES = [
  "exact",
  "ceiling",
  "floor",
  "constraint",
  "addable",
] as const satisfies readonly ComparisonClass[];

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const InputSlotSchema = z.looseObject({
  name: z.string(),
  required: z.boolean(),
  descriptorMustCarry: z.array(z.string()),
});

const OutputSlotSchema = z.looseObject({
  name: z.string(),
  required: z.boolean(),
  mediaType: z.string().optional(),
  schema: ResourceDescriptorSchema.optional(),
});

/** Every `requirementKeys[]` entry MUST declare its comparison class (design §5.1/§6.1) —
 * `comparisonClass` is a required field, so an entry omitting it fails schema validation. */
const RequirementKeySchema = z.looseObject({
  key: z.string(),
  comparisonClass: z.enum(COMPARISON_CLASSES),
});

/** A profile may `extends` exactly one parent, digest-pinned (§6.3; refined by sub-profile.ts). */
const ExtendsSchema = z.looseObject({
  uri: z.string(),
  digest: Sha256DigestSchema,
});

/**
 * Top-level task-profile document shape (§6.1). `payloadSchema` is left as an untyped JSON
 * object record here — its structural safety (no external `$ref`, bounded size/depth/pattern
 * length) is Task 9's concern (`payload-schema.ts`); this schema only asserts it is an object.
 */
export const TaskProfileDocumentSchema = z.looseObject({
  protocol: z.literal(TASK_PROFILE_FORMAT_URI),
  profile: z.string(),
  description: z.string(),
  payloadSchema: z.record(z.string(), z.unknown()),
  inputConventions: z.looseObject({ slots: z.array(InputSlotSchema) }),
  outputConventions: z.looseObject({ slots: z.array(OutputSlotSchema) }),
  // WHITELIST only (§6.1) — the evaluation-task derivation itself is fixed by `evaluation-task/1.0`
  // and is never profile-overridable.
  evaluationFamilies: z.array(z.string()),
  requirementKeys: z.array(RequirementKeySchema),
  extends: ExtendsSchema.optional(),
});

export type TaskProfileDocument = z.infer<typeof TaskProfileDocumentSchema>;
