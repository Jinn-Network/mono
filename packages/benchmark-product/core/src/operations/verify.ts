/**
 * `run.verify` (BP-13 deliverable 3, spec §7.1/§12.1): the skeptic's independent check — an
 * UNGATED read any workspace member can invoke (not in `../authority/policy.ts`'s
 * `GATED_OPERATIONS`), and NON-ADVANCING: it never touches draft state or RunState. Where
 * `report` (`./report.ts`) is the author computing and sealing a claim, `verify` is the read path
 * that recomputes it from the workspace's own durable state and refuses to agree with anything it
 * cannot itself re-derive.
 *
 * Three checks, run in order, each named in the returned `checks` list:
 *
 * 1. `matrix-rederivation` — always run once a Matrix is sealed. Rebuilds `expected`
 *    (`expectedCellSet`), the run-journal fold, admission receipts, and the exact assembly ports
 *    through the SHARED `../run/assembly-ports.ts` construction (see that module's own header:
 *    one shared implementation is the only construction that cannot drift from what `run.collect`
 *    built), then calls `@jinn-network/benchmarking-run`'s `verifyMatrix` to byte-compare the
 *    re-derived Matrix against the sealed one. `getSealedBytes` itself re-verifies every
 *    referenced record's digest on read (`../workspace/sealed-store.ts`) — a corrupted-in-place
 *    record surfaces as ITS OWN typed `record-integrity` refusal naming the store path, before
 *    this module ever gets a chance to re-derive anything. That is part of the skeptic story this
 *    operation tells, not a gap in it: two independent layers (the store's own digest check, and
 *    this module's re-derivation) each catch a different class of tamper.
 * 2. `report-verification` — only when the RunState carries a sealed Report envelope. Calls
 *    `@jinn-network/benchmarking-aggregate`'s `verifyReport` over the workspace's own method ports
 *    (`../report/ports.ts`) and workspace-local trust deps (`../report/trust.ts` — see that
 *    module's header for the local-trust-root caveat this inherits unchanged: a passing check
 *    proves the Report was signed by this workspace's own key, nothing more).
 * 3. `claim-consistency` — only alongside `report-verification`. Reads the claim package artifact
 *    (`../report/claim.ts`) and checks every figure it carries against the records this operation
 *    just independently verified, refusing on the first field that disagrees. A claim package
 *    that quietly drifted from its own cited records — the exact failure mode `../report/claim.ts`'s
 *    own header calls out as "worse than one that failed to build" — is caught here, after the
 *    fact, by a party other than whoever built it.
 */

import { readFileSync } from "node:fs";
import {
  expectedCellSet,
  parseBenchmark,
  parseMatrix,
  parseRun,
  type ReportRecord,
} from "@jinn-network/benchmarking-records";
import { evaluateIntegrityAnchors } from "@colophon-claims/verify";
import { verifyMatrix } from "@jinn-network/benchmarking-run";
import { verifyReport } from "@jinn-network/benchmarking-aggregate";
import { readRunAnchorCarriage } from "../anchor/carriage.js";
import { readRunDisclosureCarriage } from "../disclosure/carriage.js";
import { refuse } from "../errors.js";
import { additionalClaimPackagePath, ClaimPackageSchema } from "../report/claim.js";
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
import { join } from "node:path";
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
import { buildWorkspaceTrustDeps } from "../report/trust.js";
import { scanPredictionSnapshotAdmissionReceipts } from "../run/admission-receipts.js";
import { buildRunAssemblyPorts } from "../run/assembly-ports.js";
import { foldRunJournal, readRunJournalEntries } from "../run/journal.js";
import { readPreviewLog } from "../run/preview-log.js";
import { requireRunState } from "../run/state.js";
import { artifactsDir, claimPackageArtifactPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { assertClaimConsistency } from "../verification/claim-consistency.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface RunVerifyInput {
  readonly draftId: string;
}

