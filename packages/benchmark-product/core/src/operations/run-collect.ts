/**
 * `run.collect` (spec §4.1: running --close-boundary--> closed; "system" event, but this
 * product exposes it as an explicit operation a sponsor or delegated agent invokes rather than
 * a background timer — the close boundary is REACHED by clock, not automatically assembled):
 * folds the run journal into `InScopeCell[]` entirely from durable state (the journal plus the
 * sealed-bytes store) — no backend, no venue boot, per M1 composition dossier §1's own
 * "Run wiring" note that assembly composes `localAssemblyPorts` over host-supplied facts.
 *
 * Refuses `"conflict"` unless the close boundary has genuinely been reached: either every
 * expected solve cell is terminal-accounted AND every required evaluation leg has reached a
 * durable terminal (nothing left that can still change Matrix inputs), or the Run's
 * pre-registered `closeAt` has passed. A solve-side delivery alone is not enough: the driver
 * journals its evaluation verdict after that delivery, and sealing in between those writes would
 * let a later `run.verify` observe different durable facts. `assembleMatrix` → `verifyMatrix`
 * re-derives the exact same bytes from the exact same (pure, journal/store-sourced) ports and MUST agree —
 * `verifyMatrix` failing here would mean this module's own port construction is not
 * self-consistent, not a genuine third-party integrity concern, but it is refused exactly the
 * same as any other `"record-integrity"` failure (spec §4.3): silently sealing a Matrix this
 * module cannot re-derive itself would be worse than refusing.
 *
 * BP-22: refuses `"conflict"` before even reaching the close-boundary check when a cancellation
 * is already pending (`../run/cancel-marker.ts`'s `cancelRequested`) — `run.cancel` is the sole
 * finalizer once a cancel has been requested, so collect steps aside rather than racing it to
 * seal the Matrix first.
 */

