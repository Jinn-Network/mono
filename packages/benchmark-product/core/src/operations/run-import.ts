// SPDX-License-Identifier: Apache-2.0

/**
 * `run.import` (#2979): make a locked run a run by IMPORTING an external harness's results,
 * instead of driving the cells on a venue.
 *
 * The design's central claim is a NON-change. This operation writes run-journal entries and
 * sealed bytes into the workspace and then stops; the unmodified `runCollect` → `runReport` →
 * `materializePublicBundle` chain finishes the job, reading that journal exactly as it reads a
 * driven run's. Nothing in the public reader, the benchmarking platform, or bundle materialization
 * knows this path exists — which is the point: if importing needed a special case anywhere
 * downstream, the resulting bundle would be a second, weaker kind of artifact wearing the same
 * name. Everything import cannot honestly produce is refused up front (below) rather than
 * approximated.
 *
 * ## Why this performs the launch transition, under the launch grant
 *
 * `runCollect` requires `state === "running"`. So import runs on a LOCKED draft and performs
 * `locked --launch--> running` itself (`../domain/lifecycle.ts`), stamping `RunState.launchedAt`.
 * It is gated as `action: "launch"` — NOT as a new gated action. A new entry in
 * `GATED_OPERATIONS` would deny the operation in every workspace whose stored `authority.json`
 * predates it, and the authority question here is genuinely the launch question: import is the
 * act that turns this pre-registration into a run with results attached. The audit trail
 * distinguishes the two through the durable `external-import` journal entry and the sealed
 * `ExternalRunImportDeclaration` it names, not through a second grant nobody has been given.
 *
 * ## What it refuses, and why each refusal is a refusal rather than a best effort
 *
 * - **Any state but `locked`**, and any run whose journal is non-empty. Import is not a merge: a
 *   run that has already been driven (or already imported) has evidence whose lineage this
 *   operation cannot extend without inventing dispatch numbering it never observed.
 * - **An Inspect / binary-judgment adapter.** Materialization demands native Inspect logs,
 *   summaries, and selection manifests for those runs, and a summary synthesized from a foreign
 *   dump would be a fabrication of exactly the artifact a skeptic reads to check the run.
 * - **`policy.evaluation.minVerdicts > 1`.** Fanning one external result into N evaluator legs
 *   would manufacture agreement between evaluators that never independently existed — the
 *   distinct-is-not-independent laundering `PRINCIPLES.md` forbids naming outright.
 */