export type RunVerifyCheck =
  | "matrix-rederivation"
  | "report-verification"
  | "claim-consistency"
  /** Only for a run on the anchored closure — one that carries an anchor, or whose sealed Run
   * declared anchoring intent (anchor-evidence design §8). The same shared implementation the
   * portable reader runs, over this workspace's own sealed anchor bytes. */
  | "integrity-anchors";

/** One additional sealed Report this invocation also independently verified (packet P5, spec §8.3
 * option 5) — one per `runState.additionalReports` entry. It passed the SAME report-verification +
 * claim-consistency checks the canonical Report did; `checks` records the check KINDS that ran
 * (once), not a per-report tally — a `claim-consistency: ok` in `checks` means every sealed Report
 * this run carries passed it, not merely the canonical one. */
export interface AdditionalRunVerifyResult {
  readonly method: string;
  readonly version: string;
  readonly reportEnvelopeSha256: string;
}

export interface RunVerifyResult {
  readonly draftId: string;
  /** The checks actually performed, in order — `["matrix-rederivation"]` for a closed-but-not-yet-
   * reported run, all three for a reported one. */
  readonly checks: readonly RunVerifyCheck[];
  readonly matrixSha256: string;
  /** The CANONICAL first Report's envelope identity — the one this operation always verified
   * before `additionalAnalyses` existed. */
  readonly reportEnvelopeSha256?: string;
  /** N-1 additional sealed Reports this invocation also verified, in plan order. Absent when this
   * run's Report has no additional siblings (packet P5, spec §8.3 option 5). */
  readonly additionalReports?: readonly AdditionalRunVerifyResult[];
  readonly runtimeMethod?: InspectRuntimeMethodDisclosure;
}

