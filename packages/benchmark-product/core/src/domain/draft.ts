/**
 * Zod schemas for the benchmark-run draft (spec §4.5, §6, §12 A2/A5).
 *
 * This is PRODUCT state — the mutable, pre-lock document a sponsor composes while
 * choosing a task set, arms, assurance, and policy — deliberately NOT the
 * platform's sealed Run record. Compiling a locked draft into a Run record
 * ("lock-time compilation", spec §4.1) is a later packet's job; this module only
 * owns the shape sponsors edit and validate before that compile step exists.
 *
 * Two constraints are mirrored here from the platform, not imported, so this
 * package never takes a source dependency on the platform's internal module
 * layout, and so lock-time compilation is lossless once it lands:
 *
 *  - `ArmIdSchema` mirrors the Run record's armId constraint in
 *    packages/benchmarking/records/src/run/cells.ts (`/^[A-Za-z0-9_-]{1,64}$/`),
 *    so a draft's arm ids are guaranteed to compile into valid Run record
 *    cellKeys at lock time.
 *  - `DecimalStringSchema`'s digest fields use the platform's canonical
 *    lowercase-sha256-hex form, matching
 *    packages/benchmarking/records/src/descriptors.ts `LowercaseSha256HexSchema`.
 */

import { z } from "zod";
import { refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import { LifecycleStateSchema } from "./lifecycle.js";

export const DraftIdSchema = z.string().regex(
  /^[a-z0-9][a-z0-9-]{0,63}$/,
  "draftId must be lowercase alphanumeric with hyphens, starting with a letter or digit, at most 64 characters",
);

/** Mirrors the platform Run record's armId constraint (see module header). */
export const ArmIdSchema = z.string().regex(
  /^[A-Za-z0-9_-]{1,64}$/,
  "armId must match [A-Za-z0-9_-]{1,64}",
);

/** RequirementsMap-shaped, e.g. { harness: "prediction-v1-baseline", isolationPolicy: "unrestricted" }. */
export const PinningSchema = z.record(z.string(), z.unknown());

export const ArmSchema = z.object({
  armId: ArmIdSchema,
  pinning: PinningSchema,
  notes: z.string().optional(),
});

export const ASSURANCE_PRESETS = [
  "direct-check",
  "separate-evaluator",
  "evaluator-panel",
  "strict-agreement",
] as const;

export const AssurancePresetSchema = z.enum(ASSURANCE_PRESETS);

export type AssurancePreset = (typeof ASSURANCE_PRESETS)[number];

export const AssuranceOverridesSchema = z.object({
  independence: z.enum(["gating", "disclosed"]).optional(),
  minVerdicts: z.number().int().positive().optional(),
  distinctEvaluator: z.boolean().optional(),
  verdictRule: z.enum(["sole", "majority", "unanimous"]).optional(),
  /** Pre-lock opt-in for one provider-outage-only evaluation retry. */
  maxInfrastructureRetries: z.union([z.literal(0), z.literal(1)]).optional(),
});

export const AssuranceSchema = z.object({
  preset: AssurancePresetSchema,
  overrides: AssuranceOverridesSchema.optional(),
});

export type Assurance = z.infer<typeof AssuranceSchema>;

export interface ResolvedAssurance {
  readonly independence: "gating" | "disclosed";
  readonly minVerdicts: number;
  readonly distinctEvaluator: boolean;
  readonly verdictRule: "sole" | "majority" | "unanimous";
  readonly maxInfrastructureRetries?: 0 | 1;
}

/**
 * Spec §6 preset → platform-primitive mapping, before overrides.
 *
 * `distinctEvaluator: true` on evaluator-panel and strict-agreement is a BP-10
 * refinement: spec §6 states it explicitly only for separate-evaluator. Without
 * it, a panel or unanimous-agreement preset would silently permit the same
 * principal to both solve and evaluate a cell, defeating the preset's own intent
 * of a gating independence mode — so BP-10 carries the field forward on every
 * `independence: gating` preset.
 */
const ASSURANCE_PRESET_BASE: Readonly<Record<AssurancePreset, ResolvedAssurance>> = {
  "direct-check": { independence: "disclosed", minVerdicts: 1, distinctEvaluator: false, verdictRule: "sole" },
  "separate-evaluator": { independence: "gating", minVerdicts: 1, distinctEvaluator: true, verdictRule: "sole" },
  "evaluator-panel": { independence: "gating", minVerdicts: 2, distinctEvaluator: true, verdictRule: "majority" },
  "strict-agreement": { independence: "gating", minVerdicts: 2, distinctEvaluator: true, verdictRule: "unanimous" },
};

/** Resolves a preset plus optional field-wise overrides to the platform primitives it maps to (spec §6). */
export function resolveAssurance(assurance: Assurance): ResolvedAssurance {
  return { ...ASSURANCE_PRESET_BASE[assurance.preset], ...assurance.overrides };
}

export const DecimalStringSchema = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal string");

/** completenessFloor: a decimal string in (0, 1] — refines DecimalStringSchema by value range. */
export const CompletenessFloorSchema = DecimalStringSchema.refine(
  (value) => Number(value) > 0 && Number(value) <= 1,
  { message: "completenessFloor must be a decimal string in (0, 1]" },
);

export const ReplacementPolicySchema = z.object({
  allowed: z.boolean(),
  maxPerCell: z.number().int().positive().optional(),
});

export const DraftPolicySchema = z.object({
  completenessFloor: CompletenessFloorSchema,
  cellWindowMs: z.number().int().positive(),
  replacement: ReplacementPolicySchema,
  /**
   * RELATIVE close window in milliseconds, measured from `launch` — not an
   * absolute instant. The absolute `closeAt` is computed at lock time by a later
   * packet via an injected clock, which keeps this schema (and every test of it)
   * deterministic and free of wall-clock dependence.
   */
  closeAfterMs: z.number().int().positive(),
});

export const BudgetSchema = z.object({
  perCell: z.object({ solve: DecimalStringSchema, evaluate: DecimalStringSchema }),
  hardCap: DecimalStringSchema,
  unit: z.string().min(1),
});

export const TaskSetSchema = z.discriminatedUnion("kind", [
  // Digest of an imported sealed Benchmark in the workspace store.
  z.object({
    kind: z.literal("benchmark"),
    benchmarkSha256: z.string().regex(/^[a-f0-9]{64}$/, "benchmarkSha256 must be 64 lowercase hex digits"),
  }),
  // Marker a later packet (task sampling) fills.
  z.object({ kind: z.literal("pendingSample") }),
]);

/**
 * Opaque, digest-bound selection of an evaluation runtime. Product lifecycle code owns only
 * this stable adapter reference; the adapter owns the sealed manifest's runtime-specific shape.
 * Absence means the backwards-compatible built-in runtime.
 */
export const EvaluationRuntimeBindingSchema = z.object({
  adapterId: z.string().regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    "adapterId must be lowercase alphanumeric with dots, underscores, or hyphens, at most 64 characters",
  ),
  selectionManifestSha256: z.string().regex(
    /^[a-f0-9]{64}$/,
    "selectionManifestSha256 must be 64 lowercase hex digits",
  ),
  isolationPolicy: z.enum(["unrestricted", "oci-container"]).optional(),
});

