/**
 * `report` (spec §4.1: closed --report--> reported, GATED — spec §4.1's approval-gated table,
 * `../authority/policy.ts`'s `GATED_OPERATIONS`): produces this run's sealed Report record and
 * its claim package from the closed run's own sealed Matrix, via
 * `@jinn-network/benchmarking-aggregate`'s `produceReport`.
 *
 * `produceReport` recomputes whichever method the sealed Run's own `analysisPlan` names — from
 * exact subject bytes and resolved referenced records (this workspace's own sealed-bytes store,
 * via `../report/ports.ts`'s `buildMethodPorts`) — this module never computes results itself, it
 * only supplies the exact inputs and stores what comes back. `../run/compile.ts`'s
 * `buildAnalysisPlan` seals `[wilson]` or `[wilson, primary]`, plus every pre-registered
 * `additionalAnalyses` entry appended after that (packet P5, spec §8.3 option 5). This operation
 * locates the primary entry by identity (`primaryAnalysisPlanLength`, not a raw last-index — kept
 * in lockstep with `publication-report.ts`'s own selection) and passes its EXACT sealed
 * `parameters` straight through, same as it always did; every additional entry gets the identical
 * treatment. Passing each entry's identical tuple is what makes `derivePreregistered`'s exact-JSON
 * comparison succeed, deriving `preregistered: true` for a genuinely pre-registered analysis
 * rather than merely a matching-by-accident one — selecting a method is a pure read of the
 * already-sealed Run, so it changes nothing about which analysis runs, only which ones this
 * operation asks the platform to recompute.
 *
 * **One `report` invocation emits ONE sealed Report record per plan entry it selects** — the
 * canonical first (the primary entry, exactly what this operation produced before
 * `additionalAnalyses` existed) plus one per additional entry, all in this single invocation, all
 * before the ONE `closed → reported` transition. Each Report is single-method (no records-schema
 * change); each gets its own Claim package at its own path (`report/claim.ts`'s
 * `writeClaimPackage`/`additionalClaimPackagePath`).
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
 * for EVERY plan entry this invocation selects — runs FIRST, and the draft transition runs LAST.
 * A crash anywhere before that final write leaves the draft "closed" and `report` fully retryable
 * (every prior write is idempotent, so a retry simply redoes the same work); a crash after it
 * leaves "reported" with every other artifact already in place, since nothing follows the
 * transition.
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
import { readRunAnchorCarriage } from "../anchor/carriage.js";
import { join } from "node:path";
import { resolveAssurance, type DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import {
  DISCLOSURE_SPECIFICATION_EXTENSION,
  DISCLOSURE_SPECIFICATION_MEDIA_TYPE,
} from "@jinn-network/benchmarking-records";
import { readRunDisclosureCarriage } from "../disclosure/carriage.js";
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
import { primaryAnalysisPlanLength } from "../run/compile.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";
import { buildLocalVenueHonesty, localVenueLimitsForRun } from "./run-results.js";
import { binaryInstrumentReportLimitations } from "../run/binary-instrument-profile.js";
import { HarborSelectionManifestSchema, isHarborCompatibleEvaluationRuntime } from "../runtime/harbor/manifest.js";
import { harborArmJobName } from "../runtime/harbor/launcher.js";
import { harborArmJobsDir } from "../runtime/harbor/arm-job.js";
import { suiteFactsFromAccountedRun } from "../runtime/suite-protocol/from-harbor.js";
import { suiteFactsFromAccountedSwebenchRun } from "../runtime/suite-protocol/from-swebench.js";
import { suiteFactsFromAccountedApexRun } from "../runtime/suite-protocol/from-apex.js";
import { APEX_SWE_DEV_ADAPTER_ID, ApexSweDevSelectionManifestSchema } from "../runtime/apex-swe-dev/manifest.js";
import { apexSweDevReportRoot } from "../runtime/apex-swe-dev/launcher.js";
import { suiteFactsFromAccountedApexSweDevRun } from "../runtime/suite-protocol/from-apex-swe-dev.js";
import { resolveSwebenchHarnessRunId, swebenchModelNameOrPathByArm } from "../runtime/swe-bench-verified/launcher.js";
import { SwebenchVerifiedSelectionManifestSchema } from "../runtime/swe-bench-verified/manifest.js";
import { ApexAgentsSelectionManifestSchema } from "../runtime/apex-agents/manifest.js";
import { readInspectEvalSelectionManifest } from "../runtime/inspect/host.js";
import { suiteFactsFromAccountedInspectRun } from "../runtime/suite-protocol/from-inspect.js";
import { artifactsDir } from "../workspace/layout.js";

export interface RunReportInput {
  readonly draftId: string;
}

/** One additional non-canonical Report this invocation sealed (packet P5, spec §8.3 option 5) —
 * one per `additionalAnalyses` plan entry, in plan order. */
