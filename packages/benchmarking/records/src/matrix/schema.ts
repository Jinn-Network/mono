import { z } from "zod";
import { Sha256Digest } from "@jinn-network/task-execution-protocol";
import { AgentIriSchema, DigestBearingResourceDescriptorSchema } from "../descriptors.js";
import { topLevelRecordSchema } from "../extensions.js";
import { BENCHMARKING_PROTOCOL } from "../identifiers.js";
import { compareCodeUnitStrings } from "../order.js";
import { parseExactWithSchema, sealWithSchema, type SealedRecord } from "../sealing.js";
import { isCalendarStrictRfc3339 } from "../rfc3339.js";
import {
  ArmIdSchema,
  CellKeySchema,
  ReplicateSchema,
  TaskDigestHexSchema,
  cellKey as computeCellKey,
} from "../run/cells.js";

const Rfc3339 = z.string().refine(isCalendarStrictRfc3339, "must be a calendar-valid RFC 3339 timestamp");

/** A decimal-string quantity (program §7.1/§7.14: fractional numbers are strings). */
const DecimalString = z.string().regex(/^\d+(\.\d+)?$/, "must be a decimal string");

/** The frozen six-value outcome vocabulary (§8.2/§14.1) — never extended without a spec change. */
export const OUTCOME_VOCABULARY = [
  "judged",
  "unjudged",
  "unscorable",
  "expired",
  "invalidated",
  "excluded",
] as const;
export type Outcome = (typeof OUTCOME_VOCABULARY)[number];

const MATCH_STATUSES = ["match", "mismatch", "unverifiable"] as const;
const MatchStatusSchema = z.enum(MATCH_STATUSES);

const VerificationSchema = z.object({
  harness: MatchStatusSchema,
  model: MatchStatusSchema,
  loadout: MatchStatusSchema,
  isolation: MatchStatusSchema,
  checksFailed: z.array(z.string().min(1)),
});

const AgentOrUnresolvedSchema = z.union([AgentIriSchema, z.literal("unresolved")]);

const CostSchema = z.object({
  value: DecimalString,
  unit: z.string(),
  source: z.enum(["reported", "settled"]),
});

const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const MatrixCellSchema = z.object({
  cellKey: CellKeySchema,
  taskDigest: TaskDigestHexSchema,
  armId: ArmIdSchema,
  replicate: ReplicateSchema,
  dispatches: NonnegativeSafeIntegerSchema,
  accounted: PositiveSafeIntegerSchema.optional(),
  submission: Sha256Digest.optional(),
  attempt: AgentIriSchema.optional(),
  delivery: Sha256Digest.optional(),
  verdicts: z.array(Sha256Digest),
  validVerdicts: z.array(Sha256Digest),
  outcome: z.enum(OUTCOME_VOCABULARY),
  verification: VerificationSchema,
  integrityTier: z.enum(["re-derivable", "attested-only"]),
  solver: AgentOrUnresolvedSchema.optional(),
  evaluator: AgentOrUnresolvedSchema.optional(),
  cost: CostSchema.optional(),
  latencyMs: z.number().int().nonnegative().optional(),
});

const AnchorSchema = z.object({
  chain: z.string(),
  blockNumber: z.number().int().nonnegative(),
  blockHash: z.string(),
});

const CloseBoundarySchema = z.object({
  at: Rfc3339,
  anchor: AnchorSchema.optional(),
});

const ExclusionSchema = z.object({
  cellKey: CellKeySchema,
  reason: z.string().min(1).refine((value) => value.trim().length > 0, "reason must not be blank"),
});

const ArmAttritionSchema = z.object({
  expected: z.number().int().nonnegative(),
  judged: z.number().int().nonnegative(),
  unjudged: z.number().int().nonnegative(),
  unscorable: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  invalidated: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  replacements: z.number().int().nonnegative(),
});

export const AttritionSchema = z.object({
  perArm: z.record(ArmIdSchema, ArmAttritionSchema),
  asymmetryFlags: z.array(
    z.string().min(1).refine((value) => value.trim().length > 0, "flag must not be blank"),
  ),
});

export const CompletenessSchema = z.object({
  expected: z.number().int().nonnegative(),
  judged: z.number().int().nonnegative(),
  floor: DecimalString,
  runOutcome: z.enum(["complete", "partial", "cancelled"]),
});