export type EvaluationRuntimeBinding = z.infer<typeof EvaluationRuntimeBindingSchema>;

/** Fixed for M1 — the only supported venue is local self-run. */
export const VenueSchema = z.literal("self-run");

/**
 * Which registered §9.2 method produces this run's Report. Optional and additive: an absent
 * block means `wilson@1`, exactly the behavior every draft had before this field existed, so
 * no default is added to DRAFT_SPEC_DEFAULTS and no stored draft needs migrating.
 *
 * `baseline`/`candidate` are explicit rather than positional over `arms` (ratified decision
 * §5.1): arms are unordered, and a positional reading would silently reinterpret the comparison
 * if they were ever reordered. `parameters` are sealed verbatim into the Run's analysisPlan, so
 * fractional values must be decimal strings — sealed records admit only I-JSON integers.
 */
export const AnalysisSchema = z.object({
  method: z.string().min(1),
  version: z.string().min(1),
  baseline: z.string().min(1).optional(),
  candidate: z.string().min(1).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

/**
 * Per-draft anchoring policy (anchor-evidence design §7.3). Optional and additive: an absent block
 * means "whatever the workspace is configured for", exactly the behavior every draft had before
 * this field existed, so — like `analysis` and `budget` — no entry is added to
 * `DRAFT_SPEC_DEFAULTS` and no stored draft needs migrating. Adding a default would also move
 * every existing draft's `specSha256`, invalidating live quotes for a field nobody set.
 *
 * `enabled: false` is the draft's explicit opt-out from a workspace default (§7.3: "once
 * configured at the workspace level, every subsequent lock attempts anchoring automatically; a
 * draft can explicitly disable it").
 *
 * `declaredProviders` is the §7.3 declared intent, sealed into the Run record. It lists profile
 * URIs and never endpoints, and it is the draft's own statement rather than something derived from
 * local configuration: deriving it would make the sealed Run bytes depend on the machine that
 * produced them. The declaration is intent, not proof — the anchor necessarily postdates sealing.
 *
 * Patch semantics are the spec-wide shallow merge (`operations/drafts.ts`): a patch carrying
 * `anchoring` replaces the whole block rather than merging into it.
 */
export const DraftAnchoringSchema = z.object({
  enabled: z.boolean().optional(),
  declaredProviders: z.array(z.string().min(1)).min(1).optional(),
});

export type DraftAnchoring = z.infer<typeof DraftAnchoringSchema>;

export const DraftSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  taskSet: TaskSetSchema,
  // May be empty while drafting; arm-count requirements are lock-time concerns for later packets.
  arms: z.array(ArmSchema),
  replicates: z.number().int().positive(),
  assurance: AssuranceSchema,
  policy: DraftPolicySchema,
  budget: BudgetSchema.optional(),
  venue: VenueSchema,
  evaluationRuntime: EvaluationRuntimeBindingSchema.optional(),
  analysis: AnalysisSchema.optional(),
  anchoring: DraftAnchoringSchema.optional(),
});

