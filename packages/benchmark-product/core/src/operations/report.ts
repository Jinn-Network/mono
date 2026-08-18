/**
 * `report` (spec §4.1: closed --report--> reported, GATED — spec §4.1's approval-gated table,
 * `../authority/policy.ts`'s `GATED_OPERATIONS`): produces this run's sealed Report record and
 * its claim package from the closed run's own sealed Matrix, via
 * `@jinn-network/benchmarking-aggregate`'s `produceReport`.
 *
 * `produceReport` recomputes whichever method the sealed Run's own `analysisPlan` selected — from
 * exact subject bytes and resolved referenced records (this workspace's own sealed-bytes store,
 * via `../report/ports.ts`'s `buildMethodPorts`) — this module never computes results itself, it
 * only supplies the exact inputs and stores what comes back. `../run/compile.ts`'s
 * `buildAnalysisPlan` seals `[wilson]` or `[wilson, selected]`; this operation reads the LAST
 * entry (the selected method when present, wilson otherwise) and passes its EXACT sealed
 * `parameters` straight through. Passing that identical tuple is what makes
 * `derivePreregistered`'s exact-JSON comparison succeed, deriving `preregistered: true` for a
 * genuinely pre-registered analysis rather than merely a matching-by-accident one — selecting the
 * method is a pure read of the already-sealed Run, so it changes nothing about which analysis
 * runs, only which one this operation asks the platform to recompute.
 *
 * The Report is signed with a SEPARATE workspace key from the venue's verdict-signing key (see
 * `../report/signing.ts`'s module header for why) — this operation loads or creates it, same as
 * every other workspace-held key in this product, on first use.
 *
 * Ordering (crash safety): the draft's `closed` -> `reported` transition (`atomicWriteFileSync`
 * of `draftPath`) is the one NON-REPLAYABLE write in this operation — the lifecycle table only
 * admits `report` from `"closed"`, so once that write lands there is no way back to a state that
 * lets a retried `report` run again. Every other write here is either pure, or an idempotent
 * overwrite that a retry reproduces identically (or refreshes): `putSealedBytes` is content-
 * addressed (re-putting the same bytes is a no-op), and `writeRunState` simply overwrites. So all
 * fallible work — `produceReport`, sealing the Report bytes, building AND writing the claim
 * package (`buildClaimPackage`'s results-shape guard, `ClaimPackageSchema.parse`, the disk write)
 * — runs FIRST, and the draft transition runs LAST. A crash anywhere before that final write
 * leaves the draft "closed" and `report` fully retryable; a crash after it leaves "reported" with
 * every other artifact already in place, since nothing follows the transition.
 *
 * BP-20 (spec §7.2, "preview = disclosed rehearsal"): "When any preview of a benchmark preceded
 * the official run, the official report's limitations name that fact." A preview is refused once
 * a draft is locked (`../operations/preview.ts`'s transition guard), so every entry in this
 * draft's preview log necessarily precedes THIS run's lock by construction — reading the log here
 * is a pure fact-lookup about already-finalized history, not a judgment call this module makes.
 * That read, and the resulting `limitations`/`previewDisclosure` input plumbing, happen entirely
 * before `produceReport` — pure reads and pure input construction, so they change nothing about
 * the crash-safety ordering above.
 */