const AssemblySchema = z.object({
  procedure: z.string(),
  version: z.string(),
});

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) =>
    index === 0 || compareCodeUnitStrings(values[index - 1]!, value) < 0
  );
}

function hasPinningMismatch(verification: z.infer<typeof VerificationSchema>): boolean {
  return [
    verification.harness,
    verification.model,
    verification.loadout,
    verification.isolation,
  ].includes("mismatch");
}

type ArmCounts = z.infer<typeof ArmAttritionSchema>;

function emptyArmCounts(): ArmCounts {
  return {
    expected: 0,
    judged: 0,
    unjudged: 0,
    unscorable: 0,
    expired: 0,
    invalidated: 0,
    excluded: 0,
    replacements: 0,
  };
}

const OUTCOME_COUNT_FIELDS = [
  "judged",
  "unjudged",
  "unscorable",
  "expired",
  "invalidated",
  "excluded",
] as const;

export const MatrixRecordSchema = topLevelRecordSchema({
    protocol: z.literal(BENCHMARKING_PROTOCOL),
    run: DigestBearingResourceDescriptorSchema,
    closeBoundary: CloseBoundarySchema,
    cells: z.array(MatrixCellSchema),
    exclusions: z.array(ExclusionSchema),
    attrition: AttritionSchema,
    completeness: CompletenessSchema,
    assembly: AssemblySchema,
  })
  .superRefine((matrix, ctx) => {
    // "cells[] has exactly one entry per expected cell" (§8.1) — the self-contained structural
    // proxy this record alone can check is that the declared `completeness.expected` count
    // matches how many cell entries are actually present; the true expected-cell-set match
    // against the Benchmark x Run cartesian product is `matrix-rederivation`, verified in M4.
    if (matrix.completeness.expected !== matrix.cells.length) {
      ctx.addIssue({
        code: "custom",
        message: `completeness.expected (${matrix.completeness.expected}) does not match cells.length (${matrix.cells.length}) — cells[] must carry exactly one entry per expected cell (§8.1)`,
        path: ["completeness", "expected"],
      });
    }

    const seenCellKeys = new Set<string>();
    const derivedPerArm = new Map<string, ArmCounts>();
    matrix.cells.forEach((cell, index) => {
      if (seenCellKeys.has(cell.cellKey)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate cellKey "${cell.cellKey}" — cells[] entries must be pairwise distinct (§8.1)`,
          path: ["cells", index, "cellKey"],
        });
      } else {
        seenCellKeys.add(cell.cellKey);
      }
      if (index > 0 && compareCodeUnitStrings(matrix.cells[index - 1]!.cellKey, cell.cellKey) >= 0) {
        ctx.addIssue({
          code: "custom",
          message: "cells must be sorted by unique cellKey (UTF-16 code-unit order, §8.3)",
          path: ["cells", index, "cellKey"],
        });
      }

      const coordinateIsValid = TaskDigestHexSchema.safeParse(cell.taskDigest).success
        && ArmIdSchema.safeParse(cell.armId).success
        && ReplicateSchema.safeParse(cell.replicate).success;
      const recomputed = coordinateIsValid
        ? computeCellKey(cell.taskDigest, cell.armId, cell.replicate)
        : undefined;
      if (recomputed !== undefined && recomputed !== cell.cellKey) {
        ctx.addIssue({
          code: "custom",
          message: `cell.cellKey "${cell.cellKey}" is inconsistent with its own taskDigest/armId/replicate fields (expected "${recomputed}", §7.3)`,
          path: ["cells", index, "cellKey"],
        });
      }

      if (!isSortedUnique(cell.verdicts)) {
        ctx.addIssue({
          code: "custom",
          message: "cell.verdicts must be sorted and unique by digest (UTF-16 code-unit order, §8.1)",
          path: ["cells", index, "verdicts"],
        });
      }

      if (!isSortedUnique(cell.validVerdicts)) {
        ctx.addIssue({
          code: "custom",
          message: "cell.validVerdicts must be sorted and unique by digest (UTF-16 code-unit order, §8.1)",
          path: ["cells", index, "validVerdicts"],
        });
      }
      if (!isSortedUnique(cell.verification.checksFailed)) {
        ctx.addIssue({
          code: "custom",
          message: "cell.verification.checksFailed must be sorted and unique (§8.3)",
          path: ["cells", index, "verification", "checksFailed"],
        });
      }

      const verdictSet = new Set(cell.verdicts);
      if (!cell.validVerdicts.every((digest) => verdictSet.has(digest))) {
        ctx.addIssue({
          code: "custom",
          message: "cell.validVerdicts must be a subset of cell.verdicts (§8.1)",
          path: ["cells", index, "validVerdicts"],
        });
      }

      const dispatched = cell.dispatches > 0;
      if (!dispatched) {
        const presentLineage = [
          cell.accounted,
          cell.submission,
          cell.attempt,
          cell.delivery,
          cell.solver,
          cell.evaluator,
          cell.cost,
          cell.latencyMs,
        ].some((value) => value !== undefined);
        if (
          presentLineage
          || cell.verdicts.length > 0
          || cell.validVerdicts.length > 0
          || cell.outcome !== "expired"
        ) {
          ctx.addIssue({
            code: "custom",
            message: "a never-dispatched cell must omit accounted lineage and have outcome expired (§8.2)",
            path: ["cells", index],
          });
        }
      } else {
        if (cell.accounted === undefined) {
          ctx.addIssue({
            code: "custom",
            message: "a dispatched cell must name its accounted dispatch (§8.1)",
            path: ["cells", index, "accounted"],
          });
        } else if (cell.accounted > cell.dispatches) {
          ctx.addIssue({
            code: "custom",
            message: "cell.accounted must not exceed cell.dispatches (§8.1)",
            path: ["cells", index, "accounted"],
          });
        }
        if (cell.submission === undefined) {
          ctx.addIssue({
            code: "custom",
            message: "a dispatched cell must reference the accounted Submission (§8.1)",
            path: ["cells", index, "submission"],
          });
        }
      }

      if ((cell.verdicts.length > 0 || cell.validVerdicts.length > 0) && cell.delivery === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "verdict references require an accounted Delivery (§8.1)",
          path: ["cells", index, "verdicts"],
        });
      }

      const mismatch = hasPinningMismatch(cell.verification);
      const excluded = cell.outcome === "excluded";
      if (cell.outcome === "judged" && (cell.delivery === undefined || cell.validVerdicts.length === 0 || mismatch)) {
        ctx.addIssue({
          code: "custom",
          message: "judged requires a Delivery, at least one valid verdict, and no pinning mismatch (§8.2)",
          path: ["cells", index, "outcome"],
        });
      }
      if (
        (cell.outcome === "unjudged" || cell.outcome === "unscorable")
        && (cell.delivery === undefined || cell.validVerdicts.length > 0 || mismatch)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `${cell.outcome} requires a Delivery, no valid verdict, and no pinning mismatch (§8.2)`,
          path: ["cells", index, "outcome"],
        });
      }
      if (
        cell.outcome === "expired"
        && (cell.delivery !== undefined || cell.verdicts.length > 0 || cell.validVerdicts.length > 0 || mismatch)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "expired must have no Delivery, verdicts, valid verdicts, or pinning mismatch (§8.2)",
          path: ["cells", index, "outcome"],
        });
      }
      if (cell.outcome === "invalidated" && (cell.delivery === undefined || !mismatch)) {
        ctx.addIssue({
          code: "custom",
          message: "invalidated requires delivered work with at least one pinning mismatch (§8.2)",
          path: ["cells", index, "outcome"],
        });
      }
      if (mismatch && cell.outcome !== "invalidated" && !excluded) {
        ctx.addIssue({
          code: "custom",
          message: "a non-excluded cell with a pinning mismatch must be invalidated (§8.2)",
          path: ["cells", index, "outcome"],
        });
      }
      if (cell.validVerdicts.length > 0 && !mismatch && !excluded && cell.outcome !== "judged") {
        ctx.addIssue({
          code: "custom",
          message: "a non-excluded, pinning-matched cell with valid verdicts must be judged (§8.2)",
          path: ["cells", index, "outcome"],
        });
      }

      const armCounts = derivedPerArm.get(cell.armId) ?? emptyArmCounts();
      armCounts.expected += 1;
      armCounts[cell.outcome] += 1;
      armCounts.replacements += Math.max(0, cell.dispatches - 1);
      derivedPerArm.set(cell.armId, armCounts);
    });

    const excludedKeys = matrix.cells
      .filter((cell) => cell.outcome === "excluded")
      .map((cell) => cell.cellKey);
    const exclusionKeys = matrix.exclusions.map((entry) => entry.cellKey);
    if (!isSortedUnique(exclusionKeys)) {
      ctx.addIssue({
        code: "custom",
        message: "exclusions must be sorted and unique by cellKey (§8.3)",
        path: ["exclusions"],
      });
    }
    if (!arraysEqual(excludedKeys, exclusionKeys)) {
      ctx.addIssue({
        code: "custom",
        message: "exclusions must contain exactly one entry for every excluded cell (§8.1)",
        path: ["exclusions"],
      });
    }

    const derivedArmIds = [...derivedPerArm.keys()].sort(compareCodeUnitStrings);
    const declaredArmIds = Object.keys(matrix.attrition.perArm).sort(compareCodeUnitStrings);
    if (!arraysEqual(derivedArmIds, declaredArmIds)) {
      ctx.addIssue({
        code: "custom",
        message: "attrition.perArm keys must exactly match the cell armIds (§8.1)",
        path: ["attrition", "perArm"],
      });
    }
    for (const armId of derivedArmIds) {
      const derived = derivedPerArm.get(armId)!;
      const declared = matrix.attrition.perArm[armId];
      if (declared === undefined) continue;
      for (const field of ["expected", ...OUTCOME_COUNT_FIELDS, "replacements"] as const) {
        if (declared[field] !== derived[field]) {
          ctx.addIssue({
            code: "custom",
            message: `attrition.perArm.${armId}.${field} must equal the value derived from cells`,
            path: ["attrition", "perArm", armId, field],
          });
        }
      }
    }
    const judged = matrix.cells.filter((cell) => cell.outcome === "judged").length;
    if (matrix.completeness.judged !== judged) {
      ctx.addIssue({
        code: "custom",
        message: "completeness.judged must equal the judged-cell count (§8.1)",
        path: ["completeness", "judged"],
      });
    }
    const floor = Number(matrix.completeness.floor);
    if (!(floor > 0 && floor <= 1)) {
      ctx.addIssue({
        code: "custom",
        message: "completeness.floor must be in (0,1] (§8.1)",
        path: ["completeness", "floor"],
      });
    } else {
      const denominator = matrix.cells.length - excludedKeys.length;
      const floorPassed = (denominator === 0 ? 1 : judged / denominator) >= floor;
      if (matrix.completeness.runOutcome === "complete" && !floorPassed) {
        ctx.addIssue({
          code: "custom",
          message: "runOutcome complete requires the declared completeness floor to pass (§8.1)",
          path: ["completeness", "runOutcome"],
        });
      }
      if (matrix.completeness.runOutcome === "partial" && floorPassed) {
        ctx.addIssue({
          code: "custom",
          message: "runOutcome partial requires the declared completeness floor to be missed (§8.1)",
          path: ["completeness", "runOutcome"],
        });
      }
    }

    if (!isSortedUnique(matrix.attrition.asymmetryFlags)) {
      ctx.addIssue({
        code: "custom",
        message: "attrition.asymmetryFlags must be sorted and unique (§8.3)",
        path: ["attrition", "asymmetryFlags"],
      });
    }
    const attritionVectors = [...derivedPerArm.values()].map((counts) =>
      [
        counts.unjudged,
        counts.unscorable,
        counts.expired,
        counts.invalidated,
        counts.excluded,
        counts.replacements,
      ].join("/")
    );
    const structurallySymmetric = new Set(attritionVectors).size <= 1;
    if (
      matrix.attrition.asymmetryFlags.length > 0
      && (derivedPerArm.size < 2 || structurallySymmetric)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "asymmetry flags require at least two arms with structurally asymmetric attrition (§8.1)",
        path: ["attrition", "asymmetryFlags"],
      });
    }
  });

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type MatrixRecord = z.infer<typeof MatrixRecordSchema>;
export type MatrixCell = MatrixRecord["cells"][number];

/** Parse and validate raw sealed bytes into a `MatrixRecord`; throws `InvalidDocumentError`. */
export function parseMatrix(bytes: Uint8Array): MatrixRecord {
  return parseExactWithSchema(MatrixRecordSchema, bytes);
}

/** Validate → seal a Matrix record document (§8.1). */
export function sealMatrix(document: unknown): SealedRecord {
  return sealWithSchema(MatrixRecordSchema, document);
}