export type DraftSpec = z.infer<typeof DraftSpecSchema>;

/** Defaults merged under caller input by createDraft (a later module). */
export const DRAFT_SPEC_DEFAULTS: Omit<DraftSpec, "name" | "description" | "budget"> = {
  taskSet: { kind: "pendingSample" },
  arms: [],
  replicates: 1,
  assurance: { preset: "direct-check" },
  policy: {
    completenessFloor: "1",
    cellWindowMs: 3_600_000,
    replacement: { allowed: false },
    closeAfterMs: 86_400_000,
  },
  venue: "self-run",
};

const Rfc3339Schema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  "must be an RFC3339 timestamp",
);

export const DraftDocumentSchema = z.object({
  draftId: DraftIdSchema,
  createdAt: Rfc3339Schema,
  updatedAt: Rfc3339Schema,
  state: LifecycleStateSchema,
  spec: DraftSpecSchema,
});

export type DraftDocument = z.infer<typeof DraftDocumentSchema>;

function issuesFromZodError(error: z.ZodError): ProductIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

/** safeParse; on failure refuseWithIssues("validation", issues) — each zod issue's dotted path, or "(root)". */
export function parseDraftSpec(input: unknown): DraftSpec {
  const result = DraftSpecSchema.safeParse(input);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  return result.data;
}

/** safeParse; on failure refuseWithIssues("validation", issues) — each zod issue's dotted path, or "(root)". */
export function parseDraftDocument(input: unknown): DraftDocument {
  const result = DraftDocumentSchema.safeParse(input);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  return result.data;
}

/**
 * Deterministic slug: lowercase, every run of characters outside [a-z0-9] becomes
 * one "-", trim leading/trailing "-", cap at 64 chars. Refuses "validation" when
 * the result is empty.
 */
export function draftIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (slug.length === 0) {
    refuse("validation", "name", "name does not yield a usable draft id");
  }
  return slug;
}
