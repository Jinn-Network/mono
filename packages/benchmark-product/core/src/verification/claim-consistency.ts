import { BENCHMARKING_METHOD_IDS, type BenchmarkRecord, type MatrixRecord, type ReportRecord, type RunRecord } from "@jinn-network/benchmarking-records";
import type { ClaimAnchor } from "@colophon-claims/verify";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "../errors.js";
import { buildLocalVenueHonesty, localVenueLimitsForRun } from "../operations/run-results.js";
import { buildClaimPackage, type ClaimPackage } from "../report/claim.js";
import { binaryInstrumentReportLimitations } from "../run/binary-instrument-profile.js";
import { previewDisclosureSummaryLine } from "../run/preview-log.js";
import { venueIsolationPostureForPolicy } from "../venue/isolation.js";

/** Mirrors `operations/report.ts`'s own (unexported) copy of this exact string -- see the comment
 * at its use below. Not shared via export: `operations/publication-report.ts` already carries its
 * own independent copy too, and this module follows that established precedent rather than
 * introducing a new shared export for one string. */
const PAIRED_ESTIMATE_LIMITATION =
  "This method estimates an effect; it does not gate one — no verdict, threshold, or selection was registered.";

export interface ClaimRecordIdentities {
  readonly benchmarkSha256: string;
  readonly runSha256: string;
  readonly matrixSha256: string;
  readonly reportSha256: string | undefined;
  readonly reportEnvelopeSha256: string;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function firstDifference(actual: unknown, expected: unknown, path = "claim"): string | undefined {
  // Missing optional fields are themselves the first semantic difference. Do not pass
  // `undefined` to canonicalJsonBytes: it is intentionally not a JSON value.
  if (actual === undefined || expected === undefined) {
    return actual === expected ? undefined : path;
  }
  if (bytesEqual(canonicalJsonBytes(actual), canonicalJsonBytes(expected))) return undefined;
  if (
    actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object"
    || Array.isArray(actual) !== Array.isArray(expected)
  ) return path;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return path;
    for (let index = 0; index < actual.length; index += 1) {
      const nested = firstDifference(actual[index], expected[index], `${path}.${index}`);
      if (nested !== undefined) return nested;
    }
    return path;
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(actualRecord), ...Object.keys(expectedRecord)])].sort();
  for (const key of keys) {
    const nested = firstDifference(actualRecord[key], expectedRecord[key], path === "claim" ? key : `${path}.${key}`);
    if (nested !== undefined) return nested;
  }
  return path;
}

/** One complete claim projection shared by workspace verify, publish preflight, and portable
 * verify. Every claim field is either re-derived from sealed records, fixed product truth, or an
 * explicitly supplied product fact that is independently cross-linked to the signed Report. */
