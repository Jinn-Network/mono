import type { BenchmarkRecord, MatrixRecord, ReportRecord, RunRecord } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "../errors.js";
import { buildLocalVenueHonesty, localVenueLimitsForRun } from "../operations/run-results.js";
import { buildClaimPackage, type ClaimPackage } from "../report/claim.js";
import { previewDisclosureSummaryLine } from "../run/preview-log.js";
import { venueIsolationPostureForPolicy } from "../venue/isolation.js";

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
    venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord),
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
  const expectedLimitations = [
    ...localVenueLimitsForRun(runRecord),
    ...(input.additionalLimitations ?? []),
    ...(rehearsalLine === undefined ? [] : [rehearsalLine]),
  ];
  const isolationPosture = venueIsolationPostureForPolicy(
    runRecord.policy.submissionBaseline?.["isolationPolicy"],
  );
  if (
    (isolationPosture.inventory.length > 1 || (input.additionalLimitations?.length ?? 0) > 0)
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
