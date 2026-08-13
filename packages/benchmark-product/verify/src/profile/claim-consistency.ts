import type { BenchmarkRecord, MatrixRecord, ReportRecord, RunRecord } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "./errors.js";
import { buildClaimPackage, type ClaimPackage } from "./claim.js";
import { buildLocalVenueHonesty, localVenueLimitsForRun } from "./run-results.js";
import { previewDisclosureSummaryLine } from "./preview-log.js";
import { venueIsolationPostureForPolicy } from "./isolation.js";

export interface ClaimRecordIdentities { readonly benchmarkSha256: string; readonly runSha256: string; readonly matrixSha256: string; readonly reportSha256: string | undefined; readonly reportEnvelopeSha256: string; }
const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);
function firstDifference(actual: unknown, expected: unknown, path = "claim"): string {
  if (actual === undefined || expected === undefined || actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object" || Array.isArray(actual) !== Array.isArray(expected)) return path;
  if (Array.isArray(actual) && Array.isArray(expected)) return actual.length === expected.length ? actual.reduce<string>((found, value, index) => found === path ? firstDifference(value, expected[index], `${path}.${index}`) : found, path) : path;
  for (const key of [...new Set([...Object.keys(actual as object), ...Object.keys(expected as object)])].sort()) {
    const value = firstDifference((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], path === "claim" ? key : `${path}.${key}`);
    if (value !== path) return value;
  }
  return path;
}

export function assertClaimConsistency(input: { readonly claim: ClaimPackage; readonly identities: ClaimRecordIdentities; readonly benchmarkRecord: BenchmarkRecord; readonly runRecord: RunRecord; readonly matrixRecord: MatrixRecord; readonly reportRecord: ReportRecord; readonly draftId: string; readonly assurancePreset: string; readonly rehearsal?: { readonly previewCount: number; readonly timestamps: readonly string[] }; }): void {
  const { claim, identities, runRecord, matrixRecord, reportRecord } = input;
  if (identities.reportSha256 === undefined) refuse("record-integrity", "claim-consistency", "verified Report identity is absent");
  const plan = runRecord.analysisPlan?.find((entry) => entry.method === reportRecord.method.id && entry.version === reportRecord.method.version);
  const verdictRule = (plan?.parameters as { verdictRule?: unknown } | undefined)?.verdictRule;
  const minVerdicts = runRecord.policy.evaluation.minVerdicts;
  const distinctEvaluator = runRecord.policy.evaluation.distinctEvaluator;
  if ((verdictRule !== "sole" && verdictRule !== "majority" && verdictRule !== "unanimous") || minVerdicts === undefined || distinctEvaluator === undefined) refuse("record-integrity", "claim-consistency", "sealed Run carries no complete supported evaluation assurance primitives");
  const expected = buildClaimPackage({ draftId: input.draftId, benchmarkSha256: identities.benchmarkSha256, runRecord, runSha256: identities.runSha256, matrixRecord, matrixSha256: identities.matrixSha256, reportRecord, reportSha256: identities.reportSha256, reportEnvelopeSha256: identities.reportEnvelopeSha256, venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord), verificationCommandVerb: "bundle verify", assurance: { preset: input.assurancePreset, resolved: { independence: runRecord.policy.independence, minVerdicts, distinctEvaluator, verdictRule } }, ...(input.rehearsal === undefined ? {} : { previewDisclosure: input.rehearsal }) });
  if (!equal(canonicalJsonBytes(claim), canonicalJsonBytes(expected))) refuse("record-integrity", "claim-consistency", `claim package ${firstDifference(claim, expected)} is not the exact projection of verified facts`);
  const rehearsalLine = input.rehearsal === undefined ? undefined : previewDisclosureSummaryLine(input.rehearsal);
  const expectedLimitations = [...localVenueLimitsForRun(runRecord), ...(rehearsalLine === undefined ? [] : [rehearsalLine])];
  const posture = venueIsolationPostureForPolicy(runRecord.policy.submissionBaseline?.isolationPolicy);
  if (posture.inventory.length > 1 && !equal(canonicalJsonBytes(reportRecord.limitations ?? []), canonicalJsonBytes(expectedLimitations))) refuse("record-integrity", "claim-consistency", "Report limitations are not the exact disclosure derived from the sealed Run and rehearsal history");
  if (rehearsalLine === undefined ? (reportRecord.limitations ?? []).some((line) => line.includes("disposable preview rehearsal(s)")) : !(reportRecord.limitations ?? []).includes(rehearsalLine)) refuse("record-integrity", "claim-consistency", "claim rehearsal and verified Report disclosure disagree");
}
