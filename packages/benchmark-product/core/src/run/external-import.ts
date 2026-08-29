// SPDX-License-Identifier: Apache-2.0

/**
 * Validates an external harness's run dump against the sealed slate (#2979).
 *
 * The rule this module exists to enforce: **every expected slot appears exactly once, and there is
 * no exclude flag.** A run's denominator is fixed at seal time by `expectedCellSet(benchmark, run)`.
 * An import that let the operator drop the slots their harness could not produce would let them
 * publish a number computed over a slate they chose after seeing the results — the exact move the
 * sealed slate exists to prevent. A slot the harness could not supply is imported with outcome
 * `error`, `timeout`, or `unrun` and a non-blank reason, and it counts.
 *
 * The refusal follows the shape `admitDeclaredCells` set in
 * `../method/skillsbench-demo1-declaration.ts`: collect EVERY problem in one pass and report them
 * all at once. First-failure reporting is worse than useless here — it turns a broken dump into a
 * repair-and-retry loop where each round shows one more problem and the operator never sees the
 * shape of what went wrong.
 *
 * This module is validation only. Journal and record synthesis from an accepted plan is a separate
 * concern and lives elsewhere; on refusal nothing at all is written.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, relative as relativePath, resolve as resolvePath, sep } from "node:path";
import { z } from "zod";
import {
  cellIdempotencyKey,
  expectedCellSet,
  isCalendarStrictRfc3339,
  parseCellKey,
  type BenchmarkRecord,
  type CellCoord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { sealDelivery, sealSubmission } from "@jinn-network/task-execution-protocol";
import {
  DECIMAL_STRING_PATTERN,
  deriveEvaluationTask,
  evaluateVerdictRule,
  parseEvaluationSpec,
  type EvaluationSpec,
  type MeasurementDeclaration,
  type MeasurementMap,
  type VerdictOutcome,
} from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { BenchmarkProductError, refuse, type ProductIssue } from "../errors.js";
import {
  EXTERNAL_RUN_IMPORT_OUTCOMES,
  type ExternalRunImportOutcome,
  type ExternalRunRecord,
} from "../intake/external-run-records.js";
import { EVALUATOR_REQUIREMENT_KEY } from "../venue/provisioner.js";
import {
  createVerdictDsseSigner,
  loadOrCreateEvaluatorSigningKeys,
  sealVerdictStatement,
} from "../venue/signing.js";
import { EVALUATION_HARNESS_PIN } from "../venue/venue.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { appendRunJournalEntry } from "./journal.js";
import { recordWorkspaceAuthorship } from "./publication-authority.js";
import { deterministicUuidUri } from "./state.js";

export interface ValidateExternalRunRecordsInput {
  /** The normalized rows, in dump order, from `readExternalRunRecords`. */
  readonly records: readonly ExternalRunRecord[];
  /** The sealed benchmark; with `run` it fixes the slate via `expectedCellSet`. */
  readonly benchmark: BenchmarkRecord;
  readonly run: RunRecord;
  /** The sealed coordinates, `sha256:`-prefixed, quoted verbatim in the refusal. */
  readonly benchmarkSha256: string;
  readonly runSha256: string;
}

/** One accepted slot: the expected coordinate joined to the row that supplied it. */
export interface ExternalRunImportCell {
  readonly cellKey: string;
  readonly coord: CellCoord;
  readonly outcome: ExternalRunImportOutcome;
  readonly record: ExternalRunRecord;
}

/** What an accepted dump becomes: every expected slot, once, in expected-cell order. */
export interface ExternalRunImportPlan {
  readonly cells: readonly ExternalRunImportCell[];
  readonly byCellKey: ReadonlyMap<string, ExternalRunImportCell>;
  readonly expectedSlotCount: number;
  readonly rowCount: number;
  readonly benchmarkSha256: string;
  readonly runSha256: string;
}

/** The problem taxonomy, carried on `issues[].path` so callers branch on codes, never on prose. */
export const EXTERNAL_RUN_IMPORT_PROBLEMS = [
  "unparseable-slot",
  "unknown-slot",
  "duplicate-slot",
  "missing-slot",
  "unknown-outcome",
  "missing-reason",
  "forbidden-reason",
  "missing-evidence",
  "forbidden-evidence",
  "missing-measurements",
  "forbidden-measurements",
  "inconsistent-timing",
] as const;

export type ExternalRunImportProblemCode = (typeof EXTERNAL_RUN_IMPORT_PROBLEMS)[number];

/** The closing three lines are load-bearing: they name the ONLY sanctioned way to not have a
 * result for a slot, so an operator reading the refusal cannot conclude that dropping it is one. */
const REMEDY =
  "Every expected slot must appear exactly once. There is no exclude flag.\n" +
  'A slot you cannot supply is recorded with outcome "error", "timeout", or "unrun"\n' +
  "and a non-blank reason; it is counted in the denominator exactly like every other slot.";

/** Slot-level labels are padded to a common width so the keys line up under each other. */
const LABEL_WIDTH = 15;

const OUTCOME_LIST = EXTERNAL_RUN_IMPORT_OUTCOMES.join(", ");

