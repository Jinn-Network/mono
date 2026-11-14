/** Two-axis official-suite comparability. Not Report v2 required fields. */
// The comparability, conformance and limitation rules live in the checker, which re-derives a
// declaring bundle's `suiteComparability` from its carried bytes (`@colophon-claims/check`,
// `profile/suite-comparability.ts`, issues #4759, #4761, #4762). Re-exported here so every producer
// in this package keeps importing them from this module and runs the one implementation the checker
// runs.
import type { SuiteProtocolId } from "@colophon-claims/check";

export {
  SUITE_COVERAGE,
  SUITE_PROTOCOL_IDS,
  SUITE_NOT_LEADERBOARD_READY_LIMITATION,
  SUITE_NOT_LEADERBOARD_READY_LIMITATION_3_0,
  SWE_BENCH_VERIFIED_NOT_LEADERBOARD_READY_LIMITATION,
  APEX_SWE_DEV_NOT_LEADERBOARD_READY_LIMITATION,
  DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION,
  INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION,
  APEX_AGENTS_NOT_LEADERBOARD_READY_LIMITATION,
  INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE,
  methodLeaderboardEligible,
  deriveSuiteComparability,
  suiteLeaderboardLimitation,
  officialHarborExecutionConformance,
  officialPierExecutionConformance,
  SWE_BENCH_HARNESS_ADAPTER_ID,
  SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS,
  officialSwebenchHarnessConformance,
  ARCHIPELAGO_ADAPTER_ID,
  APEX_AGENTS_DEFAULT_MAX_STEPS,
  APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS,
  APEX_AGENTS_JUDGE_MODEL,
  APEX_AGENTS_JUDGE_THINKING,
  APEX_AGENTS_REACT_AGENT_ID,
  ARCHIPELAGO_COMMIT_PIN,
  officialArchipelagoConformance,
  APEX_SWE_DEV_ADAPTER_ID,
  APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS,
  officialApexSweDevConformance,
  officialInspectEvalConformance,
} from "@colophon-claims/check";
export type {
  SuiteCoverage,
  SuiteProtocolId,
  SuiteComparability,
  DeriveSuiteComparabilityInput,
} from "@colophon-claims/check";

const SUITE_PROTOCOL_DISPLAY_NAMES: Readonly<Record<SuiteProtocolId, string>> = {
  "terminal-bench-2.1": "Terminal-Bench 2.1",
  "terminal-bench-3.0": "Terminal-Bench 3.0",
  "swe-bench-verified": "SWE-bench Verified",
  "apex-agents": "APEX-Agents",
  "apex-swe-dev": "APEX-SWE-dev",
  "deep-swe-v1.1": "DeepSWE v1.1",
  "inspect-eval": "Inspect eval",
};

/** Human-facing suite name for refusal copy and Hub instructions. */
export function suiteProtocolDisplayName(protocol: SuiteProtocolId): string {
  return SUITE_PROTOCOL_DISPLAY_NAMES[protocol] ?? "Terminal-Bench 2.1";
}

export const COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE =
  "Community submissions are currently closed for Terminal-Bench 2.1. Colophon does not place the leaderboard row.";

export const SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place the swebench.com row. Predictions export is a derived artifact for their submit flow.";

export const APEX_AGENTS_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place the Mercor APEX-Agents row. Inspection export is a derived artifact; the Colophon bundle is the claim of record.";

export const APEX_SWE_DEV_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place a Mercor APEX-SWE leaderboard row. The public 50 is APEX-SWE-dev, not the held-out 200.";

export const DEEPSWE_CLOSED_SUBMIT_SENTENCE =
  "Colophon does not place the Datacurve leaderboard row. Export is a derived Pier job tree for email to serena@datacurve.ai.";

/**
 * The two accounting definitions that meet in one export's instructions: framework eligibility
 * counts an accounted-unscorable cell as done (`ACCOUNTED_OUTCOMES`, `run-complete.ts`), sealed
 * completeness counts judged cells only. A run with one accounted-unscorable cell can therefore
 * read "partial" on the certification and submit-ready two lines below, each true. Operator ruling
 * of 2026-08-20 (option c): name the divergence where it appears rather than reconcile the two.
 */
export const CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE =
  "The framework's eligibility rule counts accounted-unscorable cells as complete, which is why a submit-ready verdict can follow counts that are not complete; these sealed counts are the stricter record.";

/**
 * One certification line, prepended to every derived export's instructions, on all six shapes
 * (§8.2 "Frozen: (2) the certification statement"). Renders the sealed Matrix's own
 * `completeness` block (`CompletenessSchema`, `records/src/matrix/schema.ts:142-147`) and
 * computes nothing: a certification that recomputed completeness would be a second commitment
 * that can disagree with the artifact it describes.
 */
export function exportCompletenessCertification(input: {
  readonly runSha256: string;
  readonly completeness?: {
    readonly expected: number;
    readonly judged: number;
    readonly runOutcome: "complete" | "partial" | "cancelled";
  };
  /**
   * The framework-eligibility verdict the same instructions print, passed by the caller that
   * already decided it. Read only to decide whether the divergence is explained; it feeds no
   * predicate, and no eligibility rule reads anything on this input.
   */
  readonly frameworkSubmitReady?: boolean;
}): string {
  if (input.completeness === undefined) {
    // No sealed Matrix quotes no runOutcome, so there is no divergence to explain.
    return `no sealed Matrix: completeness of the selection sealed at lock ${input.runSha256} is not yet certified.`;
  }
  const { runOutcome, judged, expected } = input.completeness;
  const certification = `${runOutcome} run of the selection sealed at lock ${input.runSha256}: ${judged} of ${expected} cells judged.`;
  if (runOutcome === "complete" || input.frameworkSubmitReady !== true) return certification;
  return `${certification} ${CERTIFICATION_ACCOUNTING_DIVERGENCE_SENTENCE}`;
}
