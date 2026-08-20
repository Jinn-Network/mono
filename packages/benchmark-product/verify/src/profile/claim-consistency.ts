import { BENCHMARKING_METHOD_IDS, type BenchmarkRecord, type MatrixRecord, type ReportRecord, type RunRecord } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "./errors.js";
import { buildClaimPackage, type ClaimPackage } from "./claim.js";
import type { ClaimAnchor } from "./anchor-claims.js";
import { buildLocalVenueHonesty, localVenueLimitsForRun } from "./run-results.js";
import { previewDisclosureSummaryLine } from "./preview-log.js";
import { venueIsolationPostureForPolicy } from "./isolation.js";
import { binaryInstrumentReportLimitations } from "./binary-qualification.js";

/** Mirrors `benchmark-product/core/src/verification/claim-consistency.ts`'s own (unexported)
 * copy of this exact string. Not imported from core: this package cannot take a package edge
 * on core, and core already depends on this package. The two copies must stay byte-identical. */
const PAIRED_ESTIMATE_LIMITATION =
  "This method estimates an effect; it does not gate one — no verdict, threshold, or selection was registered.";

export interface ClaimRecordIdentities { readonly benchmarkSha256: string; readonly runSha256: string; readonly matrixSha256: string; readonly reportSha256: string | undefined; readonly reportEnvelopeSha256: string; }
const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);
/** The path of the first field that actually differs, or `undefined` when the two values are
 * equal — equal leaves must report NO difference, or the object branch returns on its first key
 * and every mismatch names the first key in sorted order instead of the edited field. Mirrors
 * `benchmark-product/core`'s own copy (`src/verification/claim-consistency.ts`). */
function firstDifference(actual: unknown, expected: unknown, path = "claim"): string | undefined {
  // Never hand `undefined` to canonicalJsonBytes: it is deliberately not a JSON value, and a
  // field carried by one side alone is itself the first difference.
  if (actual === undefined || expected === undefined) return actual === expected ? undefined : path;
  if (equal(canonicalJsonBytes(actual), canonicalJsonBytes(expected))) return undefined;
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object" || Array.isArray(actual) !== Array.isArray(expected)) return path;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return path;
    for (const [index, value] of actual.entries()) {
      const nested = firstDifference(value, expected[index], `${path}.${index}`);
      if (nested !== undefined) return nested;
    }
    return path;
  }
  for (const key of [...new Set([...Object.keys(actual as object), ...Object.keys(expected as object)])].sort()) {
    const nested = firstDifference((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], path === "claim" ? key : `${path}.${key}`);
    if (nested !== undefined) return nested;
  }
  return path;
}

export function assertClaimConsistency(input: { readonly claim: ClaimPackage; readonly identities: ClaimRecordIdentities; readonly benchmarkRecord: BenchmarkRecord; readonly runRecord: RunRecord; readonly matrixRecord: MatrixRecord; readonly reportRecord: ReportRecord; readonly draftId: string; readonly assurancePreset: string; readonly additionalLimitations?: readonly string[]; readonly rehearsal?: { readonly previewCount: number; readonly timestamps: readonly string[] }; /** anchor-evidence §7.4: the anchors section re-derived from the carried AnchorEvidence bytes, never read from the claim under test. */ readonly anchors?: readonly ClaimAnchor[]; }): void {
  const { claim, identities, runRecord, matrixRecord, reportRecord } = input;
  if (identities.reportSha256 === undefined) refuse("record-integrity", "claim-consistency", "verified Report identity is absent");
  const plan = runRecord.analysisPlan?.find((entry) => entry.method === reportRecord.method.id && entry.version === reportRecord.method.version);
  const verdictRule = (plan?.parameters as { verdictRule?: unknown } | undefined)?.verdictRule;
  const minVerdicts = runRecord.policy.evaluation.minVerdicts;
  const distinctEvaluator = runRecord.policy.evaluation.distinctEvaluator;
  if ((verdictRule !== "sole" && verdictRule !== "majority" && verdictRule !== "unanimous") || minVerdicts === undefined || distinctEvaluator === undefined) refuse("record-integrity", "claim-consistency", "sealed Run carries no complete supported evaluation assurance primitives");
  // Presence, not emptiness: an empty section belongs to the anchored closure's declared-but-absent
  // bundle, and an omitted one to every unanchored bundle.
  const anchors = input.anchors;
  const expected = buildClaimPackage({ draftId: input.draftId, benchmarkSha256: identities.benchmarkSha256, runRecord, runSha256: identities.runSha256, matrixRecord, matrixSha256: identities.matrixSha256, reportRecord, reportSha256: identities.reportSha256, reportEnvelopeSha256: identities.reportEnvelopeSha256, venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord, anchors ?? []), verificationCommandVerb: "bundle verify", assurance: { preset: input.assurancePreset, resolved: { independence: runRecord.policy.independence, minVerdicts, distinctEvaluator, verdictRule } }, ...(input.rehearsal === undefined ? {} : { previewDisclosure: input.rehearsal }), ...(anchors === undefined ? {} : { anchors }) });
  if (!equal(canonicalJsonBytes(claim), canonicalJsonBytes(expected))) refuse("record-integrity", "claim-consistency", `claim package ${firstDifference(claim, expected) ?? "claim"} is not the exact projection of verified facts`);
  const rehearsalLine = input.rehearsal === undefined ? undefined : previewDisclosureSummaryLine(input.rehearsal);
  const binaryLimitations = reportRecord.method.id === BENCHMARKING_METHOD_IDS.binaryInstrument
    ? binaryInstrumentReportLimitations((plan?.parameters ?? {}) as Readonly<Record<string, unknown>>)
    : [];
  // paired-majority-delta@1 carries the same PAIRED_ESTIMATE_LIMITATION as paired-delta@1
  // (coordinator ruling, packet #2837) -- mirrors core's `verification/claim-consistency.ts`
  // method-conditional exactly, so the portable rebuild agrees with what `report` sealed.
  // Computed from `reportRecord.method.id` directly (like this file's own `binaryLimitations`)
  // rather than threaded through `input.additionalLimitations`.
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
  const posture = venueIsolationPostureForPolicy(runRecord.policy.submissionBaseline?.isolationPolicy);
  // The gate itself is UNCHANGED by the paired-estimate addition (still isolation posture,
  // caller-supplied additionalLimitations, or the existing binary-instrument arm). Deliberately
  // not widened to `|| pairedEstimateLimitation.length > 0` -- core left that gate unchanged so
  // this addition is not responsible for surfacing an unrelated pre-existing gap. For flagship
  // oci-container runs, `posture.inventory.length > 1` already activates the gate; folding the
  // line into `expectedLimitations` is what makes expected match the sealed Report.
  if ((posture.inventory.length > 1 || (input.additionalLimitations?.length ?? 0) > 0 || binaryLimitations.length > 0) && !equal(canonicalJsonBytes(reportRecord.limitations ?? []), canonicalJsonBytes(expectedLimitations))) refuse("record-integrity", "claim-consistency", "Report limitations are not the exact disclosure derived from the sealed Run and rehearsal history");
  if (rehearsalLine === undefined ? (reportRecord.limitations ?? []).some((line) => line.includes("disposable preview rehearsal(s)")) : !(reportRecord.limitations ?? []).includes(rehearsalLine)) refuse("record-integrity", "claim-consistency", "claim rehearsal and verified Report disclosure disagree");
}