export interface AdditionalRunReportResult {
  readonly method: string;
  readonly version: string;
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
  readonly preregistered: boolean;
  readonly claimPackage: ClaimPackage;
}

export interface RunReportResult {
  readonly draft: DraftDocument;
  /** Exact legacy Report v1 payload and envelope identities — the CANONICAL first report: the
   * primary plan entry's own identities, exactly what this operation always produced before
   * `additionalAnalyses` existed. */
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
  readonly preregistered: boolean;
  readonly claimPackage: ClaimPackage;
  /** N-1 additional sealed Reports, one per `additionalAnalyses` plan entry, in plan order.
   * Absent when this draft registered none (packet P5, spec §8.3 option 5). */
  readonly additionalReports?: readonly AdditionalRunReportResult[];
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
      // Captured as a local const (rather than read off `document.spec.taskSet` again below) so
      // the "benchmark" narrowing above survives into `sealReportEntry`'s nested closure, which
      // TS does not otherwise propagate narrowing into.
      const benchmarkSha256 = document.spec.taskSet.benchmarkSha256;
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

      // The sealed plan is the primary plan ([wilson] or [wilson, primary] — see
      // run/compile.ts's buildAnalysisPlan) plus, when this draft pre-registered them, every
      // additionalAnalyses entry appended after it (packet P5, spec §8.3 option 5). The primary
      // entry is the one this operation always selected before additionalAnalyses existed —
      // located by identity via primaryAnalysisPlanLength, kept in lockstep with
      // publication-report.ts's own selection — and passing its EXACT sealed parameters is what
      // makes derivePreregistered's exact-JSON comparison succeed. Every additional entry gets the
      // identical treatment, one sealed Report each, all in this one `report` invocation.
      const planEntries = runRecord.analysisPlan ?? [];
      const primaryPlanLength = primaryAnalysisPlanLength(document.spec);
      const primarySelected = planEntries[primaryPlanLength - 1];
      if (primarySelected === undefined) {
        refuse("record-integrity", "run", "sealed Run carries no analysisPlan entry to report from");
      }
      // The identity assertion the comment above promises (M1). `primaryAnalysisPlanLength` derives
      // an INDEX from the draft's own shape; without this check "located by identity" would be a
      // claim about intent rather than about what the code does, and a plan whose primary entry had
      // drifted from the draft's declared `analysis` would be reported from silently. The draft's
      // `analysis` is optional, so an absent one has no identity to check against and is skipped.
      const declaredPrimary = document.spec.analysis;
      if (
        declaredPrimary !== undefined
        && (primarySelected.method !== declaredPrimary.method || primarySelected.version !== declaredPrimary.version)
      ) {
        refuse(
          "record-integrity",
          "run.analysisPlan",
          `sealed Run's primary analysisPlan entry is ${primarySelected.method}@${primarySelected.version},`
          + ` not the draft's declared primary analysis ${declaredPrimary.method}@${declaredPrimary.version}`,
        );
      }
      const additionalSelected = planEntries.slice(primaryPlanLength);
      type SealedAnalysisPlanEntry = (typeof planEntries)[number];

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
      const suiteFacts = isHarborCompatibleEvaluationRuntime(document.spec.evaluationRuntime)
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
        : document.spec.evaluationRuntime?.adapterId === "swebench-harness"
          ? suiteFactsFromAccountedSwebenchRun({
            manifest: SwebenchVerifiedSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
            armCount: runRecord.arms.length,
            itemCount: new Set(matrixRecord.cells.map((cell) => cell.taskDigest)).size,
            replicates: runRecord.replicates,
            matrix: matrixRecord,
            armIds: document.spec.arms.map((arm) => arm.armId),
            reportRoot: join(artifactsDir(clockedContext.workspaceDir), "swebench-harness", input.draftId),
            runId: resolveSwebenchHarnessRunId(join(artifactsDir(clockedContext.workspaceDir), "swebench-harness", input.draftId), runSha256),
            modelNameOrPathByArm: swebenchModelNameOrPathByArm(document.spec.arms),
          })
          : document.spec.evaluationRuntime?.adapterId === "archipelago"
            ? suiteFactsFromAccountedApexRun({
              manifest: ApexAgentsSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
              armCount: runRecord.arms.length,
              itemCount: new Set(matrixRecord.cells.map((cell) => cell.taskDigest)).size,
              replicates: runRecord.replicates,
              matrix: matrixRecord,
              armIds: document.spec.arms.map((arm) => arm.armId),
              reportRoot: join(artifactsDir(clockedContext.workspaceDir), "archipelago", input.draftId),
            })
          : document.spec.evaluationRuntime?.adapterId === APEX_SWE_DEV_ADAPTER_ID
            ? suiteFactsFromAccountedApexSweDevRun({
              manifest: ApexSweDevSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
              armCount: runRecord.arms.length,
              itemCount: new Set(matrixRecord.cells.map((cell) => cell.taskDigest)).size,
              replicates: runRecord.replicates,
              matrix: matrixRecord,
              armIds: document.spec.arms.map((arm) => arm.armId),
              reportRoot: apexSweDevReportRoot(artifactsDir(clockedContext.workspaceDir), input.draftId),
            })
            : document.spec.evaluationRuntime?.adapterId === INSPECT_ADAPTER_ID
              ? (() => {
                const manifest = readInspectEvalSelectionManifest(
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

      // anchor-evidence §7.4: the claim is the report-time projection, so its anchors section is
      // exactly the set this run had already obtained. Anchoring is expected to complete before
      // `report` — a lock anchor precedes launch by rule (§7.1), and a matrix anchor or an
      // OpenTimestamps upgrade is available from `closed` on. An anchor obtained after this point
      // stays durably recorded and audited, but this sealed claim predates it, and `publish` says
      // so rather than silently reprojecting a document the operator already read. Computed once —
      // method-independent, so every entry's claim package shares it.
      const carriage = readRunAnchorCarriage(clockedContext.workspaceDir, runState);
      const venueHonesty = buildLocalVenueHonesty(matrixRecord.cells, runRecord, carriage.anchors);
      // issue #2839: the sealed disclosure declaration, if this run has one. Read once for the same
      // reason the anchors are -- it is method-independent, so every entry's Report carries the same
      // extension and every entry's claim the same section. Absent for every run that never
      // declared, which is what keeps existing Reports and claims byte-identical.
      const disclosureCarriage = readRunDisclosureCarriage(clockedContext.workspaceDir, runState);

      interface SealedReportEntry {
        readonly method: string;
        readonly version: string;
        readonly reportSha256: string;
        readonly reportEnvelopeSha256: string;
        readonly preregistered: boolean;
        readonly claimPackage: ClaimPackage;
      }

      /**
       * Produces, seals, and claims ONE plan entry (packet P5, spec §8.3 option 5): the shared
       * per-run pieces above (venue/inspect/suite limits, anchors, venue honesty) are computed
       * once; only the method-specific limitations (binary-instrument's own, or the paired-delta
       * estimate disclaimer) vary per entry. Every step here is pure or an idempotent
       * content-addressed write, so looping it over N entries before the ONE non-replayable
       * transition (below) keeps `report` single-shot exactly as it was before this feature
       * existed (module header).
       */
      async function sealReportEntry(
        entry: SealedAnalysisPlanEntry,
        selector?: { readonly method: string; readonly version: string },
      ): Promise<SealedReportEntry> {
        let binaryLimits: readonly string[] = [];
        if (entry.method === BENCHMARKING_METHOD_IDS.binaryInstrument) {
          try {
            binaryLimits = binaryInstrumentReportLimitations(entry.parameters);
          } catch (cause) {
            refuse(
              "record-integrity",
              "run.analysisPlan",
              cause instanceof Error ? cause.message : String(cause),
            );
          }
        }
        // paired-majority-delta@1 carries the same PAIRED_ESTIMATE_LIMITATION as paired-delta@1
        // (coordinator ruling, packet #2837): the line describes the method's SHAPE -- an
        // estimator rather than a gate -- not its unit, and both methods are estimators. The
        // withheld-interval case (fewer than 5 paired tasks, or fewer than two source clusters)
        // gets NO extra limitation line here: §7.2's frozen reporting rule makes the withholding a
        // registry-verified OUTPUT already printed from the method's own `reasons`, explicitly
        // "not a gap" -- a disclosure line here would publish that same fact at a second
        // disclosure level.
        const limitations = entry.method === BENCHMARKING_METHOD_IDS.pairedDelta
          || entry.method === BENCHMARKING_METHOD_IDS.pairedMajorityDelta
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
              method: { id: entry.method, version: entry.version, parameters: entry.parameters },
              verdictRule,
              limitations,
              author: runState.owner,
              // The extension's digest has to be INSIDE the signed payload for the report author's
              // signature to cover the record (design §6.3), so it is supplied here, before sealing,
              // rather than added to a sealed document afterwards.
              ...(disclosureCarriage === undefined ? {} : {
                recordExtensions: {
                  [DISCLOSURE_SPECIFICATION_EXTENSION]: {
                    name: "disclosure-specification",
                    mediaType: DISCLOSURE_SPECIFICATION_MEDIA_TYPE,
                    digest: { sha256: disclosureCarriage.recordSha256 },
                  },
                },
              }),
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

        // Seal the Report payload + envelope bytes. Content-addressed and idempotent — safe to do
        // before the irreversible transition (see module header).
        const reportSha256 = putSealedBytes(clockedContext.workspaceDir, produced.bytes);
        const reportEnvelopeSha256 = putSealedBytes(clockedContext.workspaceDir, produced.envelope);

        // Build AND write the claim package. Both can throw (a results-shape mismatch in
        // buildClaimPackage, a schema violation or disk failure in writeClaimPackage) — that must
        // surface here, before the draft is transitioned, not after.
        const claimPackage = buildClaimPackage({
          draftId: input.draftId,
          benchmarkSha256,
          runRecord,
          runSha256,
          matrixRecord,
          matrixSha256,
          reportRecord: produced.record,
          reportSha256,
          reportEnvelopeSha256,
          venueHonesty,
          verificationCommandVerb: VERIFICATION_VERB,
          // BP-21 (spec §6): the claim states the preset AND the resolved primitives, never the
          // label alone; buildClaimPackage cross-checks these against the sealed Run's own policy.
          assurance: {
            preset: document.spec.assurance.preset,
            resolved: {
              independence: resolvedAssurance.independence,
              minVerdicts: resolvedAssurance.minVerdicts,
              distinctEvaluator: resolvedAssurance.distinctEvaluator,
              verdictRule: resolvedAssurance.verdictRule,
            },
          },
          ...(carriage.anchoredClosure ? { anchors: carriage.anchors } : {}),
          ...(disclosureCarriage === undefined ? {} : { disclosure: disclosureCarriage.disclosure }),
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
        writeClaimPackage(clockedContext.workspaceDir, input.draftId, claimPackage, selector);

        return {
          method: entry.method,
          version: entry.version,
          reportSha256,
          reportEnvelopeSha256,
          preregistered: produced.record.preregistered ?? false,
          claimPackage,
        };
      }

      const primaryResult = await sealReportEntry(primarySelected);
      const additionalResults: SealedReportEntry[] = [];
      for (const entry of additionalSelected) {
        additionalResults.push(await sealReportEntry(entry, { method: entry.method, version: entry.version }));
      }

      // Step 4: RunState is an idempotent overwrite too — still before the irreversible
      // transition, so a retried `report` after a crash here simply rewrites it identically. The
      // canonical singular pair below stays the primary entry's identities, exactly as before
      // additionalAnalyses existed; the N-1 additional identities are additive siblings keyed by
      // (method, version) (packet P5, `run/state.ts`).
      writeRunState(clockedContext.workspaceDir, input.draftId, {
        ...runState,
        reportSha256: primaryResult.reportSha256,
        reportEnvelopeSha256: primaryResult.reportEnvelopeSha256,
        reportedAt: at,
        ...(additionalResults.length === 0
          ? {}
          : {
              additionalReports: additionalResults.map((entry) => ({
                method: entry.method,
                version: entry.version,
                reportSha256: entry.reportSha256,
                reportEnvelopeSha256: entry.reportEnvelopeSha256,
              })),
            }),
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
        reportSha256: primaryResult.reportSha256,
        reportEnvelopeSha256: primaryResult.reportEnvelopeSha256,
        preregistered: primaryResult.preregistered,
        claimPackage: primaryResult.claimPackage,
        ...(additionalResults.length === 0 ? {} : { additionalReports: additionalResults }),
        ...(runtimeMethod === undefined ? {} : { runtimeMethod }),
      };
    },
  });
}