export async function verifyRunWorkspace(
  context: OperationContext,
  input: RunVerifyInput,
): Promise<RunVerifyResult> {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      if (document.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, `draft ${input.draftId} has no attached benchmark`);
      }
      // Captured as a local const so the "benchmark" narrowing above survives into
      // `verifyOneReport`'s nested closure below, which TS does not otherwise propagate into.
      const benchmarkSha256 = document.spec.taskSet.benchmarkSha256;

      const runState = requireRunState(context.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined || runState.matrixSha256 === undefined) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          `draft ${input.draftId} has no sealed Matrix yet — nothing to verify — run collect first`,
        );
      }
      const runSha256 = runState.runSha256;
      const matrixSha256 = runState.matrixSha256;
      const runRecord = parseRun(getSealedBytes(context.workspaceDir, runSha256));
      const runtimeMethod = inspectRuntimeMethodForBinding(
        context.workspaceDir,
        document.spec.evaluationRuntime,
        runRecord.policy.evaluation,
      );

      const checks: RunVerifyCheck[] = [];

      // ── 1. matrix-rederivation ───────────────────────────────────────────────────────────
      const matrixBytes = getSealedBytes(context.workspaceDir, matrixSha256);
      const matrixRecord = parseMatrix(matrixBytes);
      const benchRecord = parseBenchmark(getSealedBytes(context.workspaceDir, document.spec.taskSet.benchmarkSha256));
      const expected = expectedCellSet(benchRecord, runRecord);
      const fold = foldRunJournal(readRunJournalEntries(context.workspaceDir, input.draftId));
      const receiptsByTaskDigest = scanPredictionSnapshotAdmissionReceipts(context.workspaceDir);
      const ports = buildRunAssemblyPorts({
        workspaceDir: context.workspaceDir,
        draftId: input.draftId,
        runRecord,
        expected,
        fold,
        // The sealed Run record's own owner, not mutable product state — the skeptic re-derives
        // from what was sealed, not from what RunState currently claims.
        owner: runRecord.owner,
        receiptsByTaskDigest,
      });

      const verifiedMatrix = await verifyMatrix(matrixRecord, benchRecord, runRecord, ports, undefined, matrixBytes);
      if (!verifiedMatrix.ok) {
        refuse("record-integrity", "matrix-rederivation", `${verifiedMatrix.check}: ${verifiedMatrix.detail}`);
      }
      checks.push("matrix-rederivation");

      // ── 2 & 3. report-verification + claim-consistency (only alongside a sealed Report) ──
      if (runState.reportEnvelopeSha256 === undefined) {
        if (document.state === "reported" || document.state === "published-bundle") {
          refuse(
            "conflict",
            `runs.${input.draftId}`,
            `draft ${input.draftId} is "${document.state}" but its RunState has no sealed Report envelope`,
          );
        }
        return {
          draftId: input.draftId,
          checks,
          matrixSha256: runState.matrixSha256,
          ...(runtimeMethod === undefined ? {} : { runtimeMethod }),
        };
      }

      if (runState.reportedAt === undefined) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          `draft ${input.draftId} has a sealed Report envelope but no reportedAt instant`,
        );
      }

      // Shared, method-independent context (anchors validity, rehearsal disclosure, runtime/suite
      // limitations) is computed exactly once — during the canonical Report's own verification, in
      // the SAME relative position it always ran in — and reused unchanged for every additional
      // Report this run carries (packet P5, spec §8.3 option 5): none of it depends on WHICH
      // Report is being checked, only on the Run and Matrix both share.
      let sharedContext: {
        readonly previewLog: ReturnType<typeof readPreviewLog>;
        readonly carriage: ReturnType<typeof readRunAnchorCarriage>;
        /** issue #2839: the disclosure section re-derived from the sealed record's own bytes, so
         * this workspace-side rebuild compares the same projection the portable reader does. */
        readonly disclosureCarriage: ReturnType<typeof readRunDisclosureCarriage>;
        readonly additionalLimitations: readonly string[];
        readonly suiteComparability?: {
          readonly executionConformance: boolean;
          readonly coverage: "one_task" | "ten_task" | "full" | "custom";
          readonly leaderboardSubmitReady: boolean;
        };
      } | undefined;

      /**
       * Independently verifies ONE sealed Report and its own Claim: `report-verification` (DSSE +
       * exact-subject re-check) then `claim-consistency` (byte-exact re-derivation via the SAME
       * `assertClaimConsistency` the canonical Report always used — already resolves its plan
       * entry by `(method, version)`, not by position, so this needed no change to become
       * N-aware). `label` names which Report a refusal is about, without moving the refusal's
       * PATH (kept at the exact strings existing callers already assert on).
       */
      async function verifyOneReport(entryIdentities: {
        readonly reportSha256: string | undefined;
        readonly reportEnvelopeSha256: string;
        readonly claimPath: string;
      }, label: string): Promise<void> {
        const envelopeBytes = getSealedBytes(context.workspaceDir, entryIdentities.reportEnvelopeSha256);
        const verifiedReport = await verifyReport(
          { envelopeBytes, subjects: [matrixBytes], effectiveTime: runState.reportedAt! },
          {
            ...buildMethodPorts(context.workspaceDir),
            // The sealed Run record's own owner, not mutable product state — see the matching
            // comment at the matrix-rederivation ports above.
            trust: buildWorkspaceTrustDeps({ workspaceDir: context.workspaceDir, author: runRecord.owner }),
          },
        );
        if (!verifiedReport.ok) {
          refuse("record-integrity", "report-verification", `${label}: ${verifiedReport.check}: ${verifiedReport.detail}`);
        }
        const reportRecord: ReportRecord = verifiedReport.record;

        let claimText: string;
        try {
          claimText = readFileSync(entryIdentities.claimPath, "utf8");
        } catch {
          refuse("conflict", entryIdentities.claimPath, `draft ${input.draftId} has a sealed Report but no readable claim package at ${entryIdentities.claimPath}`);
        }
        let claimRaw: unknown;
        try {
          claimRaw = JSON.parse(claimText);
        } catch {
          refuse("conflict", entryIdentities.claimPath, `claim package at ${entryIdentities.claimPath} is not valid JSON`);
        }
        const claimParsed = ClaimPackageSchema.safeParse(claimRaw);
        if (!claimParsed.success) {
          refuse(
            "record-integrity",
            "claim-consistency",
            `${label}: claim package at ${entryIdentities.claimPath} does not satisfy the claim package schema: ${claimParsed.error.issues[0]?.message ?? "invalid"}`,
          );
        }
        const claim = claimParsed.data;

        if (sharedContext === undefined) {
          const previewLog = readPreviewLog(context.workspaceDir, input.draftId);
          // anchor-evidence §7.4: the anchors section is re-derived from the sealed AnchorEvidence
          // bytes, not read out of the claim under test — an unanchored claim that asserts an
          // anchor, and an anchored claim whose section drifted from its own records, both fail
          // below. Computed once — the anchors are a property of the Run/Matrix, not of any one
          // Report.
          const carriage = readRunAnchorCarriage(context.workspaceDir, runState);
          const disclosureCarriage = readRunDisclosureCarriage(context.workspaceDir, runState);
          // The same shared check the portable reader runs, over the workspace's own sealed bytes
          // and with no trust material — roots and headers are verifier-side configuration, and a
          // producer that supplied its own here would be grading its own homework. `invalid`
          // refuses; every other status, including a declared-but-absent subject, is a disclosed
          // fact.
          if (carriage.anchoredClosure) {
            const anchorReport = evaluateIntegrityAnchors({
              records: carriage.records,
              runSha256: runState.runSha256!,
              matrixSha256: runState.matrixSha256!,
              closeAt: runRecord.closeAt,
              declaredProfiles: carriage.declaredProfiles,
            });
            const firstInvalid = anchorReport.invalid[0];
            if (firstInvalid !== undefined) {
              refuse(
                "record-integrity",
                `anchors/${firstInvalid.recordSha256}.bin`,
                `carried anchor is invalid: ${firstInvalid.reason ?? "the proof does not verify"}`,
              );
            }
          }
          const inspectAdditional = document.spec.evaluationRuntime?.adapterId === INSPECT_ADAPTER_ID
            && deriveInspectEvaluationStrategy(runRecord.policy.evaluation) === "separate-log-verification"
            ? [...INSPECT_SEPARATE_ASSURANCE_LIMITATIONS]
            : [];
          const suiteFacts = isHarborCompatibleEvaluationRuntime(document.spec.evaluationRuntime)
            ? suiteFactsFromAccountedRun({
              manifest: HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
              armCount: runRecord.arms.length,
              itemCount: new Set(matrixRecord.cells.map((cell) => cell.taskDigest)).size,
              replicates: runRecord.replicates,
              matrix: matrixRecord,
              armJobs: document.spec.arms.map((arm) => ({
                armId: arm.armId,
                jobDir: join(harborArmJobsDir(context.workspaceDir, runSha256), harborArmJobName(runSha256, arm.armId)),
              })),
            })
            : document.spec.evaluationRuntime?.adapterId === "swebench-harness"
              ? suiteFactsFromAccountedSwebenchRun({
                manifest: SwebenchVerifiedSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
                armCount: runRecord.arms.length,
                itemCount: new Set(matrixRecord.cells.map((cell) => cell.taskDigest)).size,
                replicates: runRecord.replicates,
                matrix: matrixRecord,
                armIds: document.spec.arms.map((arm) => arm.armId),
                reportRoot: join(artifactsDir(context.workspaceDir), "swebench-harness", input.draftId),
                runId: resolveSwebenchHarnessRunId(join(artifactsDir(context.workspaceDir), "swebench-harness", input.draftId), runSha256),
                modelNameOrPathByArm: swebenchModelNameOrPathByArm(document.spec.arms),
              })
              : document.spec.evaluationRuntime?.adapterId === "archipelago"
                ? suiteFactsFromAccountedApexRun({
                  manifest: ApexAgentsSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
                  armCount: runRecord.arms.length,
                  itemCount: new Set(matrixRecord.cells.map((cell) => cell.taskDigest)).size,
                  replicates: runRecord.replicates,
                  matrix: matrixRecord,
                  armIds: document.spec.arms.map((arm) => arm.armId),
                  reportRoot: join(artifactsDir(context.workspaceDir), "archipelago", input.draftId),
                })
              : document.spec.evaluationRuntime?.adapterId === APEX_SWE_DEV_ADAPTER_ID
                ? suiteFactsFromAccountedApexSweDevRun({
                  manifest: ApexSweDevSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
                  armCount: runRecord.arms.length,
                  itemCount: new Set(matrixRecord.cells.map((cell) => cell.taskDigest)).size,
                  replicates: runRecord.replicates,
                  matrix: matrixRecord,
                  armIds: document.spec.arms.map((arm) => arm.armId),
                  reportRoot: apexSweDevReportRoot(artifactsDir(context.workspaceDir), input.draftId),
                })
                : document.spec.evaluationRuntime?.adapterId === INSPECT_ADAPTER_ID
                  ? (() => {
                    const manifest = readInspectEvalSelectionManifest(
                      context.workspaceDir,
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
          sharedContext = {
            previewLog,
            carriage,
            disclosureCarriage,
            additionalLimitations: [
              ...inspectAdditional,
              ...(suiteFacts?.limitation === undefined ? [] : [suiteFacts.limitation]),
            ],
            ...(suiteFacts === undefined ? {} : {
              suiteComparability: {
                executionConformance: suiteFacts.quote.executionConformance,
                coverage: suiteFacts.quote.coverage,
                leaderboardSubmitReady: suiteFacts.quote.leaderboardSubmitReady,
              },
            }),
          };
        }
        const { previewLog, carriage, disclosureCarriage, additionalLimitations, suiteComparability } = sharedContext;

        assertClaimConsistency({
          claim,
          identities: {
            benchmarkSha256,
            runSha256: runState.runSha256!,
            matrixSha256: runState.matrixSha256!,
            reportSha256: entryIdentities.reportSha256,
            reportEnvelopeSha256: entryIdentities.reportEnvelopeSha256,
          },
          matrixRecord,
          reportRecord,
          benchmarkRecord: benchRecord,
          runRecord,
          draftId: input.draftId,
          assurancePreset: document.spec.assurance.preset,
          ...(additionalLimitations.length > 0 ? { additionalLimitations } : {}),
          ...(suiteComparability === undefined ? {} : { suiteComparability }),
          ...(carriage.anchoredClosure ? { anchors: carriage.anchors } : {}),
          ...(disclosureCarriage === undefined ? {} : { disclosure: disclosureCarriage.disclosure }),
          ...(previewLog === undefined
            ? {}
            : {
                rehearsal: {
                  previewCount: previewLog.count,
                  timestamps: previewLog.previews.map((preview) => preview.at),
                },
              }),
        });
      }

      await verifyOneReport(
        { reportSha256: runState.reportSha256, reportEnvelopeSha256: runState.reportEnvelopeSha256, claimPath: claimPackageArtifactPath(context.workspaceDir, input.draftId) },
        "canonical",
      );
      const additionalReports: AdditionalRunVerifyResult[] = [];
      for (const entry of runState.additionalReports ?? []) {
        await verifyOneReport(
          {
            reportSha256: entry.reportSha256,
            reportEnvelopeSha256: entry.reportEnvelopeSha256,
            claimPath: additionalClaimPackagePath(context.workspaceDir, input.draftId, entry.method, entry.version),
          },
          `${entry.method}@${entry.version}`,
        );
        additionalReports.push({ method: entry.method, version: entry.version, reportEnvelopeSha256: entry.reportEnvelopeSha256 });
      }

      checks.push("report-verification");
      checks.push("claim-consistency");
      if (sharedContext!.carriage.anchoredClosure) checks.push("integrity-anchors");

      return {
        draftId: input.draftId,
        checks,
        matrixSha256: runState.matrixSha256,
        reportEnvelopeSha256: runState.reportEnvelopeSha256,
        ...(additionalReports.length === 0 ? {} : { additionalReports }),
        ...(runtimeMethod === undefined ? {} : { runtimeMethod }),
      };
}

export function runVerify(
  context: OperationContext,
  input: RunVerifyInput,
): Promise<OperationResult<RunVerifyResult>> {
  return operateAsync({
    context,
    action: "run.verify",
    subject: input.draftId,
    inputs: input,
    run: () => verifyRunWorkspace(context, input),
  });
}
