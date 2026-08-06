/**
 * Shared assembly-port construction for the official run path (BP-13 deliverable 3): extracted,
 * verbatim, from `../operations/run-collect.ts`, which used to build this inline.
 *
 * `run.collect` seals a Matrix by assembling `InScopeCell[]` from durable state (the run journal
 * plus the sealed-bytes store) and wiring `@jinn-network/benchmarking-local`'s
 * `localAssemblyPorts` over it. The skeptic's `run.verify` operation (`../operations/verify.ts`)
 * needs to rebuild EXACTLY the same ports from the same durable facts to re-derive the Matrix and
 * byte-compare it against what collect sealed. Two independently written constructions could
 * silently drift from each other — and a drift here is not a cosmetic bug: it would either make
 * verify reject a Matrix collect genuinely and honestly sealed, or (worse) make verify accept a
 * Matrix collect never would have produced. One shared implementation, called from both sites, is
 * the only construction that cannot drift. `run-collect.ts` and `verify.ts` both call
 * `buildRunAssemblyPorts` with the same durable inputs (the sealed Run record, the expected cell
 * set, the run-journal fold, the workspace's admission receipts, and the run owner) and get back
 * the identical `AssemblyPorts` bundle `assembleMatrix`/`verifyMatrix` require.
 *
 * This module is a pure code motion out of `run-collect.ts` — no behavior change from what that
 * module did inline before this extraction.
 */

import type { CellCoord, RunRecord } from "@jinn-network/benchmarking-records";
import { localAssemblyPorts } from "@jinn-network/benchmarking-local";
import type { AssemblyPorts, InScopeCell, InScopeVerdict } from "@jinn-network/benchmarking-run";
import { parseEvaluationSpec, type EvaluationSpec } from "@jinn-network/task-execution-profiles";
import { readVerdictEnvelope } from "../venue/signing.js";
import { VENUE_ISOLATION_INVENTORY } from "../venue/venue.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { LocalAdmissionReceiptFact } from "./admission-receipts.js";
import type { CellJournalFold } from "./journal.js";

/**
 * `InScopeCell.evaluationSpecDigest` is the `sha256:<hex>`-PREFIXED form (verified against
 * `@jinn-network/benchmarking-local`'s own `miniature-run.test.ts` fixture — `checkVerdictSpecMatch`
 * compares it byte-for-byte against a verdict's `record.evaluationSpecification`, which
 * `readVerdictEnvelope`'s `evaluationSpecificationSha256` is turned into with the same prefix
 * below) — distinct from the bare-hex form the workspace's sealed-bytes store and the Task
 * document's own `evaluation.digest.sha256` field use.
 */
function subjectEvaluationSpecRef(
  workspaceDir: string,
  taskDigestHex: string,
): { evaluationSpecDigest?: `sha256:${string}`; evaluationSpec?: EvaluationSpec } {
  const subjectTaskBytes = getSealedBytes(workspaceDir, taskDigestHex);
  const subjectTaskDoc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(subjectTaskBytes)) as {
    readonly evaluation?: { readonly digest?: { readonly sha256?: string } };
  };
  const evaluationSpecSha256 = subjectTaskDoc.evaluation?.digest?.sha256;
  if (evaluationSpecSha256 === undefined) return {};
  const evaluationSpecDigest = `sha256:${evaluationSpecSha256}` as const;
  try {
    const evaluationSpec = parseEvaluationSpec(getSealedBytes(workspaceDir, evaluationSpecSha256));
    return { evaluationSpecDigest, evaluationSpec };
  } catch {
    return { evaluationSpecDigest };
  }
}

function buildVerdicts(workspaceDir: string, cell: CellJournalFold, evaluationSpec: EvaluationSpec | undefined): InScopeVerdict[] {
  if (cell.verdictSha256 === undefined) return [];
  const envelopeBytes = getSealedBytes(workspaceDir, cell.verdictSha256);
  const view = readVerdictEnvelope(envelopeBytes);
  return [{
    digest: `sha256:${cell.verdictSha256}` as const,
    record: {
      evaluationSpecification: `sha256:${view.evaluationSpecificationSha256}`,
      evaluator: view.evaluatorId,
      verdict: view.verdict,
    },
    measurements: view.measurements,
    ...(evaluationSpec !== undefined ? { evaluationSpec } : {}),
  }];
}

/** Builds one `InScopeCell` per expected coordinate, entirely from the journal fold + sealed
 * bytes store — no backend call anywhere in this function (module header). */
