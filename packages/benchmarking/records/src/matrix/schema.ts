import { z } from "zod";
import { Sha256Digest } from "@jinn-network/task-execution-protocol";
import { DigestBearingResourceDescriptorSchema } from "../descriptors.js";
import { BENCHMARKING_PROTOCOL } from "../identifiers.js";
import { assertIJsonStrings } from "../json.js";
import { compareCodeUnitStrings } from "../order.js";
import { InvalidDocumentError, sealWithSchema, type SealedRecord } from "../sealing.js";
import { cellKey as computeCellKey } from "../run/cells.js";

const Rfc3339 = z.string().datetime({ offset: true });

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
  checksFailed: z.array(z.string()),
});

const AgentOrUnresolvedSchema = z.union([z.string(), z.literal("unresolved")]);

const CostSchema = z.object({
  value: DecimalString,
  unit: z.string(),
  source: z.enum(["reported", "settled"]),
});

const TaskDigestHex = z.string().regex(/^[0-9a-f]{64}$/, "taskDigest must be canonical lowercase hex (§7.3)");

const MatrixCellSchema = z.object({
  cellKey: z.string(),
  taskDigest: TaskDigestHex,
  armId: z.string(),
  replicate: z.number().int().positive(),
  dispatches: z.number().int().nonnegative(),
  accounted: z.number().int().nonnegative().optional(),
  submission: Sha256Digest.optional(),
  attempt: z.string().optional(),
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
  cellKey: z.string(),
  reason: z.string(),
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
  perArm: z.record(z.string(), ArmAttritionSchema),
  asymmetryFlags: z.array(z.string()),
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

// The Matrix's only namespaced-extension escape hatch (tenet 3: no aggregate of any kind at
// this record kind). Any top-level key beyond the enumerated set MUST look like a namespaced
// extension (TEP §21.3 style: `<namespace>/<rest>`), never a bare English word — a bare extra
// key ("winner", "bestArm") is exactly the shape an aggregate smuggled in as an "extension"
// would take, and this schema rejects it outright.
const KNOWN_MATRIX_FIELDS = new Set([
  "protocol",
  "run",
  "closeBoundary",
  "cells",
  "exclusions",
  "attrition",
  "completeness",
  "assembly",
]);
const NAMESPACED_EXTENSION_KEY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\/[A-Za-z]/;

export const MatrixRecordSchema = z
  .object({
    protocol: z.literal(BENCHMARKING_PROTOCOL),
    run: DigestBearingResourceDescriptorSchema,
    closeBoundary: CloseBoundarySchema,
    cells: z.array(MatrixCellSchema),
    exclusions: z.array(ExclusionSchema),
    attrition: AttritionSchema,
    completeness: CompletenessSchema,
    assembly: AssemblySchema,
  })
  .loose() // open to namespaced extensions (TEP §21.3) — but see the tenet-3 refine below
  .superRefine((matrix, ctx) => {
    // Tenet 3: no aggregate of any kind. Any top-level key beyond the enumerated set must be a
    // namespaced extension.
    for (const key of Object.keys(matrix)) {
      if (KNOWN_MATRIX_FIELDS.has(key)) continue;
      if (!NAMESPACED_EXTENSION_KEY.test(key)) {
        ctx.addIssue({
          code: "custom",
          message: `unnamespaced top-level field "${key}" is forbidden — the Matrix carries no aggregate of any kind (tenet 3); extensions must be namespaced (TEP §21.3)`,
          path: [key],
        });
      }
    }

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

      const recomputed = computeCellKey(cell.taskDigest, cell.armId, cell.replicate);
      if (recomputed !== cell.cellKey) {
        ctx.addIssue({
          code: "custom",
          message: `cell.cellKey "${cell.cellKey}" is inconsistent with its own taskDigest/armId/replicate fields (expected "${recomputed}", §7.3)`,
          path: ["cells", index, "cellKey"],
        });
      }

      const sortedVerdicts = [...cell.verdicts].sort(compareCodeUnitStrings);
      if (!arraysEqual(sortedVerdicts, cell.verdicts)) {
        ctx.addIssue({
          code: "custom",
          message: "cell.verdicts must be sorted by digest (UTF-16 code-unit order, §8.1)",
          path: ["cells", index, "verdicts"],
        });
      }

      const sortedValidVerdicts = [...cell.validVerdicts].sort(compareCodeUnitStrings);
      if (!arraysEqual(sortedValidVerdicts, cell.validVerdicts)) {
        ctx.addIssue({
          code: "custom",
          message: "cell.validVerdicts must be sorted by digest (UTF-16 code-unit order, §8.1)",
          path: ["cells", index, "validVerdicts"],
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
    });
  });

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type MatrixRecord = z.infer<typeof MatrixRecordSchema>;
export type MatrixCell = MatrixRecord["cells"][number];

/** Parse and validate raw sealed bytes into a `MatrixRecord`; throws `InvalidDocumentError`. */
export function parseMatrix(bytes: Uint8Array): MatrixRecord {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InvalidDocumentError([{ path: "", message: "not valid JSON" }]);
  }
  assertIJsonStrings(json);
  const parsed = MatrixRecordSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidDocumentError(
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return parsed.data;
}

/** Validate → seal a Matrix record document (§8.1). */
export function sealMatrix(document: unknown): SealedRecord {
  return sealWithSchema(MatrixRecordSchema, document);
}
