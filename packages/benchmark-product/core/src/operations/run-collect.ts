/**
 * `run.collect` (spec §4.1: running --close-boundary--> closed; "system" event, but this
 * product exposes it as an explicit operation a sponsor or delegated agent invokes rather than
 * a background timer — the close boundary is REACHED by clock, not automatically assembled):
 * folds the run journal into `InScopeCell[]` entirely from durable state (the journal plus the
 * sealed-bytes store) — no backend, no venue boot, per M1 composition dossier §1's own
 * "Run wiring" note that assembly composes `localAssemblyPorts` over host-supplied facts.
 *
 * Refuses `"conflict"` unless the close boundary has genuinely been reached: either every
 * expected cell is already terminal-accounted (nothing left to wait for), or the Run's
 * pre-registered `closeAt` has passed. `assembleMatrix` → `verifyMatrix` re-derives the exact
 * same bytes from the exact same (pure, journal/store-sourced) ports and MUST agree —
 * `verifyMatrix` failing here would mean this module's own port construction is not
 * self-consistent, not a genuine third-party integrity concern, but it is refused exactly the
 * same as any other `"record-integrity"` failure (spec §4.3): silently sealing a Matrix this
 * module cannot re-derive itself would be worse than refusing.
 */

import {
  expectedCellSet,
  parseBenchmark,
  parseRun,
  type CellCoord,
} from "@jinn-network/benchmarking-records";
import { assembleMatrix, verifyMatrix, type InScopeCell, type InScopeVerdict } from "@jinn-network/benchmarking-run";
import { localAssemblyPorts } from "@jinn-network/benchmarking-local";
import { parseEvaluationSpec, type EvaluationSpec } from "@jinn-network/task-execution-profiles";
import type { DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { scanPredictionSnapshotAdmissionReceipts } from "../run/admission-receipts.js";
import { appendRunJournalEntry, foldRunJournal, outstandingCells, readRunJournalEntries, type CellJournalFold } from "../run/journal.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { VENUE_ISOLATION_INVENTORY } from "../venue/venue.js";
import { readVerdictEnvelope } from "../venue/signing.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface RunCollectInput {
  readonly draftId: string;
}

export interface RunCollectResult {
  readonly draft: DraftDocument;
  readonly matrixSha256: string;
}

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

export function runCollect(
  context: OperationContext,
  input: RunCollectInput,
): Promise<OperationResult<RunCollectResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operateAsync({
    context: clockedContext,
    action: "run.collect",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      if (document.state !== "running") {
        refuse(
          "illegal-transition",
          `drafts.${input.draftId}.state`,
          `draft ${input.draftId} is in state "${document.state}" — only a running draft can be collected`,
        );
      }
      if (document.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, `draft ${input.draftId} has no attached benchmark`);
      }

      const runState = requireRunState(clockedContext.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined || runState.closeAt === undefined) {
        refuse("conflict", `runs.${input.draftId}`, `draft ${input.draftId} has no sealed Run record yet`);
      }

      const runRecord = parseRun(getSealedBytes(clockedContext.workspaceDir, runState.runSha256));
      const benchRecord = parseBenchmark(getSealedBytes(clockedContext.workspaceDir, document.spec.taskSet.benchmarkSha256));
      const expected = expectedCellSet(benchRecord, runRecord);
      const fold = foldRunJournal(readRunJournalEntries(clockedContext.workspaceDir, input.draftId));

      const allTerminalAccounted = outstandingCells(expected, fold).length === 0;
      const closeBoundaryReached = Date.parse(at) >= Date.parse(runState.closeAt);
      if (!allTerminalAccounted && !closeBoundaryReached) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          "not every expected cell is terminal-accounted yet, and the run's closeAt has not passed — resume the run or wait for the close boundary",
        );
      }

      const cells = buildInScopeCells(clockedContext.workspaceDir, expected, fold);
      const receiptsByTaskDigest = scanPredictionSnapshotAdmissionReceipts(clockedContext.workspaceDir);
      const owner = runState.owner;

      const ports = localAssemblyPorts({
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

      const assembled = await assembleMatrix(benchRecord, runRecord, ports);
      const verified = await verifyMatrix(assembled.record, benchRecord, runRecord, ports, undefined, assembled.bytes);
      if (!verified.ok) {
        refuse("record-integrity", "matrix", `${verified.check}: ${verified.detail}`);
      }

      const matrixSha256 = putSealedBytes(clockedContext.workspaceDir, assembled.bytes);

      writeRunState(clockedContext.workspaceDir, input.draftId, { ...runState, matrixSha256, closedAt: at });

      const transitioned = transition("running", "close-boundary");
      if (!transitioned.ok) {
        refuse("illegal-transition", `drafts.${input.draftId}.state`, transitioned.error.detail);
      }
      const draft: DraftDocument = { ...document, state: transitioned.state, updatedAt: at };
      atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));

      appendRunJournalEntry(clockedContext.workspaceDir, input.draftId, { kind: "closed", at, matrixSha256 });

      return { draft, matrixSha256 };
    },
  });
}