export function assertClaimConsistency(input: {
  readonly claim: ClaimPackage;
  readonly identities: ClaimRecordIdentities;
  readonly benchmarkRecord: BenchmarkRecord;
  readonly runRecord: RunRecord;
  readonly matrixRecord: MatrixRecord;
  readonly reportRecord: ReportRecord;
  readonly draftId: string;
  readonly assurancePreset: string;
  /** Product-private disclosures whose applicability is proven by evidence outside the frozen
   * Run schema (for example, the bundled Inspect task/selection closure). */
  readonly additionalLimitations?: readonly string[];
  readonly rehearsal?: { readonly previewCount: number; readonly timestamps: readonly string[] };
  /** anchor-evidence §7.4: the anchors section re-derived from the AnchorEvidence bytes this
   * verification path authenticated, never read out of the claim being checked. Empty rebuilds the
   * unanchored claim, so a stored claim asserting an anchor nobody carries fails here. */
  readonly anchors?: readonly ClaimAnchor[];
  readonly suiteComparability?: {
    readonly executionConformance: boolean;
    readonly coverage: "one_task" | "ten_task" | "full" | "custom";
    readonly leaderboardSubmitReady: boolean;
  };
}): void {
  const { claim, identities, runRecord, matrixRecord, reportRecord } = input;
  if (identities.reportSha256 === undefined) {
    refuse("record-integrity", "claim-consistency", "verified Report identity is absent");
  }
  // The sealed plan may carry more than one entry (one per candidate method, P4b Task 5) — select
  // the entry matching the produced Report's method, not a fixed index.
  const matchingPlanEntry = runRecord.analysisPlan?.find(
    (entry) => entry.method === reportRecord.method.id && entry.version === reportRecord.method.version,
  );
  const verdictRule = (matchingPlanEntry?.parameters as { verdictRule?: unknown } | undefined)?.verdictRule;
  if (verdictRule !== "sole" && verdictRule !== "majority" && verdictRule !== "unanimous") {
    refuse("record-integrity", "claim-consistency", "sealed Run carries no supported verdictRule");
  }
  const minVerdicts = runRecord.policy.evaluation.minVerdicts;
  const distinctEvaluator = runRecord.policy.evaluation.distinctEvaluator;
  if (minVerdicts === undefined || distinctEvaluator === undefined) {
    refuse("record-integrity", "claim-consistency", "sealed Run carries no complete evaluation-assurance primitives");
  }
  const expected = buildClaimPackage({
    draftId: input.draftId,
    benchmarkSha256: identities.benchmarkSha256,
    runRecord,
    runSha256: identities.runSha256,
    matrixRecord,
    matrixSha256: identities.matrixSha256,
    reportRecord,
    reportSha256: identities.reportSha256,
    reportEnvelopeSha256: identities.reportEnvelopeSha256,
    venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord, input.anchors ?? []),
    verificationCommandVerb: "bundle verify",
    assurance: {
      preset: input.assurancePreset,
      resolved: {
        independence: runRecord.policy.independence,
        minVerdicts,
        distinctEvaluator,
        verdictRule,
      },
    },
    ...(input.rehearsal === undefined ? {} : { previewDisclosure: input.rehearsal }),
    ...(input.anchors === undefined ? {} : { anchors: input.anchors }),
    ...(input.suiteComparability === undefined ? {} : { suiteComparability: input.suiteComparability }),
  });
  if (!bytesEqual(canonicalJsonBytes(claim), canonicalJsonBytes(expected))) {
    const field = firstDifference(claim, expected) ?? "claim";
    refuse(
      "record-integrity",
      "claim-consistency",
      `claim package ${field} is not the exact projection of the verified Benchmark, Run, Matrix, Report, and disclosed product facts`,
    );
  }

  const rehearsalLine = input.rehearsal === undefined ? undefined : previewDisclosureSummaryLine(input.rehearsal);
  const reportLimitations = reportRecord.limitations ?? [];
  const binaryLimitations = reportRecord.method.id === BENCHMARKING_METHOD_IDS.binaryInstrument
    ? binaryInstrumentReportLimitations((matchingPlanEntry?.parameters ?? {}) as Readonly<Record<string, unknown>>)
    : [];
  // paired-majority-delta@1 carries the same PAIRED_ESTIMATE_LIMITATION as paired-delta@1
  // (coordinator ruling, packet #2837) -- mirrors `operations/report.ts`'s own method-conditional
  // exactly, so the cold rebuild here agrees with what `report` actually sealed. Computed from
  // `reportRecord.method.id` directly (like the portable verifier's own `binaryLimitations`,
  // `verify/src/profile/claim-consistency.ts`) rather than threaded through
  // `input.additionalLimitations`, since it depends on WHICH method produced this Report, not on
  // venue/suite facts shared across every Report a run carries.
  const pairedEstimateLimitation =
    reportRecord.method.id === BENCHMARKING_METHOD_IDS.pairedDelta
    || reportRecord.method.id === BENCHMARKING_METHOD_IDS.pairedMajorityDelta
      ? [PAIRED_ESTIMATE_LIMITATION]
      : [];
  const expectedLimitations = [
    ...localVenueLimitsForRun(runRecord),
    ...(input.additionalLimitations ?? []),
    ...binaryLimitations,
    ...pairedEstimateLimitation,
    ...(rehearsalLine === undefined ? [] : [rehearsalLine]),
  ];
  const isolationPosture = venueIsolationPostureForPolicy(
    runRecord.policy.submissionBaseline?.["isolationPolicy"],
  );
  // The gate itself is unchanged by the paired-estimate addition (still isolation posture,
  // caller-supplied additionalLimitations, or the binary-instrument arm). Deliberately not widened
  // to `|| pairedEstimateLimitation.length > 0`: doing so would surface the unrelated historical
  // single-isolation paired-delta fixture gap. Binary limitations are different: they are sealed
  // method facts and must always be checked for binary-instrument Reports.
  if (
    (
      isolationPosture.inventory.length > 1
      || (input.additionalLimitations?.length ?? 0) > 0
      || binaryLimitations.length > 0
    )
    && !bytesEqual(canonicalJsonBytes(reportLimitations), canonicalJsonBytes(expectedLimitations))
  ) {
    refuse(
      "record-integrity",
      "claim-consistency",
      "Report limitations are not the exact disclosure derived from the sealed Run and rehearsal history",
    );
  }
  if (rehearsalLine === undefined) {
    if (reportLimitations.some((line) => line.includes("disposable preview rehearsal(s)"))) {
      refuse("record-integrity", "claim-consistency", "Report discloses a rehearsal absent from the claim");
    }
  } else if (!reportLimitations.includes(rehearsalLine)) {
    refuse("record-integrity", "claim-consistency", "claim rehearsal is not disclosed by the verified Report");
  }
}