import {
  expectedCellSet,
  parseBenchmark,
  parseRun,
} from "@jinn-network/benchmarking-records";
import type { DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import type { ExternalRunRecord } from "../intake/external-run-records.js";
import { readRunJournalEntries } from "../run/journal.js";
import {
  validateExternalRunRecords,
  writeExternalRunImport,
  type ExternalRunImportSource,
} from "../run/external-import.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { isInspectRuntimeAdapterId } from "../runtime/adapter.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface RunImportInput {
  readonly draftId: string;
  /** The normalized rows, in dump order (`readExternalRunRecords`). */
  readonly records: readonly ExternalRunRecord[];
  /** Where the results came from — sealed verbatim into the import declaration. */
  readonly source: ExternalRunImportSource;
  /** Directory a relative `evidence[].path` resolves against; normally the dump's own directory. */
  readonly evidenceRoot: string;
}

export interface RunImportResult {
  readonly draft: DraftDocument;
  /** The sealed `ExternalRunImportDeclaration` — the durable home for every imported reason. */
  readonly declarationSha256: string;
  readonly importedCellCount: number;
  /** Per-outcome counts of what was WRITTEN, not of what the Matrix will derive: the outcome is
   * `run.collect`'s to derive from this evidence, never this operation's to assert. */
  readonly written: {
    readonly graded: number;
    readonly ungradeable: number;
    readonly notDelivered: number;
  };
}

export function importRunRecords(
  context: OperationContext,
  input: RunImportInput,
): Promise<OperationResult<RunImportResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operateAsync({
    context: clockedContext,
    // Gated as "launch" — see the module header. Never a new GATED_OPERATIONS entry.
    action: "launch",
    subject: input.draftId,
    inputs: { draftId: input.draftId, source: input.source, rowCount: input.records.length },
    run: async () => {
      const { workspaceDir } = clockedContext;
      const document = readDraftDocument(workspaceDir, input.draftId);
      if (document.state !== "locked") {
        refuse(
          "illegal-transition",
          `drafts.${input.draftId}.state`,
          `draft ${input.draftId} is in state "${document.state}" — only a locked draft can be imported into`,
        );
      }
      if (document.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, `draft ${input.draftId} has no attached benchmark`);
      }
      const adapterId = document.spec.evaluationRuntime?.adapterId;
      if (adapterId !== undefined && isInspectRuntimeAdapterId(adapterId)) {
        refuse(
          "conflict",
          `drafts.${input.draftId}.evaluationRuntime`,
          `draft ${input.draftId} binds the "${adapterId}" runtime, whose bundle requires native `
            + "Inspect logs, summaries, and selection manifests. Those cannot be synthesized from "
            + "an external dump without fabricating the very artifacts a reader checks — import is "
            + "refused rather than approximated.",
        );
      }

      const runState = requireRunState(workspaceDir, input.draftId);
      if (runState.runSha256 === undefined || runState.closeAt === undefined) {
        refuse("conflict", `runs.${input.draftId}`, `draft ${input.draftId} has no sealed Run record yet — lock it first`);
      }
      const journal = readRunJournalEntries(workspaceDir, input.draftId);
      if (journal.length > 0) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          `draft ${input.draftId} already has ${journal.length} run-journal entries — import writes a `
            + "run's evidence from scratch and never merges into an existing lineage",
        );
      }

      const runRecord = parseRun(getSealedBytes(workspaceDir, runState.runSha256));
      const minVerdicts = runRecord.policy.evaluation?.minVerdicts ?? 1;
      if (minVerdicts > 1) {
        refuse(
          "conflict",
          `runs.${input.draftId}.policy.evaluation.minVerdicts`,
          `this Run pre-registered minVerdicts=${minVerdicts}, but an external dump carries one `
            + "result per slot. Splitting it across several evaluator legs would assert agreement "
            + "between evaluators that never independently existed.",
        );
      }
      const benchmarkSha256 = document.spec.taskSet.benchmarkSha256;
      const benchRecord = parseBenchmark(getSealedBytes(workspaceDir, benchmarkSha256));
      // Refuses with EVERY problem at once, and writes nothing, before the transition below.
      const plan = validateExternalRunRecords({
        records: input.records,
        benchmark: benchRecord,
        run: runRecord,
        benchmarkSha256: `sha256:${benchmarkSha256}`,
        runSha256: `sha256:${runState.runSha256}`,
      });
      // Guards a slate/expected-set drift that would otherwise surface much later as a collect
      // refusal; the validator already proves the correspondence, so this can only fail on a bug.
      if (plan.cells.length !== expectedCellSet(benchRecord, runRecord).length) {
        refuse("record-integrity", `runs.${input.draftId}`, "accepted import plan does not cover the expected cell set");
      }

      const transitioned = transition("locked", "launch");
      if (!transitioned.ok) {
        refuse("illegal-transition", `drafts.${input.draftId}.state`, transitioned.error.detail);
      }
      const draft: DraftDocument = { ...document, state: transitioned.state, updatedAt: at };
      atomicWriteFileSync(draftPath(workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
      writeRunState(workspaceDir, input.draftId, { ...runState, launchedAt: at });

      const written = await writeExternalRunImport({
        workspaceDir,
        draftId: input.draftId,
        plan,
        runRecord,
        owner: runState.owner,
        source: input.source,
        evidenceRoot: input.evidenceRoot,
        at,
      });

      writeRunState(workspaceDir, input.draftId, {
        ...requireRunState(workspaceDir, input.draftId),
        externalImportSha256: written.declarationSha256,
      });

      return {
        draft,
        declarationSha256: written.declarationSha256,
        importedCellCount: plan.cells.length,
        written: {
          graded: written.judged,
          ungradeable: written.unscorable,
          notDelivered: written.expired,
        },
      };
    },
  });
}