import { BENCHMARKING_METHOD_IDS, parseMatrix, parseRun } from "@jinn-network/benchmarking-records";
import { produceReport, type ProducedReport } from "@jinn-network/benchmarking-aggregate";
import { join } from "node:path";
import { resolveAssurance, type DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { buildClaimPackage, writeClaimPackage, type ClaimPackage } from "../report/claim.js";
import { buildMethodPorts } from "../report/ports.js";
import {
  inspectRuntimeMethodForBinding,
  type InspectRuntimeMethodDisclosure,
} from "../runtime/inspect/disclosure.js";
import {
  deriveInspectEvaluationStrategy,
  INSPECT_SEPARATE_ASSURANCE_LIMITATIONS,
} from "../runtime/inspect/assurance.js";
import { INSPECT_ADAPTER_ID } from "../runtime/inspect/manifest.js";
import { createReportDsseSigner, loadOrCreateReportSigningKey } from "../report/signing.js";
import { previewDisclosureLine, readPreviewLog } from "../run/preview-log.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";
import { buildLocalVenueHonesty, localVenueLimitsForRun } from "./run-results.js";
import { binaryInstrumentReportLimitations } from "../run/binary-instrument-profile.js";
import { HarborSelectionManifestSchema } from "../runtime/harbor/manifest.js";
import { harborArmJobName } from "../runtime/harbor/launcher.js";
import { harborArmJobsDir } from "../runtime/harbor/arm-job.js";
import { suiteFactsFromAccountedRun } from "../runtime/suite-protocol/from-harbor.js";
import { readInspectAsSpecifiedSelectionManifest } from "../runtime/inspect/host.js";
import { suiteFactsFromAccountedInspectRun } from "../runtime/suite-protocol/from-inspect.js";

export interface RunReportInput {
  readonly draftId: string;
}

export interface RunReportResult {
  readonly draft: DraftDocument;
  /** Exact legacy Report v1 payload and envelope identities. */
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
  readonly preregistered: boolean;
  readonly claimPackage: ClaimPackage;
  readonly runtimeMethod?: InspectRuntimeMethodDisclosure;
}

/** The report's verb string for the claim package's `verification.command`. */
const VERIFICATION_VERB = "verify";

const PAIRED_ESTIMATE_LIMITATION =
  "This method estimates an effect; it does not gate one — no verdict, threshold, or selection was registered.";

export function runReport(
  context: OperationContext,
  input: RunReportInput,
): Promise<OperationResult<RunReportResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operateAsync({
    context: clockedContext,
    action: "report",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      if (document.state !== "closed") {
        refuse(
          "illegal-transition",
          `drafts.${input.draftId}.state`,
          `draft ${input.draftId} is in state "${document.state}" — only a closed draft can be reported`,
        );
      }
      if (document.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, `draft ${input.draftId} has no attached benchmark`);
      }
      const runState = requireRunState(clockedContext.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined || runState.matrixSha256 === undefined) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          `draft ${input.draftId} has no sealed Matrix yet — run collect first`,
        );
      }
      const runSha256 = runState.runSha256;
      const matrixSha256 = runState.matrixSha256;

      const matrixBytes = getSealedBytes(clockedContext.workspaceDir, matrixSha256);
      const matrixRecord = parseMatrix(matrixBytes);
      const runRecord = parseRun(getSealedBytes(clockedContext.workspaceDir, runState.runSha256));
      const runtimeMethod = inspectRuntimeMethodForBinding(
        clockedContext.workspaceDir,
        document.spec.evaluationRuntime,
        runRecord.policy.evaluation,
      );

      const resolvedAssurance = resolveAssurance(document.spec.assurance);
      const verdictRule = resolvedAssurance.verdictRule;
      const ports = buildMethodPorts(clockedContext.workspaceDir);
      const reportKey = loadOrCreateReportSigningKey(clockedContext.workspaceDir);
      const signer = createReportDsseSigner(reportKey);

      // The sealed plan is [wilson] or [wilson, selected] (see run/compile.ts's buildAnalysisPlan).
      // The selected method is the last entry; passing its EXACT sealed parameters is what makes
      // derivePreregistered's exact-JSON comparison succeed.
      const planEntries = runRecord.analysisPlan ?? [];
      const selected = planEntries[planEntries.length - 1];
      if (selected === undefined) {
        refuse("record-integrity", "run", "sealed Run carries no analysisPlan entry to report from");
      }

      // BP-20 (spec §7.2): a pure read of this draft's own preview log — every logged preview
      // necessarily precedes this run's lock (module header). `previewed` is `undefined`'s own
      // presence check narrowed alongside `count > 0`, so both branches below can trust
      // `previewLog` is defined wherever they read it.
      const previewLog = readPreviewLog(clockedContext.workspaceDir, input.draftId);
      const previewLimitation = previewLog !== undefined && previewLog.count > 0
        ? previewDisclosureLine(previewLog)
        : undefined;
      const venueLimits = localVenueLimitsForRun(runRecord);
      const inspectLimits = document.spec.evaluationRuntime?.adapterId === INSPECT_ADAPTER_ID
        && deriveInspectEvaluationStrategy(runRecord.policy.evaluation) === "separate-log-verification"
        ? INSPECT_SEPARATE_ASSURANCE_LIMITATIONS
        : [];
      const suiteFacts = document.spec.evaluationRuntime?.adapterId === "harbor"
        ? suiteFactsFromAccountedRun({
          manifest: HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
          armCount: runRecord.arms.length,
          itemCount: new Set(matrixRecord.cells.map((cell) => cell.taskDigest)).size,
          replicates: runRecord.replicates,
          matrix: matrixRecord,
          armJobs: document.spec.arms.map((arm) => ({
            armId: arm.armId,
            jobDir: join(harborArmJobsDir(clockedContext.workspaceDir, runSha256), harborArmJobName(runSha256, arm.armId)),
          })),
        })
        : document.spec.evaluationRuntime?.adapterId === INSPECT_ADAPTER_ID
          ? (() => {
            const manifest = readInspectAsSpecifiedSelectionManifest(
              clockedContext.workspaceDir,
              document.spec.evaluationRuntime.selectionManifestSha256,
            );
            return manifest === undefined
              ? undefined
              : suiteFactsFromAccountedInspectRun({
                manifest,
                armCount: runRecord.arms.length,
                itemCount: new Set(matrixRecord.cells.map((cell) => cell.taskDigest)).size,
                replicates: runRecord.replicates,
                matrix: matrixRecord,
                armIds: document.spec.arms.map((arm) => arm.armId),
              });
          })()
          : undefined;
      const suiteLimits = suiteFacts?.limitation === undefined ? [] : [suiteFacts.limitation];
      let binaryLimits: readonly string[] = [];
      if (selected.method === BENCHMARKING_METHOD_IDS.binaryInstrument) {
        try {
          binaryLimits = binaryInstrumentReportLimitations(selected.parameters);
        } catch (cause) {
          refuse(
            "record-integrity",
            "run.analysisPlan",
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      }
      const limitations = selected.method === BENCHMARKING_METHOD_IDS.pairedDelta
        ? [
            ...venueLimits,
            ...inspectLimits,
            ...suiteLimits,
            PAIRED_ESTIMATE_LIMITATION,
            ...(previewLimitation === undefined ? [] : [previewLimitation]),
          ]
        : previewLimitation === undefined
          ? [...venueLimits, ...inspectLimits, ...binaryLimits, ...suiteLimits]
          : [...venueLimits, ...inspectLimits, ...binaryLimits, ...suiteLimits, previewLimitation];

      let produced: ProducedReport;
      try {
        produced = await produceReport(
          {
            ...ports,
            subjects: [matrixBytes],
            method: { id: selected.method, version: selected.version, parameters: selected.parameters },
            verdictRule,
            limitations,
            author: runState.owner,
          },
          signer,
        );
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        refuse(
          "record-integrity",
          "report",
          `the stored records do not survive the platform's own exactness checks: ${detail}`,
        );
      }

      // Step 2: seal the Report payload + envelope bytes. Content-addressed and idempotent —
      // safe to do before the irreversible transition (see module header).
      const reportSha256 = putSealedBytes(clockedContext.workspaceDir, produced.bytes);
      const reportEnvelopeSha256 = putSealedBytes(clockedContext.workspaceDir, produced.envelope);

      // Step 3: build AND write the claim package. Both can throw (a results-shape mismatch in
      // buildClaimPackage, a schema violation or disk failure in writeClaimPackage) — that must
      // surface here, before the draft is transitioned, not after.
      const venueHonesty = buildLocalVenueHonesty(matrixRecord.cells, runRecord);

      const claimPackage = buildClaimPackage({
        draftId: input.draftId,
        benchmarkSha256: document.spec.taskSet.benchmarkSha256,
        runRecord,
        runSha256: runState.runSha256,
        matrixRecord,
        matrixSha256: runState.matrixSha256,
        reportRecord: produced.record,
        reportSha256,
        reportEnvelopeSha256,
        venueHonesty,
        verificationCommandVerb: VERIFICATION_VERB,
        // BP-21 (spec §6): the claim states the preset AND the resolved primitives, never the
        // label alone; buildClaimPackage cross-checks these against the sealed Run's own policy.
        assurance: { preset: document.spec.assurance.preset, resolved: resolvedAssurance },
        ...(previewLog !== undefined && previewLog.count > 0
          ? { previewDisclosure: { previewCount: previewLog.count, timestamps: previewLog.previews.map((preview) => preview.at) } }
          : {}),
        ...(suiteFacts === undefined ? {} : {
          suiteComparability: {
            executionConformance: suiteFacts.quote.executionConformance,
            coverage: suiteFacts.quote.coverage,
            leaderboardSubmitReady: suiteFacts.quote.leaderboardSubmitReady,
          },
        }),
      });
      writeClaimPackage(clockedContext.workspaceDir, input.draftId, claimPackage);

      // Step 4: RunState is an idempotent overwrite too — still before the irreversible
      // transition, so a retried `report` after a crash here simply rewrites it identically.
      writeRunState(clockedContext.workspaceDir, input.draftId, {
        ...runState,
        reportSha256,
        reportEnvelopeSha256,
        reportedAt: at,
      });

      // Step 5: LAST — the one non-replayable write. Everything above is either pure or an
      // idempotent overwrite, so a crash before this line leaves the draft "closed" (fully
      // retryable); nothing follows this line, so a crash after it leaves every other artifact
      // already in place.
      const transitioned = transition("closed", "report");
      if (!transitioned.ok) {
        // Unreachable given the state guard above — kept so a future TRANSITIONS edit fails
        // loud here instead of silently reporting a state the table no longer permits.
        refuse("illegal-transition", `drafts.${input.draftId}.state`, transitioned.error.detail);
      }
      const draft: DraftDocument = { ...document, state: transitioned.state, updatedAt: at };
      atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));

      return {
        draft,
        reportSha256,
        reportEnvelopeSha256,
        preregistered: produced.record.preregistered ?? false,
        claimPackage,
        ...(runtimeMethod === undefined ? {} : { runtimeMethod }),
      };
    },
  });
}
