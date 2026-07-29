import { z } from "zod";
import { itemTaskDigest, type BenchmarkRecord } from "../benchmark/schema.js";
import { LowercaseSha256HexSchema } from "../descriptors.js";
import { compareCodeUnitStrings } from "../order.js";
import type { RunRecord } from "./schema.js";

export interface CellCoord {
  cellKey: string;
  taskDigest: string;
  armId: string;
  replicate: number;
}

/** Hard bound for the array-returning helper; exact counts remain available above this limit. */
export const MAX_MATERIALIZED_CELLS = 1_000_000;

export const TaskDigestHexSchema = LowercaseSha256HexSchema;
const RunDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "runDigest must be sha256:<64 lowercase hex>");

export const ArmIdSchema = z.string().regex(
  /^[A-Za-z0-9_-]{1,64}$/,
  "armId must match [A-Za-z0-9_-]{1,64} (§7.1)",
);

export const ReplicateSchema = z.number().int().positive().max(
  Number.MAX_SAFE_INTEGER,
  "replicate must be a safe integer",
);

const REPLICATE_RE = /^[1-9][0-9]*$/;

export const CellKeySchema = z.string().superRefine((key, ctx) => {
  try {
    parseCellKey(key);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "malformed cellKey",
    });
  }
});

/**
 * `cellKey` grammar (§7.3, frozen interface #2): `"<taskDigest>/<armId>/<replicate>"` —
 * `taskDigest` in the stack's canonical lowercase-hex form, `armId` as declared (its grammar
 * excludes `/`), `replicate` 1-based minimal decimal (no padding).
 */
export function cellKey(taskDigestHex: string, armId: string, replicate: number): string {
  const taskDigest = TaskDigestHexSchema.parse(taskDigestHex);
  const exactArmId = ArmIdSchema.parse(armId);
  const exactReplicate = ReplicateSchema.parse(replicate);
  return `${taskDigest}/${exactArmId}/${exactReplicate}`;
}

/** Inverse of `cellKey`: recovers the coordinate from a well-formed key. */
export function parseCellKey(key: string): CellCoord {
  const parts = key.split("/");
  if (parts.length !== 3) throw new Error(`malformed cellKey (expected 3 "/"-delimited parts): ${key}`);
  const [taskDigest, armId, replicateText] = parts;
  if (!TaskDigestHexSchema.safeParse(taskDigest).success) {
    throw new Error(`malformed cellKey task digest (must be 64 lowercase hex digits): ${key}`);
  }
  if (!ArmIdSchema.safeParse(armId).success) {
    throw new Error(`malformed cellKey armId (must match [A-Za-z0-9_-]{1,64}): ${key}`);
  }
  if (!REPLICATE_RE.test(replicateText)) {
    throw new Error(`malformed cellKey replicate (must be 1-based minimal decimal): ${key}`);
  }
  const replicate = Number(replicateText);
  if (!ReplicateSchema.safeParse(replicate).success) {
    throw new Error(`malformed cellKey replicate (must be a positive safe integer): ${key}`);
  }
  return { cellKey: key, taskDigest, armId, replicate };
}

/**
 * The expected cell set (§7.3): the full cartesian product `items × arms × replicates`, ordered
 * lexicographically by `cellKey` (UTF-16 code-unit order, §8.3).
 */
export function expectedCellSet(bench: BenchmarkRecord, run: RunRecord): CellCoord[] {
  const count = expectedCellCount(bench, run);
  if (count > MAX_MATERIALIZED_CELLS) {
    throw new RangeError(
      `expected cell set exceeds MAX_MATERIALIZED_CELLS (${MAX_MATERIALIZED_CELLS}): ${count}`,
    );
  }
  const coords: CellCoord[] = [];
  for (const item of bench.items) {
    const taskDigest = itemTaskDigest(item);
    for (const arm of run.arms) {
      for (let replicate = 1; replicate <= run.replicates; replicate += 1) {
        coords.push({ cellKey: cellKey(taskDigest, arm.armId, replicate), taskDigest, armId: arm.armId, replicate });
      }
    }
  }
  return coords.sort((a, b) => compareCodeUnitStrings(a.cellKey, b.cellKey));
}

/** `|items| × |arms| × replicates` (§7.3), without materializing the full set. */
export function expectedCellCount(bench: BenchmarkRecord, run: RunRecord): number {
  const cardinality = BigInt(bench.items.length) * BigInt(run.arms.length) * BigInt(run.replicates);
  if (cardinality > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`expected cell cardinality exceeds Number.MAX_SAFE_INTEGER: ${cardinality}`);
  }
  return Number(cardinality);
}

/**
 * The `submission.annotations` fields a cell dispatch MUST carry — Addendum 2026-07-28-b
 * (mandatory, operator ruling at the extension gate): exactly `run`, `cellKey`, `armId`. The
 * `facts/task-execution` discovery leaf's recompute reads precisely these three keys from
 * `submission.annotations` (TEP's correlation-annotation doc-comment, TEP §6.4/§8). `replicate`
 * is deliberately NOT an annotation key — it is recoverable by parsing `cellKey`
 * (`parseCellKey`) — and `dispatch` is deliberately NOT an annotation key either — it is folded
 * into the Submission's own `idempotencyKey` via `cellIdempotencyKey` below, never duplicated
 * into `annotations`.
 */
export interface CellDispatchAnnotations {
  run: string;
  cellKey: string;
  armId: string;
}

export function submissionExtensionBlock(
  runDigest: string,
  cell: string,
  armId: string,
): CellDispatchAnnotations {
  const exactRunDigest = RunDigestSchema.parse(runDigest);
  const coordinate = parseCellKey(cell);
  const exactArmId = ArmIdSchema.parse(armId);
  if (coordinate.armId !== exactArmId) {
    throw new Error("annotation armId must exactly match the cellKey armId (§7.3)");
  }
  return { run: exactRunDigest, cellKey: coordinate.cellKey, armId: exactArmId };
}

// Frozen name-construction delimiter (mirrors TEP identifiers.ts's `deriveAttemptUri` precedent):
// the ASCII unit separator (U+001F), a control char that cannot appear in a run digest, a
// cellKey, or a non-negative integer, so the three parts never concatenate ambiguously. Written
// as an escape, never a literal control byte (Global Constraints: no raw control bytes).
const IDEMPOTENCY_KEY_UNIT_SEPARATOR = "\u001f";

/**
 * Idempotency key derived from `(runDigest, cellKey, dispatch)` (§7.3): crash-safe resumption
 * never re-posts a cell, and a *replacement* is visibly a new dispatch of the same cell, never a
 * silent retry. `dispatch` is 1-based (the first dispatch of a cell is dispatch 1), matching the
 * stack's 1-based `replicate` convention.
 */
export function cellIdempotencyKey(runDigest: string, cell: string, dispatch: number): string {
  const exactRunDigest = RunDigestSchema.parse(runDigest);
  const exactCell = parseCellKey(cell).cellKey;
  if (!Number.isSafeInteger(dispatch) || dispatch < 1) {
    throw new Error("dispatch must be a 1-based positive integer (§7.3)");
  }
  return [exactRunDigest, exactCell, String(dispatch)].join(IDEMPOTENCY_KEY_UNIT_SEPARATOR);
}
