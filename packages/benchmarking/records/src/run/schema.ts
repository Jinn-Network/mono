import { z } from "zod";
import { RequirementsMap } from "@jinn-network/task-execution-protocol";
import { serializeCanonicalJson } from "../canonical.js";
import { AgentIriSchema, DigestBearingResourceDescriptorSchema } from "../descriptors.js";
import { topLevelRecordSchema } from "../extensions.js";
import { BENCHMARKING_PROTOCOL } from "../identifiers.js";
import type { JsonValue } from "../json.js";
import { parseExactWithSchema, sealWithSchema, type SealedRecord } from "../sealing.js";
import { isCalendarStrictRfc3339 } from "../rfc3339.js";
import { ArmIdSchema, ReplicateSchema } from "./cells.js";
import { exactDecimalInUnitInterval } from "../decimal.js";
import { ANCHOR_INTENT_EXTENSION, BENCHMARK_PUBLICATION_EXTENSION, TASK_SELECTION_EXTENSION } from "../identifiers.js";
import { RunPublicationExtensionSchema } from "../publication-extension.js";
import { RunAnchorIntentExtensionSchema } from "../anchor-intent-extension.js";
import { RunTaskSelectionExtensionSchema } from "../task-selection.js";

const Rfc3339 = z.string().refine(isCalendarStrictRfc3339, "must be a calendar-valid RFC 3339 timestamp");

/**
 * A decimal-string quantity (program §7.1/§7.14: sealed bytes admit only exact I-JSON integer
 * numbers — any inherently fractional quantity, such as a (0,1] completeness floor or a budget
 * amount, is a string).
 */
const DecimalString = z.string().regex(/^\d+(\.\d+)?$/, "must be a decimal string");

const ArmSchema = z.object({
  armId: ArmIdSchema,
  pinning: RequirementsMap,
  execution: z.object({ allowlist: z.array(AgentIriSchema) }).optional(),
});

const ReplacementPolicySchema = z.object({
  allowed: z.boolean(),
  maxPerCell: z.number().int().positive().optional(),
});

const EvaluationPolicySchema = z.object({
  minVerdicts: z.number().int().positive().optional(),
  distinctEvaluator: z.boolean().optional(),
  /** Number of same-cell evaluation retries permitted after a machine-classified provider
   * outage. Absence is the legacy zero-retry contract. Kept deliberately bounded to one: this
   * is crash/infrastructure recovery, never an open-ended attempt budget. */
  maxInfrastructureRetries: z.union([z.literal(0), z.literal(1)]).optional(),
});

const RunPolicySchema = z.object({
  completenessFloor: DecimalString,
  cellWindow: z.number().int().positive(),
  replacement: ReplacementPolicySchema,
  independence: z.enum(["gating", "disclosed"]),
  evaluation: EvaluationPolicySchema,
  submissionBaseline: RequirementsMap,
  participantExclusions: z.array(AgentIriSchema).optional(),
});