import {
  expectedCellSet,
  parseBenchmark,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { assembleMatrix, verifyMatrix } from "@jinn-network/benchmarking-run";
import type { DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { scanPredictionSnapshotAdmissionReceipts } from "../run/admission-receipts.js";
import { buildRunAssemblyPorts } from "../run/assembly-ports.js";
import { cancelRequested } from "../run/cancel-marker.js";
import { acquireRunFinalizationLock } from "../run/finalization-lock.js";
import {
  appendRunJournalEntry,
  evaluationGaps,
  foldRunJournal,
  outstandingCells,
  readRunJournalEntries,
} from "../run/journal.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { resolveSwebenchHarnessRunId, swebenchModelNameOrPathByArm } from "../runtime/swe-bench-verified/launcher.js";
import { SwebenchVerifiedSelectionManifestSchema } from "../runtime/swe-bench-verified/manifest.js";
import { suiteFactsFromAccountedSwebenchRun } from "../runtime/suite-protocol/from-swebench.js";
import { ApexAgentsSelectionManifestSchema } from "../runtime/apex-agents/manifest.js";
import { suiteFactsFromAccountedApexRun } from "../runtime/suite-protocol/from-apex.js";
import { join } from "node:path";
import { artifactsDir, draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
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
      const finalization = acquireRunFinalizationLock(clockedContext.workspaceDir, input.draftId);
      if (!finalization.acquired) {
        const code = finalization.reason === "contended"
          ? "conflict"
          : finalization.reason === "invalid"
            ? "record-integrity"
            : "execution";
        refuse(code, `runs.${input.draftId}.finalization`, finalization.detail);
      }

      try {
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

      if (cancelRequested(clockedContext.workspaceDir, input.draftId)) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          `draft ${input.draftId} has a pending cancellation — run "cancel" to finalize it, not "collect"`,
        );
      }

      const runRecord = parseRun(getSealedBytes(clockedContext.workspaceDir, runState.runSha256));
      const benchRecord = parseBenchmark(getSealedBytes(clockedContext.workspaceDir, document.spec.taskSet.benchmarkSha256));
      const expected = expectedCellSet(benchRecord, runRecord);
      const fold = foldRunJournal(readRunJournalEntries(clockedContext.workspaceDir, input.draftId));
      const minVerdicts = runRecord.policy.evaluation?.minVerdicts ?? 1;
      const maxInfrastructureRetries = runRecord.policy.evaluation?.maxInfrastructureRetries ?? 0;
      const allTerminalAccounted = outstandingCells(expected, fold).length === 0
        && evaluationGaps(fold, minVerdicts, maxInfrastructureRetries).length === 0;
      const closeBoundaryReached = Date.parse(at) >= Date.parse(runState.closeAt);
      if (!allTerminalAccounted && !closeBoundaryReached) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          "not every expected solve cell and evaluation leg is terminal-accounted yet, and the run's closeAt has not passed — resume the run or wait for the close boundary",
        );
      }
      const receiptsByTaskDigest = scanPredictionSnapshotAdmissionReceipts(clockedContext.workspaceDir);
      const owner = runState.owner;

      // Built through the SHARED construction (`../run/assembly-ports.ts`) so `run.verify` can
      // rebuild the exact same ports from the exact same durable facts (that module's own header).
      const ports = buildRunAssemblyPorts({
        workspaceDir: clockedContext.workspaceDir,
        draftId: input.draftId,
        runRecord,
        expected,
        fold,
        owner,
        receiptsByTaskDigest,
      });

      const assembled = await assembleMatrix(benchRecord, runRecord, ports);
      const verified = await verifyMatrix(assembled.record, benchRecord, runRecord, ports, undefined, assembled.bytes);
      if (!verified.ok) {
        refuse("record-integrity", "matrix", `${verified.check}: ${verified.detail}`);
      }

      const matrixSha256 = putSealedBytes(clockedContext.workspaceDir, assembled.bytes);

      const nextState = { ...runState, matrixSha256, closedAt: at };
      if (document.spec.evaluationRuntime?.adapterId === "swebench-harness") {
        const verified = SwebenchVerifiedSelectionManifestSchema.parse(
          JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
        );
        const reportRoot = join(artifactsDir(clockedContext.workspaceDir), "swebench-harness", input.draftId);
        const facts = suiteFactsFromAccountedSwebenchRun({
          manifest: verified,
          armCount: runRecord.arms.length,
          itemCount: new Set(assembled.record.cells.map((cell) => cell.taskDigest)).size,
          replicates: runRecord.replicates,
          matrix: assembled.record,
          armIds: document.spec.arms.map((arm) => arm.armId),
          reportRoot,
          runId: resolveSwebenchHarnessRunId(reportRoot, runState.runSha256),
          modelNameOrPathByArm: swebenchModelNameOrPathByArm(document.spec.arms),
        });
        nextState.suiteQuote = facts.quote;
      }
      if (document.spec.evaluationRuntime?.adapterId === "archipelago") {
        const apex = ApexAgentsSelectionManifestSchema.parse(
          JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
        );
        const reportRoot = join(artifactsDir(clockedContext.workspaceDir), "archipelago", input.draftId);
        const facts = suiteFactsFromAccountedApexRun({
          manifest: apex,
          armCount: runRecord.arms.length,
          itemCount: new Set(assembled.record.cells.map((cell) => cell.taskDigest)).size,
          replicates: runRecord.replicates,
          matrix: assembled.record,
          armIds: document.spec.arms.map((arm) => arm.armId),
          reportRoot,
        });
        nextState.suiteQuote = facts.quote;
      }
      writeRunState(clockedContext.workspaceDir, input.draftId, nextState);

      const transitioned = transition("running", "close-boundary");
      if (!transitioned.ok) {
        refuse("illegal-transition", `drafts.${input.draftId}.state`, transitioned.error.detail);
      }
      const draft: DraftDocument = { ...document, state: transitioned.state, updatedAt: at };
      atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));

      appendRunJournalEntry(clockedContext.workspaceDir, input.draftId, { kind: "closed", at, matrixSha256 });

        return { draft, matrixSha256 };
      } finally {
        finalization.release();
      }
    },
  });
}