function buildInScopeCells(
  workspaceDir: string,
  expected: readonly CellCoord[],
  fold: ReadonlyMap<string, CellJournalFold>,
): InScopeCell[] {
  return expected.map((coord) => {
    const cell = fold.get(coord.cellKey);
    if (cell === undefined) {
      return { cellKey: coord.cellKey, armId: coord.armId, replicate: coord.replicate, taskDigest: coord.taskDigest, dispatches: 0, verdicts: [] };
    }

    const { evaluationSpecDigest, evaluationSpec } = subjectEvaluationSpecRef(workspaceDir, coord.taskDigest);
    const verdicts = buildVerdicts(workspaceDir, cell, evaluationSpec);

    return {
      cellKey: coord.cellKey,
      armId: coord.armId,
      replicate: coord.replicate,
      taskDigest: coord.taskDigest,
      dispatches: cell.dispatches,
      ...(cell.dispatches > 0 ? { accounted: cell.dispatches } : {}),
      ...(cell.submissionSha256 !== undefined ? { submissionDigest: `sha256:${cell.submissionSha256}` as const } : {}),
      ...(cell.attempt !== undefined ? { attempt: cell.attempt } : {}),
      ...(cell.deliverySha256 !== undefined
        ? { deliveryBytes: getSealedBytes(workspaceDir, cell.deliverySha256), deliveryDigest: `sha256:${cell.deliverySha256}` as const }
        : {}),
      ...(evaluationSpecDigest !== undefined ? { evaluationSpecDigest } : {}),
      ...(evaluationSpec !== undefined ? { evaluationSpec } : {}),
      ...(cell.evaluationTerminal !== undefined ? { evaluationTerminal: cell.evaluationTerminal } : {}),
      verdicts,
    } satisfies InScopeCell;
  });
}

export interface BuildRunAssemblyPortsInput {
  readonly workspaceDir: string;
  readonly runRecord: RunRecord;
  /** The full expected cell coordinate set (`expectedCellSet(benchRecord, runRecord)`). */
  readonly expected: readonly CellCoord[];
  /** The run journal folded to one status per cell (`foldRunJournal`). */
  readonly fold: ReadonlyMap<string, CellJournalFold>;
  /** The run's deterministic owner IRI (`RunState.owner`). */
  readonly owner: string;
  /** Prediction-snapshot admission receipts keyed by admitted Task digest (bare hex),
   * `scanPredictionSnapshotAdmissionReceipts(workspaceDir)`. */
  readonly receiptsByTaskDigest: ReadonlyMap<string, LocalAdmissionReceiptFact>;
}

/**
 * Builds the exact `AssemblyPorts` bundle `assembleMatrix`/`verifyMatrix` require, entirely from
 * durable run state (module header). Both `run.collect` (the original sealer) and `run.verify`
 * (the independent re-derivation) call this with the same inputs and get back byte-identical
 * ports.
 */
export function buildRunAssemblyPorts(input: BuildRunAssemblyPortsInput): AssemblyPorts {
  const { workspaceDir, runRecord, expected, fold, owner, receiptsByTaskDigest } = input;
  const cells = buildInScopeCells(workspaceDir, expected, fold);

  return localAssemblyPorts({
    inputScope: { cellsForRun: () => cells },
    pinning: {
      submissionBaseline: runRecord.policy.submissionBaseline as Record<string, unknown>,
      isolationInventory: VENUE_ISOLATION_INVENTORY,
      evidenceFor: (cellKey) => {
        const cell = fold.get(cellKey);
        if (cell === undefined || cell.dispatches === 0) return { dispatches: 0 };
        // The backend's launcherDeployments admission gate (verifyRunPinning) ran at
        // `submit` for every accepted dispatch — a dispatched cell genuinely passed it.
        return { dispatches: cell.dispatches, admission: { ready: true } };
      },
    },
    admission: {
      receiptFor: (cell) => receiptsByTaskDigest.get(cell.taskDigest),
    },
    cost: {
      costFor: () => undefined,
      latencyFor: () => undefined,
    },
    trust: {
      // Solver identity is this run's own owner (the product's deterministic run-owner IRI).
      // Evaluator identity is resolved from the verdict's OWN claimed evaluator IRI
      // (`evidenceRef.claim` — `assemble.ts` passes `verdict.record.evaluator`, which
      // `buildVerdicts` above set to `view.evaluatorId` from `readVerdictEnvelope`, i.e. the
      // venue's real evaluator identity, e.g. `EVALUATOR_ID` in venue.ts). On this local
      // self-run venue that is an echo of what the venue itself recorded, not an
      // independently verified identity — the same operator controls both roles here; this
      // resolver discloses that fact rather than manufacturing a false appearance of
      // third-party verification.
      resolveAgent: async (evidenceRef) => {
        const role = (evidenceRef as { role?: string } | undefined)?.role;
        if (role === "solver") return owner;
        if (role === "evaluator") {
          const claim = (evidenceRef as { claim?: unknown } | undefined)?.claim;
          return typeof claim === "string" && claim.length > 0 ? claim : "unresolved";
        }
        return "unresolved";
      },
    },
  });
}