function isOutcome(value: string): value is ExternalRunImportOutcome {
  return (EXTERNAL_RUN_IMPORT_OUTCOMES as readonly string[]).includes(value);
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Validates the dump against the slate, reporting every problem at once.
 *
 * Returns a plan on success; throws `BenchmarkProductError` (code `validation`, one issue per
 * problem) otherwise. It writes nothing either way.
 */
export function validateExternalRunRecords(
  input: ValidateExternalRunRecordsInput,
): ExternalRunImportPlan {
  const { records, benchmark, run, benchmarkSha256, runSha256 } = input;
  const expected = expectedCellSet(benchmark, run);
  const expectedByKey = new Map(expected.map((coord) => [coord.cellKey, coord]));

  const slotProblems: ProductIssue[] = [];
  const rowProblems: ProductIssue[] = [];
  /** First row to name each expected slot; a later row naming it again is the duplicate. */
  const claimedBy = new Map<string, ExternalRunRecord>();

  for (const record of records) {
    const at = `row ${record.row}`;

    // --- slot ---------------------------------------------------------------------------------
    let wellFormed = true;
    try {
      parseCellKey(record.cellKey);
    } catch (error) {
      wellFormed = false;
      rowProblems.push({
        path: "unparseable-slot",
        message: `${at}: cellKey "${record.cellKey}" is malformed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    if (wellFormed) {
      if (!expectedByKey.has(record.cellKey)) {
        slotProblems.push({
          path: "unknown-slot",
          message: `${"unknown slot".padEnd(LABEL_WIDTH)}${record.cellKey} (not in the sealed slate)`,
        });
      } else {
        const first = claimedBy.get(record.cellKey);
        if (first === undefined) {
          claimedBy.set(record.cellKey, record);
        } else {
          slotProblems.push({
            path: "duplicate-slot",
            message: `${"duplicate slot".padEnd(LABEL_WIDTH)}${record.cellKey} (rows ${first.row} and ${record.row})`,
          });
        }
      }
    }

    // --- shape --------------------------------------------------------------------------------
    // Checked for EVERY row, including rows whose slot is unknown or malformed: an operator fixing
    // a dump wants the whole list, not the subset that happened to land on a real slot.
    if (!isOutcome(record.outcome)) {
      rowProblems.push({
        path: "unknown-outcome",
        message: `${at}: outcome "${record.outcome}" is not one of ${OUTCOME_LIST}`,
      });
    } else {
      const graded = record.outcome === "graded";
      const carriesEvidence = record.outcome === "graded" || record.outcome === "ungradeable";

      if (graded) {
        if (record.reason !== undefined) {
          rowProblems.push({
            path: "forbidden-reason",
            message: `${at}: outcome "graded" must not carry a reason`,
          });
        }
      } else if (isBlank(record.reason)) {
        rowProblems.push({
          path: "missing-reason",
          message: `${at}: outcome "${record.outcome}" requires a non-blank reason`,
        });
      }

      if (carriesEvidence && record.evidence === undefined) {
        rowProblems.push({
          path: "missing-evidence",
          message: `${at}: outcome "${record.outcome}" requires evidence`,
        });
      }
      if (!carriesEvidence && record.evidence !== undefined) {
        rowProblems.push({
          path: "forbidden-evidence",
          message: `${at}: outcome "${record.outcome}" must not carry evidence`,
        });
      }

      if (graded && record.measurements === undefined) {
        rowProblems.push({
          path: "missing-measurements",
          message: `${at}: outcome "graded" requires measurements`,
        });
      }
      if (!graded && record.measurements !== undefined) {
        rowProblems.push({
          path: "forbidden-measurements",
          message: `${at}: outcome "${record.outcome}" must not carry measurements`,
        });
      }
    }

    rowProblems.push(...timingProblems(record, at));
  }

  for (const coord of expected) {
    if (!claimedBy.has(coord.cellKey)) {
      slotProblems.push({
        path: "missing-slot",
        message: `${"missing slot".padEnd(LABEL_WIDTH)}${coord.cellKey}`,
      });
    }
  }

  // Slot-level problems lead (they describe the slate), grouped missing → unknown → duplicate so a
  // reader sees the denominator damage first; row-level problems follow in row order.
  const slotRank: Record<string, number> = { "missing-slot": 0, "unknown-slot": 1, "duplicate-slot": 2 };
  const problems = [
    ...[...slotProblems].sort((left, right) => (slotRank[left.path] ?? 3) - (slotRank[right.path] ?? 3)),
    ...rowProblems,
  ];
  if (problems.length > 0) {
    throw new BenchmarkProductError(
      "validation",
      [
        `external run import refused: ${problems.length} problems against the sealed slate`,
        `(benchmark ${benchmarkSha256}, run ${runSha256}, ${expected.length} expected slots,` +
          ` ${records.length} rows read).`,
        "",
        ...problems.map((problem) => `  ${problem.message}`),
        "",
        REMEDY,
      ].join("\n"),
      problems,
    );
  }

  const cells = expected.map((coord): ExternalRunImportCell => {
    const record = claimedBy.get(coord.cellKey)!;
    return { cellKey: coord.cellKey, coord, outcome: record.outcome as ExternalRunImportOutcome, record };
  });

  return {
    cells,
    byCellKey: new Map(cells.map((cell) => [cell.cellKey, cell])),
    expectedSlotCount: expected.length,
    rowCount: records.length,
    benchmarkSha256,
    runSha256,
  };
}

/**
 * Timing consistency. `startedAt`/`endedAt` are both-or-neither, must be calendar-strict RFC 3339,
 * must not run backwards, and when `durationMs` is also given it must equal the interval — a
 * duration that disagrees with its own timestamps means one of the two is fabricated, and we
 * cannot tell which.
 */
function timingProblems(record: ExternalRunRecord, at: string): ProductIssue[] {
  const problems: ProductIssue[] = [];
  const { startedAt, endedAt, durationMs } = record;

  if ((startedAt === undefined) !== (endedAt === undefined)) {
    problems.push({
      path: "inconsistent-timing",
      message: `${at}: startedAt and endedAt must be given together`,
    });
    return problems;
  }
  if (startedAt === undefined || endedAt === undefined) return problems;

  for (const [field, value] of [["startedAt", startedAt], ["endedAt", endedAt]] as const) {
    if (!isCalendarStrictRfc3339(value)) {
      problems.push({
        path: "inconsistent-timing",
        message: `${at}: ${field} "${value}" is not a calendar-valid RFC 3339 timestamp`,
      });
    }
  }
  if (problems.length > 0) return problems;

  const interval = Date.parse(endedAt) - Date.parse(startedAt);
  if (interval < 0) {
    problems.push({
      path: "inconsistent-timing",
      message: `${at}: endedAt precedes startedAt`,
    });
    return problems;
  }
  if (durationMs !== undefined && durationMs !== interval) {
    problems.push({
      path: "inconsistent-timing",
      message: `${at}: durationMs ${durationMs} disagrees with endedAt - startedAt (${interval})`,
    });
  }
  return problems;
}

// ── preflight: every fallible resolution, performed BEFORE anything is written ───────────────
//
// The synthesis below is a WRITE path: it transitions the draft `locked -> running`, stamps
// `launchedAt`, and appends journal entries cell by cell. `operateAsync` has no rollback, so a
// refusal raised part-way through leaves a draft nothing can rescue — re-import is refused twice
// over (the state is no longer `locked`, and the journal is no longer empty), there is no
// `running -> locked` edge, and `runCollect` refuses on the outstanding cells. One typo in an
// evidence path on row 40 of 200 would kill the run permanently.
//
// So every resolution that CAN fail happens here, up front, over the whole plan: the subject
// EvaluationSpec for each graded row, the typing of its measurements, the verdict rule over them,
// every evidence file (resolved, contained, and read), and the arm behind every dispatched cell.
// The writer then CONSUMES what this produced rather than re-resolving it — which is also what
// keeps the two from drifting apart, since a second resolution is a second chance to disagree.
// What remains in the write path is genuine I/O: a full disk, a revoked permission.

/** One evidence file, resolved and read but not yet sealed — sealing is a write. */
export interface PreparedEvidence {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Everything a `graded` cell needs, resolved once: the rule it is judged by, the measurements
 * typed against that rule's own declarations, and the verdict those two produce. */
export interface PreparedGrading {
  readonly evaluationSpecSha256: string;
  readonly measurements: MeasurementMap;
  readonly outcome: VerdictOutcome;
}

/** One planned cell with every fallible resolution already performed. */
export interface PreparedImportCell {
  readonly cell: ExternalRunImportCell;
  /** Absent only for `unrun`, the one outcome that journals no dispatch. */
  readonly arm?: RunRecord["arms"][number];
  /** Empty for every outcome that carries no evidence. */
  readonly evidence: readonly PreparedEvidence[];
  /** Present exactly for `graded`. */
  readonly grading?: PreparedGrading;
}

/** The resolved plan, in expected-cell order — one entry per `plan.cells` entry. */
export interface ExternalRunImportPreflight {
  readonly cells: readonly PreparedImportCell[];
}

export interface PreflightExternalRunImportInput {
  readonly workspaceDir: string;
  readonly plan: ExternalRunImportPlan;
  readonly runRecord: RunRecord;
  /** Directory a relative `evidence[].path` resolves against, and may not escape. */
  readonly evidenceRoot: string;
}

/** Resolves everything the write path would otherwise resolve mid-write. Writes nothing. */
export function preflightExternalRunImport(
  input: PreflightExternalRunImportInput,
): ExternalRunImportPreflight {
  const { workspaceDir, plan, runRecord, evidenceRoot } = input;
  const cells = plan.cells.map((cell): PreparedImportCell => {
    const { coord, cellKey, outcome } = cell;
    // `unrun` claims no attempt at all, so it needs neither an arm nor evidence.
    if (outcome === "unrun") return { cell, evidence: [] };

    const arm = runRecord.arms.find((candidate) => candidate.armId === coord.armId);
    if (arm === undefined) {
      refuse("record-integrity", `cells.${cellKey}`, `sealed Run has no arm "${coord.armId}"`);
    }
    if (outcome === "error" || outcome === "timeout") return { cell, arm, evidence: [] };

    const evidence = readImportedEvidence(evidenceRoot, cell);
    if (outcome === "ungradeable") return { cell, arm, evidence };
    return { cell, arm, evidence, grading: prepareGrading(workspaceDir, cell) };
  });
  return { cells };
}

/**
 * Reads one cell's evidence files, IN DUMP ORDER, refusing any path that leaves the dump
 * directory.
 *
 * Containment is not hygiene here, it is the publishing boundary: whatever these paths name is
 * sealed into the workspace CAS and travels inside the published bundle. Without the check,
 * `../../../.ssh/id_rsa` or `/etc/passwd` in a dump would be published as an external harness's
 * "evidence". The check is LEXICAL (resolve, then require the result to stay under the resolved
 * root) — it deliberately does not resolve symlinks, because the dump directory is the operator's
 * own tree and a symlink inside it is a path they chose, not one the record smuggled in.
 */
function readImportedEvidence(
  evidenceRoot: string,
  cell: ExternalRunImportCell,
): PreparedEvidence[] {
  const root = resolvePath(evidenceRoot);
  const at = `row ${cell.record.row}`;
  return (cell.record.evidence ?? []).map((ref) => {
    if (isAbsolute(ref.path)) {
      refuse(
        "validation",
        at,
        `${at}: evidence "${ref.name}" for ${cell.cellKey} has the absolute path "${ref.path}" — `
          + "evidence paths are relative to the dump file's own directory and may not leave it",
      );
    }
    const path = resolvePath(root, ref.path);
    const inside = relativePath(root, path);
    if (inside.length === 0 || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      refuse(
        "validation",
        at,
        `${at}: evidence "${ref.name}" for ${cell.cellKey} resolves outside the dump directory `
          + `("${ref.path}") — evidence paths may not leave the directory the dump file lives in`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch (cause) {
      refuse(
        "validation",
        at,
        `evidence "${ref.name}" for ${cell.cellKey} could not be read at ${path}: `
          + `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return { name: ref.name, bytes };
  });
}

/** Resolves a `graded` cell's rule, types its measurements against that rule's own declarations,
 * and computes the verdict — the one place a verdict can come from. */
function prepareGrading(workspaceDir: string, cell: ExternalRunImportCell): PreparedGrading {
  const evaluationSpecSha256 = subjectEvaluationSpecSha256(
    workspaceDir,
    cell.coord.taskDigest,
    cell.cellKey,
  );
  const spec = parseEvaluationSpec(getSealedBytes(workspaceDir, evaluationSpecSha256));
  const measurements = typeImportedMeasurements(spec, cell);
  // The verdict is COMPUTED, never imported. There is no pass/fail column in the dump precisely so
  // that this line is the only place a verdict can come from; `checkVerdictRuleConsistency`
  // recomputes it at assembly from the same spec and the same measurements.
  try {
    return {
      evaluationSpecSha256,
      measurements,
      outcome: evaluateVerdictRule(
        spec.verdictRule as Parameters<typeof evaluateVerdictRule>[0],
        measurements,
      ),
    };
  } catch (cause) {
    refuse(
      "validation",
      `row ${cell.record.row}`,
      `${cell.cellKey}: the sealed EvaluationSpec's verdict rule could not be evaluated over the `
        + `imported measurements — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Types one graded row's measurements against the sealed EvaluationSpec's own declarations.
 *
 * This is what makes the two dialects genuinely one record. CSV carries no type information, so
 * every CSV measurement arrives as a string; `compare()` in the profiles package is decimal-aware
 * for numeric operands but falls back to strict `===` otherwise, so an untyped `"true"` compared
 * against a declared `true` is FALSE. A CSV dump would therefore seal the opposite verdict from
 * the identical JSONL dump — and every downstream guard, re-deriving from the same untyped map,
 * would agree with it. Typing here, before the rule ever runs, is the only place that can be
 * fixed once for both dialects and for every consumer of the map.
 *
 * A name the spec does not declare is refused rather than passed through: the rule can only read
 * declared names, so an undeclared one is either a typo or a column with nowhere to land.
 */
function typeImportedMeasurements(
  spec: EvaluationSpec,
  cell: ExternalRunImportCell,
): MeasurementMap {
  const declarations = new Map<string, MeasurementDeclaration>(
    spec.measurements.map((declaration) => [declaration.name, declaration]),
  );
  const at = `row ${cell.record.row}`;
  const typed: MeasurementMap = {};
  for (const [name, value] of Object.entries(cell.record.measurements ?? {})) {
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      refuse(
        "validation",
        at,
        `${at}: measurement "${name}" for ${cell.cellKey} is not declared by the sealed `
          + `EvaluationSpec (declared: ${[...declarations.keys()].sort().join(", ") || "none"})`,
      );
    }
    typed[name] = coerceMeasurement(value, declaration, name, cell, at);
  }
  return typed;
}

/** The declared-type coercion, one measurement at a time. Deliberately narrow: a value with no
 * unambiguous reading under the declared type is refused, never guessed at. */
function coerceMeasurement(
  value: string | number | boolean,
  declaration: MeasurementDeclaration,
  name: string,
  cell: ExternalRunImportCell,
  at: string,
): string | number | boolean {
  const refuseValue = (): never => refuse(
    "validation",
    at,
    `${at}: measurement "${name}" for ${cell.cellKey} is declared `
      + `type "${declaration.type}", but the dump supplied ${JSON.stringify(value)}`,
  );

  if (declaration.type === "boolean") {
    if (typeof value === "boolean") return value;
    // Exactly the two spellings the CSV dialect can carry; "1"/"yes"/"TRUE" are guesses.
    if (value === "true") return true;
    if (value === "false") return false;
    return refuseValue();
  }
  if (declaration.type === "number") {
    if (typeof value === "number") return Number.isFinite(value) ? value : refuseValue();
    if (typeof value !== "string" || !DECIMAL_STRING_PATTERN.test(value)) return refuseValue();
    // A decimal string that a JS number cannot hold EXACTLY stays the string it already was:
    // `compare()` parses decimal strings as exact decimals via BigInt, so leaving it alone is
    // strictly more faithful than rounding it into a float that means something else.
    const asNumber = Number(value);
    const roundTrip = String(asNumber);
    if (!DECIMAL_STRING_PATTERN.test(roundTrip) || normalizeDecimal(roundTrip) !== normalizeDecimal(value)) {
      return value;
    }
    return asNumber;
  }
  // `string`: a JSONL boolean or number for a string-declared measurement is a shape disagreement
  // with the sealed spec, not something to stringify on the operator's behalf.
  return typeof value === "string" ? value : refuseValue();
}

/** Canonical form of a decimal-grammar string, so "0.50", "0.5", and "00.5" compare equal. */
function normalizeDecimal(text: string): string {
  const negative = text.startsWith("-");
  const [intDigits = "", fracDigits = ""] = (negative ? text.slice(1) : text).split(".");
  const integer = intDigits.replace(/^0+(?=\d)/u, "");
  const fraction = fracDigits.replace(/0+$/u, "");
  const magnitude = fraction.length === 0 ? integer : `${integer}.${fraction}`;
  return magnitude === "0" ? "0" : `${negative ? "-" : ""}${magnitude}`;
}

// ── synthesis: sealed records + run-journal entries for an accepted plan ─────────────────────
//
// Everything below turns an accepted `ExternalRunImportPlan` into exactly the durable evidence a
// live run would have left behind: sealed Submission/Delivery/evaluation records in the workspace
// CAS, plus the run-journal entries that name them. Nothing downstream is import-aware — the
// UNMODIFIED `runCollect` → `runReport` → `materializePublicBundle` chain reads this journal the
// way it reads any other. That non-change is the whole design, and it is why the shapes here are
// derived from the live driver (`./drive.ts`) rather than invented.
//
// Two rules govern every line:
//
//  1. **The matrix outcome is never asserted, only derived.** `deriveOutcome`
//     (`@jinn-network/benchmarking-run`'s `assemble.ts`) reads the evidence and decides. So the
//     writer's job is to journal what actually happened and let the outcome fall out:
//     `graded` → a delivery plus a verdict → `judged`; `ungradeable` → a delivery plus a
//     could-not-grade terminal → `unscorable`; `error`/`timeout` → a dispatch that never
//     delivered → `expired`; `unrun` → no dispatch at all → `expired` with `dispatches: 0`.
//     Notably we NEVER journal `replaceableReason: "expired"`: `outstandingCells` does not treat
//     the resulting `"expired"` status as terminal, so `runCollect` would refuse the whole run.
//     A bare `error` cell-event maps to `"failed"`, which IS terminal, and still derives
//     `expired` because no delivery exists.
//
//  2. **Nothing is claimed that was not observed.** The verdict is COMPUTED from the subject
//     Task's own sealed EvaluationSpec verdict rule over the imported measurements — there is no
//     pass/fail column in the dump, and `checkVerdictRuleConsistency` re-checks the computation
//     at assembly, so a laundered verdict is structurally impossible. `blame` is never set (we
//     cannot observe task-vs-infrastructure attribution for someone else's harness). No
//     `pinningEvidenceSha256` is journaled, so every pinning axis reports `unverifiable` rather
//     than a `match` nobody checked. And workspace authorship is recorded over the import
//     declaration ONLY — the workspace genuinely authored that; it did not author the external
//     harness's evidence bytes.

/**
 * The evaluator identity every imported verdict is signed under. Deliberately unmistakable: this
 * agent transcribed an external harness's measurements into the protocol's verdict shape and
 * performed no evaluation of its own. It is a DISTINCT identity from any venue evaluator, which
 * is exactly what `checkEvaluatorIndependence` needs to see against the run owner (the solver).
 */
export const EXTERNAL_RUN_IMPORT_EVALUATOR_ID =
  "urn:jinn:colophon:external-import-transcriber/v1";

/** Said in the verdict itself, in plain words, so a reader of the bundle cannot miss it. */
export const EXTERNAL_RUN_IMPORT_LIMITATIONS = [
  "This evaluator transcribed measurements produced by an external harness outside this "
  + "workspace. It executed no grader, observed no attempt, and performed no evaluation of its "
  + "own; the verdict is the sealed EvaluationSpec's verdict rule applied to the transcribed "
  + "measurements.",
  "Run pinning was not observed for the imported attempt, so every pinning axis is reported "
  + "unverifiable rather than matched.",
] as const;

/** The namespaced annotation block that carries the import's own reason/timing facts onto the
 * sealed Submission and Delivery. `SubmissionRecordSchema`/`DeliveryRecordSchema` are `.loose()`
 * and open to namespaced extensions (TEP §21.3), so this rides along without reshaping them. */
export const EXTERNAL_RUN_IMPORT_ANNOTATION_KEY = "network.jinn.colophon.external-run-import/v1";

/** The declaration's own protocol URI, doubling as its authorship `recordKind`. */
export const EXTERNAL_RUN_IMPORT_DECLARATION_PROTOCOL =
  "https://spec.jinn.network/benchmark-product/external-run-import-declaration/v1";

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Rfc3339Schema = z.string().min(1);

export const ExternalRunImportSourceSchema = z.object({
  harness: z.string().min(1),
  version: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});

export type ExternalRunImportSource = z.infer<typeof ExternalRunImportSourceSchema>;

/**
 * The durable home for every fact the dump carried that the protocol records have no field for —
 * above all the `reason` behind each non-graded slot. Without this the honest "we could not run
 * this slot, and here is why" would survive only as a journal `detail` string; sealed into the
 * CAS and bound to the workspace by `recordWorkspaceAuthorship`, it is a record a reader can
 * fetch by digest and check.
 */
export const ExternalRunImportDeclarationSchema = z.object({
  protocol: z.literal(EXTERNAL_RUN_IMPORT_DECLARATION_PROTOCOL),
  runSha256: Sha256HexSchema,
  benchmarkSha256: Sha256HexSchema,
  source: ExternalRunImportSourceSchema,
  importedAt: Rfc3339Schema,
  rows: z.array(z.object({
    cellKey: z.string().min(1),
    outcome: z.enum(EXTERNAL_RUN_IMPORT_OUTCOMES),
    reason: z.string().min(1).optional(),
    timings: z.object({
      startedAt: z.string().min(1).optional(),
      endedAt: z.string().min(1).optional(),
      durationMs: z.number().int().nonnegative().optional(),
    }).optional(),
    evidence: z.array(z.object({ name: z.string().min(1), sha256: Sha256HexSchema })).optional(),
  })),
});

export type ExternalRunImportDeclaration = z.infer<typeof ExternalRunImportDeclarationSchema>;

export interface WriteExternalRunImportInput {
  readonly workspaceDir: string;
  readonly draftId: string;
  /** The accepted plan — every expected slot, exactly once, in expected-cell order. */
  readonly plan: ExternalRunImportPlan;
  readonly runRecord: RunRecord;
  /** `RunState.owner` — the solver identity every synthesized Submission requests under. */
  readonly owner: string;
  readonly source: ExternalRunImportSource;
  /** Everything fallible, already resolved (`preflightExternalRunImport`). The writer CONSUMES
   * this rather than re-resolving: a second resolution is a second chance to disagree, and a
   * refusal raised from here would land mid-write with no rollback. */
  readonly preflight: ExternalRunImportPreflight;
  /** Frozen operation clock; every synthesized `at` that has no imported timestamp uses it. */
  readonly at: string;
}

export interface WriteExternalRunImportResult {
  readonly declarationSha256: string;
  readonly judged: number;
  readonly unscorable: number;
  readonly expired: number;
}

/** One evidence file, read once and sealed into the workspace CAS. */
interface ImportedEvidence {
  readonly name: string;
  readonly sha256: string;
}

/**
 * Writes the sealed records and run-journal entries for an accepted plan, then seals and records
 * the import declaration. Ordered per cell exactly as the live driver orders its own writes, so
 * a fold of the resulting journal is indistinguishable in shape from a driven run's.
 */
export async function writeExternalRunImport(
  input: WriteExternalRunImportInput,
): Promise<WriteExternalRunImportResult> {
  const { workspaceDir, draftId, plan, runRecord, owner, preflight, at } = input;
  // The plan carries the `sha256:`-PREFIXED coordinates (it quotes them verbatim in refusals);
  // idempotency keys want that form and evaluation nonces want the bare hex. Derive both once.
  const runSha256Hex = bareSha256Hex(plan.runSha256);
  const runDigest = `sha256:${runSha256Hex}` as const;
  const [evaluatorKey] = loadOrCreateEvaluatorSigningKeys(workspaceDir, [
    { id: EXTERNAL_RUN_IMPORT_EVALUATOR_ID },
  ]);
  const signer = createVerdictDsseSigner(evaluatorKey!.key);

  const rows: ExternalRunImportDeclaration["rows"] = [];
  let judged = 0;
  let unscorable = 0;
  let expired = 0;

  for (const prepared of preflight.cells) {
    const { cell } = prepared;
    const { cellKey, coord, record, outcome } = cell;
    const annotation = importAnnotation(input.source, record);
    // The declaration's timing block, kept verbatim from the dump: absent members stay absent.
    const timings = declarationTimings(record);

    if (outcome === "unrun") {
      // ONE entry, and no Submission: a slot the harness never dispatched has no attempt to
      // describe. Minting a Submission here would assert a dispatch that never happened, and the
      // fold would count it — `dispatches` must stay 0.
      appendRunJournalEntry(workspaceDir, draftId, {
        kind: "cell-event",
        at,
        event: {
          cellKey,
          armId: coord.armId,
          replicate: coord.replicate,
          dispatch: 1,
          kind: "error",
          detail: record.reason!,
        },
      });
      expired += 1;
      rows.push({ cellKey, outcome, ...(record.reason === undefined ? {} : { reason: record.reason }), ...(timings === undefined ? {} : { timings }) });
      continue;
    }

    // --- dispatch + solve Submission (every remaining outcome was genuinely attempted) --------
    appendRunJournalEntry(workspaceDir, draftId, {
      kind: "cell-event",
      at: record.startedAt ?? at,
      event: {
        cellKey,
        armId: coord.armId,
        replicate: coord.replicate,
        dispatch: 1,
        kind: "dispatch",
      },
    });

    const idempotencyKey = cellIdempotencyKey(runDigest, cellKey, 1);
    // Resolved by the preflight, which refuses a missing arm before anything is written; every
    // outcome that reaches this line is a dispatched one, so the arm is present by construction.
    const arm = prepared.arm!;
    const submissionBytes = sealSubmission({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: deterministicUuidUri(idempotencyKey),
      task: { digest: { sha256: coord.taskDigest } },
      requester: owner,
      nonce: `${cellKey}:1`,
      idempotencyKey,
      deadline: runRecord.closeAt,
      attempts: { maxTotal: 1, maxConcurrent: 1 },
      requirements: {
        ...(arm.pinning as Record<string, unknown>),
        ...(runRecord.policy.submissionBaseline as Record<string, unknown>),
      },
      annotations: { run: runDigest, cellKey, armId: coord.armId, [EXTERNAL_RUN_IMPORT_ANNOTATION_KEY]: annotation },
    });
    const submissionSha256 = putSealedBytes(workspaceDir, submissionBytes);
    // No `pinningEvidenceSha256`, deliberately and permanently: nothing about the external
    // harness's run was verified against the sealed pinning map, so the axes must stay
    // `unverifiable`. Omission is the honest encoding — there is no "unchecked" evidence value.
    appendRunJournalEntry(workspaceDir, draftId, {
      kind: "submission-accepted",
      at: record.startedAt ?? at,
      cellKey,
      dispatch: 1,
      submissionSha256,
      leg: "solve",
    });

    if (outcome === "error" || outcome === "timeout") {
      // Dispatched, never delivered. NO `replaceableReason` — `"expired"` there is not a terminal
      // status for `outstandingCells`, and collect would refuse the run. NO `blame` — we cannot
      // honestly observe task-vs-infrastructure attribution for another harness's failure.
      appendRunJournalEntry(workspaceDir, draftId, {
        kind: "cell-event",
        at: record.endedAt ?? at,
        event: {
          cellKey,
          armId: coord.armId,
          replicate: coord.replicate,
          dispatch: 1,
          kind: "error",
          detail: record.reason!,
        },
      });
      expired += 1;
      rows.push({ cellKey, outcome, ...(record.reason === undefined ? {} : { reason: record.reason }), ...(timings === undefined ? {} : { timings }) });
      continue;
    }

    // --- evidence + solve Delivery (graded and ungradeable both delivered something) ----------
    const evidence = sealPreparedEvidence(workspaceDir, prepared.evidence);
    const createdAt = record.endedAt ?? at;
    const attempt = deterministicUuidUri(`external-run-import:attempt:${runSha256Hex}:${cellKey}:1`);
    const deliveryBytes = sealDelivery({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt,
      task: `sha256:${coord.taskDigest}`,
      outputs: evidence.map((file) => ({ name: file.name, digest: { sha256: file.sha256 } })),
      outcome: "fulfilled",
      createdAt,
      annotations: { [EXTERNAL_RUN_IMPORT_ANNOTATION_KEY]: annotation },
    });
    const deliverySha256 = putSealedBytes(workspaceDir, deliveryBytes);
    appendRunJournalEntry(workspaceDir, draftId, {
      kind: "cell-event",
      at: createdAt,
      event: {
        cellKey,
        armId: coord.armId,
        replicate: coord.replicate,
        dispatch: 1,
        kind: "delivered",
        attempt,
      },
    });
    // `outputs` must equal the Delivery's own digest-bearing outputs byte-for-byte: the public
    // reader recomputes them from the sealed Delivery and canonical-compares the two.
    appendRunJournalEntry(workspaceDir, draftId, {
      kind: "delivery",
      at: createdAt,
      cellKey,
      dispatch: 1,
      attempt,
      deliverySha256,
      outputs: evidence.map((file) => ({ name: file.name, sha256: file.sha256 })),
    });

    const declarationRow = {
      cellKey,
      outcome,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(timings === undefined ? {} : { timings }),
      evidence: evidence.map((file) => ({ name: file.name, sha256: file.sha256 })),
    };

    if (outcome === "ungradeable") {
      // The exact shape `journalCouldNotGrade` writes (`./drive.ts`): a terminal for leg 1 with no
      // evaluation Task, Submission, or Delivery — because none was ever prepared. `deriveOutcome`
      // reads the delivery + this terminal as `unscorable`.
      //
      // NO `evaluator`, deliberately: this is a PRE-evaluation terminal, and the public reader
      // refuses one that claims an evaluator identity ("pre-evaluation terminal cannot claim an
      // evaluator identity"). The refusal is right — nothing evaluated this cell, so naming an
      // evaluator over it would attach an identity to work that never happened. The reason still
      // travels: on the journal entry's `detail`, on the solve Submission's and Delivery's
      // namespaced annotation, and in the sealed import declaration.
      appendRunJournalEntry(workspaceDir, draftId, {
        kind: "evaluation",
        at: createdAt,
        cellKey,
        evaluationTerminal: "could-not-grade",
        detail: record.reason!,
        evalIndex: 1,
      });
      unscorable += 1;
      rows.push(declarationRow);
      continue;
    }

    await writeGradedEvaluation({
      workspaceDir,
      draftId,
      plan,
      cell,
      grading: prepared.grading!,
      evidence,
      deliverySha256,
      createdAt,
      annotation,
      owner,
      runRecord,
      signer,
      evaluatorId: EXTERNAL_RUN_IMPORT_EVALUATOR_ID,
    });
    judged += 1;
    rows.push(declarationRow);
  }

  const declaration: ExternalRunImportDeclaration = ExternalRunImportDeclarationSchema.parse({
    protocol: EXTERNAL_RUN_IMPORT_DECLARATION_PROTOCOL,
    runSha256: runSha256Hex,
    benchmarkSha256: bareSha256Hex(plan.benchmarkSha256),
    source: input.source,
    importedAt: at,
    rows,
  });
  const declarationSha256 = putSealedBytes(workspaceDir, canonicalJsonBytes(declaration));
  // Authorship over the DECLARATION only. The workspace genuinely authored this record; it did
  // not author the external harness's evidence bytes, and claiming otherwise would be exactly the
  // kind of borrowed provenance the rest of this module exists to avoid.
  recordWorkspaceAuthorship({
    workspaceDir,
    recordSha256: declarationSha256,
    recordKind: EXTERNAL_RUN_IMPORT_DECLARATION_PROTOCOL,
    authoredAt: at,
  });
  appendRunJournalEntry(workspaceDir, draftId, {
    kind: "external-import",
    at,
    declarationSha256,
    source: input.source,
  });

  return { declarationSha256, judged, unscorable, expired };
}

/** Strips the `sha256:` prefix the plan carries on its coordinates. */
function bareSha256Hex(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

/** The namespaced block carried on both sealed records: what this cell's evidence actually is. */
function importAnnotation(
  source: ExternalRunImportSource,
  record: ExternalRunRecord,
): Record<string, unknown> {
  return {
    source,
    outcome: record.outcome,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
  };
}

function declarationTimings(
  record: ExternalRunRecord,
): ExternalRunImportDeclaration["rows"][number]["timings"] {
  if (record.startedAt === undefined && record.endedAt === undefined && record.durationMs === undefined) {
    return undefined;
  }
  return {
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
  };
}

/**
 * Seals the preflight's already-read evidence bytes, IN DUMP ORDER. Order is load-bearing twice
 * over: it fixes the Delivery's `outputs` array, and the public reader re-derives the evaluation
 * Task from exactly those outputs and byte-compares the result.
 */
function sealPreparedEvidence(
  workspaceDir: string,
  evidence: readonly PreparedEvidence[],
): ImportedEvidence[] {
  return evidence.map((file) => ({
    name: file.name,
    sha256: putSealedBytes(workspaceDir, file.bytes),
  }));
}

interface WriteGradedEvaluationInput {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly plan: ExternalRunImportPlan;
  readonly cell: ExternalRunImportCell;
  /** The rule, the typed measurements, and the verdict — all resolved by the preflight. */
  readonly grading: PreparedGrading;
  readonly evidence: readonly ImportedEvidence[];
  readonly deliverySha256: string;
  readonly createdAt: string;
  readonly annotation: Record<string, unknown>;
  readonly owner: string;
  readonly runRecord: RunRecord;
  readonly signer: ReturnType<typeof createVerdictDsseSigner>;
  readonly evaluatorId: string;
}

/**
 * The full separate-evaluator lineage for one graded cell: derived evaluation Task → evaluation
 * Submission → signed verdict → evaluation Delivery → the journal entry naming all four.
 *
 * `materialize.ts` accepts only `hasSeparateLineage` (the Inspect same-execution shape is gated on
 * an Inspect adapter, which import refuses), and the public reader RE-DERIVES the evaluation Task
 * from the solve Delivery's outputs and the subject Task's EvaluationSpec and byte-compares it —
 * which is why the evidence names and their order above are not cosmetic.
 */
async function writeGradedEvaluation(input: WriteGradedEvaluationInput): Promise<void> {
  const { workspaceDir, draftId, plan, cell, grading, evidence, deliverySha256, createdAt } = input;
  const { cellKey, coord } = cell;

  const { evaluationSpecSha256, measurements, outcome } = grading;
  const derived = deriveEvaluationTask({
    subjectTask: { name: "subject-task.json", digest: `sha256:${coord.taskDigest}` },
    subjectDelivery: { name: "subject-delivery.json", digest: `sha256:${deliverySha256}` },
    subjectResults: evidence.map((file) => ({ name: file.name, digest: `sha256:${file.sha256}` as const })),
    evaluationSpecDigest: `sha256:${evaluationSpecSha256}`,
  });
  const evalTaskSha256 = putSealedBytes(workspaceDir, derived.bytes);

  // The nonce shape is re-parsed by `materialize.ts` and re-asserted by the public reader, so it
  // is a contract, not a label: `eval:<runSha256>:e<evalIndex>:<cellKey>:<dispatch>`.
  const runSha256Hex = bareSha256Hex(plan.runSha256);
  const evalNonce = `eval:${runSha256Hex}:e1:${cellKey}:1`;
  const evalSubmissionBytes = sealSubmission({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: deterministicUuidUri(evalNonce),
    task: { digest: { sha256: evalTaskSha256 } },
    requester: input.owner,
    nonce: evalNonce,
    idempotencyKey: evalNonce,
    deadline: input.runRecord.closeAt,
    requirements: { harness: EVALUATION_HARNESS_PIN, [EVALUATOR_REQUIREMENT_KEY]: input.evaluatorId },
    annotations: { [EXTERNAL_RUN_IMPORT_ANNOTATION_KEY]: input.annotation },
  });
  const evalSubmissionSha256 = putSealedBytes(workspaceDir, evalSubmissionBytes);
  appendRunJournalEntry(workspaceDir, draftId, {
    kind: "submission-accepted",
    at: createdAt,
    cellKey,
    dispatch: 1,
    submissionSha256: evalSubmissionSha256,
    leg: "evaluation",
    evalIndex: 1,
  });

  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "subject-task.json", digest: { sha256: coord.taskDigest } },
      ...evidence.map((file) => ({ name: file.name, digest: { sha256: file.sha256 } })),
    ],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluator: { id: input.evaluatorId },
      verdict: outcome.verdict,
      evaluationSpecification: { digest: { sha256: evaluationSpecSha256 } },
      taskSubject: "subject-task.json",
      resultSubjects: evidence.map((file) => file.name),
      measurements: Object.keys(measurements)
        .sort()
        .map((name) => ({ name, value: measurements[name]! })),
      evaluatedAt: createdAt,
      limitations: [...EXTERNAL_RUN_IMPORT_LIMITATIONS],
    },
  };
  const verdictBytes = await sealVerdictStatement({
    statementBytes: canonicalJsonBytes(statement),
    evaluatorId: input.evaluatorId,
    expectedEvaluationSpecificationSha256: evaluationSpecSha256,
    signer: input.signer,
  });
  const verdictSha256 = putSealedBytes(workspaceDir, verdictBytes);

  const evalAttempt = deterministicUuidUri(`external-run-import:eval-attempt:${runSha256Hex}:${cellKey}:1`);
  const evalDeliveryBytes = sealDelivery({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    attempt: evalAttempt,
    task: `sha256:${evalTaskSha256}`,
    outputs: [{ name: "verdict", digest: { sha256: verdictSha256 } }],
    outcome: "fulfilled",
    createdAt,
    annotations: { [EXTERNAL_RUN_IMPORT_ANNOTATION_KEY]: input.annotation },
  });
  const evalDeliverySha256 = putSealedBytes(workspaceDir, evalDeliveryBytes);

  appendRunJournalEntry(workspaceDir, draftId, {
    kind: "evaluation",
    at: createdAt,
    cellKey,
    evalTaskSha256,
    evalDeliverySha256,
    evalAttempt,
    verdictSha256,
    evaluator: input.evaluatorId,
    evalIndex: 1,
  });
}

/** The subject Task's bound EvaluationSpec digest (bare hex). A Task with none cannot be graded
 * from a dump: there is no rule to evaluate the measurements against, and the importer has no
 * standing to supply one. */
function subjectEvaluationSpecSha256(
  workspaceDir: string,
  taskDigestHex: string,
  cellKey: string,
): string {
  const doc = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(getSealedBytes(workspaceDir, taskDigestHex)),
  ) as { readonly evaluation?: { readonly digest?: { readonly sha256?: string } } };
  const sha256 = doc.evaluation?.digest?.sha256;
  if (sha256 === undefined) {
    refuse(
      "conflict",
      `cells.${cellKey}`,
      `Task ${taskDigestHex} binds no EvaluationSpec, so an imported "graded" row has no verdict `
        + "rule to be checked against — import it as \"ungradeable\" with a reason instead",
    );
  }
  return sha256;
}