const AnalysisPlanEntrySchema = z.object({
  method: z.string(),
  version: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

const BudgetSchema = z.object({
  perCell: z.object({ solve: DecimalString, evaluate: DecimalString }),
  hardCap: DecimalString,
  unit: z.string(),
});

const VenueSchema = z.object({
  kind: z.enum(["self-run", "open-competition"]),
  note: z.string().optional(),
});

function pinningBytes(pinning: Record<string, unknown> | undefined): string {
  return new TextDecoder().decode(serializeCanonicalJson((pinning ?? {}) as JsonValue));
}

export const RunRecordSchema = topLevelRecordSchema({
    protocol: z.literal(BENCHMARKING_PROTOCOL),
    benchmark: DigestBearingResourceDescriptorSchema,
    owner: AgentIriSchema,
    arms: z.array(ArmSchema).min(1),
    replicates: ReplicateSchema,
    policy: RunPolicySchema,
    analysisPlan: z.array(AnalysisPlanEntrySchema).optional(),
    budget: BudgetSchema.optional(),
    venue: VenueSchema.optional(),
    closeAt: Rfc3339,
  })
  .superRefine((run, ctx) => {
    const publicationExtension = run[BENCHMARK_PUBLICATION_EXTENSION];
    if (publicationExtension !== undefined) {
      const parsed = RunPublicationExtensionSchema.safeParse(publicationExtension);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [BENCHMARK_PUBLICATION_EXTENSION, ...issue.path] });
        }
      }
    }

    // Same treatment for the anchor-intent declaration (anchor-evidence design §7.3). A namespaced
    // extension whose value is present but malformed is a malformed RECORD, and saying so here is
    // what keeps it a typed record refusal at every reader. Left to the reader, the first consumer
    // to touch the field would raise a raw schema error out of a code path that has no way to
    // classify it -- which reaches an operator as an internal failure rather than as "this Run does
    // not conform".
    const anchorIntentExtension = run[ANCHOR_INTENT_EXTENSION];
    if (anchorIntentExtension !== undefined) {
      const parsed = RunAnchorIntentExtensionSchema.safeParse(anchorIntentExtension);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [ANCHOR_INTENT_EXTENSION, ...issue.path] });
        }
      }
    }

    // Task-selection provenance (#2980) gets the same treatment for the same reason: a present but
    // out-of-vocabulary declaration is a malformed RECORD, and saying so here keeps it a typed
    // record refusal rather than a raw schema error out of whichever reader touches it first.
    const taskSelectionExtension = run[TASK_SELECTION_EXTENSION];
    if (taskSelectionExtension !== undefined) {
      const parsed = RunTaskSelectionExtensionSchema.safeParse(taskSelectionExtension);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [TASK_SELECTION_EXTENSION, ...issue.path] });
        }
      }
    }

    if (!exactDecimalInUnitInterval(run.policy.completenessFloor)) {
      ctx.addIssue({
        code: "custom",
        message: "policy.completenessFloor must be in (0,1] (§7.1)",
        path: ["policy", "completenessFloor"],
      });
    }

    if (run.venue?.kind === "open-competition" && run.policy.independence !== "gating") {
      ctx.addIssue({
        code: "custom",
        message: 'policy.independence must be "gating" for open-competition venues (§7.1)',
        path: ["policy", "independence"],
      });
    }

    const seenByBytes = new Map<string, number>();
    run.arms.forEach((arm, index) => {
      for (const key of Object.keys(arm.pinning)) {
        if (Object.hasOwn(run.policy.submissionBaseline, key)) {
          ctx.addIssue({
            code: "custom",
            message: `arms[${index}].pinning.${key} collides with policy.submissionBaseline.${key} (§7.79)`,
            path: ["arms", index, "pinning", key],
          });
        }
      }
      const bytes = pinningBytes(arm.pinning);
      const firstIndex = seenByBytes.get(bytes);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `arms[${firstIndex}] and arms[${index}] have byte-identical pinning; arms MUST be pairwise distinct in their pinning (§7.1)`,
          path: ["arms", index, "pinning"],
        });
      } else {
        seenByBytes.set(bytes, index);
      }
    });

    const seenArmIds = new Set<string>();
    run.arms.forEach((arm, index) => {
      if (seenArmIds.has(arm.armId)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate armId "${arm.armId}" (§7.1: armId is unique within the run)`,
          path: ["arms", index, "armId"],
        });
      } else {
        seenArmIds.add(arm.armId);
      }
    });
  });

export type RunRecord = z.infer<typeof RunRecordSchema>;
export type RunArm = RunRecord["arms"][number];

/** Parse and validate raw sealed bytes into a `RunRecord`; throws `InvalidDocumentError`. */
export function parseRun(bytes: Uint8Array): RunRecord {
  return parseExactWithSchema(RunRecordSchema, bytes);
}

/** Validate → seal a Run record document (§7.1). */
export function sealRun(document: unknown): SealedRecord {
  return sealWithSchema(RunRecordSchema, document);
}
