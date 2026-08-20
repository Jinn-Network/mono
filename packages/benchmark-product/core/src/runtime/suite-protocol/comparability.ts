/** Two-axis official-suite comparability. Not Report v2 required fields. */
import { SUPPORTED_INSPECT_VERSION } from "../inspect/manifest.js";

export const SUITE_COVERAGE = ["one_task", "ten_task", "full", "custom"] as const;
export type SuiteCoverage = (typeof SUITE_COVERAGE)[number];
export const SUITE_PROTOCOL_IDS = [
  "terminal-bench-2.1",
  "terminal-bench-3.0",
  "swe-bench-verified",
  "apex-agents",
  "apex-swe-dev",
  "deep-swe-v1.1",
  "inspect-eval",
] as const;
export type SuiteProtocolId = (typeof SUITE_PROTOCOL_IDS)[number];

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

export interface SuiteComparability {
  readonly executionConformance: boolean;
  readonly coverage: SuiteCoverage;
  readonly leaderboardSubmitReady: boolean;
}

export interface DeriveSuiteComparabilityInput {
  readonly protocol?: SuiteProtocolId;
  readonly coverage: SuiteCoverage;
  readonly executionConformance: boolean;
  readonly k: number;
  readonly selectedCount: number;
  readonly datasetCount: number;
  readonly atifPresent: boolean;
  readonly datasetRevisionMatchesLeaderboardPin?: boolean;
  /** `datasetCount` equals the suite's sealed official size. Omitted where no size is pinned. */
  readonly datasetCountMatchesLeaderboardPin?: boolean;
  /** Present only after collect. Omitted at quote → not leaderboard-ready. */
  readonly cellsAccounted?: boolean;
  /** ATIF bytes on the retained Harbor/Pier job, not quote-time `atifRequired`. TB and DeepSWE. */
  readonly atifOnRetainedJob?: boolean;
  /** Per-trial Pier `reward.json` on judged cells. Required for DeepSWE ready; ignored elsewhere. */
  readonly rewardOnRetainedJob?: boolean;
  /** Harness report JSON present per selected instance/task. Verified and APEX-SWE-dev. */
  readonly harnessReportsPresent?: boolean;
  /** Archipelago `grades.json` present per selected task_id. APEX-Agents only. */
  readonly archipelagoGradesPresent?: boolean;
}

export const SUITE_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not a Terminal-Bench 2.1 leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 5 as judged or Harbor-error 0, or ATIF trajectories are missing from the retained Harbor job.";

export const SUITE_NOT_LEADERBOARD_READY_LIMITATION_3_0 =
  "This run is not a Terminal-Bench 3.0 leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 5 as judged or Harbor-error 0, or ATIF trajectories are missing from the retained Harbor job.";

export const SWE_BENCH_VERIFIED_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not a SWE-bench Verified leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset instance × 1 as judged or unscorable, or a swebench.harness report.json is missing for an instance.";

export const APEX_SWE_DEV_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not an APEX-SWE leaderboard submission: APEX-SWE-dev locks the public 50-task set and cannot wear the 200-task APEX-SWE leaderboard name, even when coverage is full and every cell is accounted.";

export const DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not a DeepSWE v1.1 leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 4 as judged or Pier-error 0, or ATIF trajectories are missing from the retained Pier job.";

export const INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not eval complete for the sealed Inspect eval: coverage is not the full sample catalog, execution was not protocol-conforming, or the Matrix does not account every catalog sample × specified epochs as judged or unscorable. Colophon does not place an Inspect Hub row.";

export const COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE =
  "Community submissions are currently closed for Terminal-Bench 2.1. Colophon does not place the leaderboard row.";

export const SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place the swebench.com row. Predictions export is a derived artifact for their submit flow.";

export const APEX_AGENTS_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not an APEX-Agents leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 1 as judged or unscorable, or an Archipelago grades.json is missing for a task.";

export const APEX_AGENTS_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place the Mercor APEX-Agents row. Inspection export is a derived artifact; the Colophon bundle is the claim of record.";

export const APEX_SWE_DEV_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place a Mercor APEX-SWE leaderboard row. The public 50 is APEX-SWE-dev, not the held-out 200.";

export const DEEPSWE_CLOSED_SUBMIT_SENTENCE =
  "Colophon does not place the Datacurve leaderboard row. Export is a derived Pier job tree for email to serena@datacurve.ai.";

function protocolOf(input: { readonly protocol?: SuiteProtocolId }): SuiteProtocolId {
  return input.protocol ?? "terminal-bench-2.1";
}

function minReplicates(protocol: SuiteProtocolId): number {
  return protocol === "deep-swe-v1.1" ? 4 : 5;
}

export const INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place an Inspect Hub row. An Inspect View bundle is a derived artifact, not the claim of record.";

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
}): string {
  if (input.completeness === undefined) {
    return `no sealed Matrix: completeness of the selection sealed at lock ${input.runSha256} is not yet certified.`;
  }
  const { runOutcome, judged, expected } = input.completeness;
  return `${runOutcome} run of the selection sealed at lock ${input.runSha256}: ${judged} of ${expected} cells judged.`;
}

export function methodLeaderboardEligible(input: DeriveSuiteComparabilityInput): boolean {
  const protocol = protocolOf(input);
  if (protocol === "apex-swe-dev") return false;
  if (protocol === "inspect-eval") {
    return input.coverage === "full"
      && input.executionConformance
      && input.k >= 1
      && input.selectedCount === input.datasetCount
      && input.datasetCount > 0
      && input.datasetRevisionMatchesLeaderboardPin !== false;
  }
  if (protocol === "swe-bench-verified" || protocol === "apex-agents") {
    return input.coverage === "full"
      && input.executionConformance
      && input.k === 1
      && input.selectedCount === input.datasetCount
      && input.datasetCount > 0
      && input.datasetRevisionMatchesLeaderboardPin !== false
      && input.datasetCountMatchesLeaderboardPin !== false;
  }
  return input.coverage === "full"
    && input.executionConformance
    && input.k >= minReplicates(protocol)
    && input.selectedCount === input.datasetCount
    && input.datasetCount > 0
    && input.atifPresent
    && input.datasetRevisionMatchesLeaderboardPin !== false
    && input.datasetCountMatchesLeaderboardPin !== false;
}

export function deriveSuiteComparability(input: DeriveSuiteComparabilityInput): SuiteComparability {
  const protocol = protocolOf(input);
  const collected = protocol === "swe-bench-verified" || protocol === "apex-swe-dev"
    ? input.cellsAccounted === true && input.harnessReportsPresent === true
    : protocol === "apex-agents"
      ? input.cellsAccounted === true && input.archipelagoGradesPresent === true
      : protocol === "deep-swe-v1.1"
        ? input.cellsAccounted === true
          && input.atifOnRetainedJob === true
          && input.rewardOnRetainedJob === true
        : protocol === "inspect-eval"
          ? input.cellsAccounted === true
          : input.cellsAccounted === true && input.atifOnRetainedJob === true;
  return {
    executionConformance: input.executionConformance,
    coverage: input.coverage,
    leaderboardSubmitReady: methodLeaderboardEligible(input) && collected,
  };
}

export function suiteLeaderboardLimitation(
  comparability: SuiteComparability,
  protocol: SuiteProtocolId = "terminal-bench-2.1",
): string | undefined {
  if (comparability.leaderboardSubmitReady) {
    // `suiteComparability` on the claim is three protocol-agnostic booleans written by every
    // protocol, and the Inspect-named copy otherwise lives only in the NOT-ready limitation.
    // Without this a ready Inspect eval claim carries no text naming Inspect anywhere, so it
    // reads identically to a Terminal-Bench 2.1 leaderboard-ready claim. The other protocols
    // keep returning undefined here — their closed-submissions copy rides on the export.
    return protocol === "inspect-eval" ? INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE : undefined;
  }
  if (protocol === "terminal-bench-3.0") return SUITE_NOT_LEADERBOARD_READY_LIMITATION_3_0;
  if (protocol === "swe-bench-verified") return SWE_BENCH_VERIFIED_NOT_LEADERBOARD_READY_LIMITATION;
  if (protocol === "apex-agents") return APEX_AGENTS_NOT_LEADERBOARD_READY_LIMITATION;
  if (protocol === "apex-swe-dev") return APEX_SWE_DEV_NOT_LEADERBOARD_READY_LIMITATION;
  if (protocol === "deep-swe-v1.1") return DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION;
  if (protocol === "inspect-eval") return INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION;
  return SUITE_NOT_LEADERBOARD_READY_LIMITATION;
}

const OFFICIAL_ENV_FORBIDDEN = new Set([
  "override_cpus",
  "override_memory_mb",
  "override_storage_mb",
  "override_gpus",
  "override_tpu",
  "mounts",
  "extra_docker_compose",
]);

const TIMEOUT_KEYS = new Set(["timeout", "timeout_multiplier", "agent_timeout", "verifier_timeout"]);

function officialEnvWithoutOverrides(environmentConfiguration: Readonly<Record<string, unknown>>): boolean {
  for (const key of Object.keys(environmentConfiguration)) {
    if (OFFICIAL_ENV_FORBIDDEN.has(key)) return false;
    if (TIMEOUT_KEYS.has(key)) return false;
  }
  const kwargs = environmentConfiguration.kwargs;
  if (kwargs !== undefined && typeof kwargs === "object" && kwargs !== null) {
    for (const key of Object.keys(kwargs as Record<string, unknown>)) {
      if (TIMEOUT_KEYS.has(key)) return false;
    }
  }
  const timeoutMultiplier = environmentConfiguration.timeout_multiplier;
  if (timeoutMultiplier !== undefined && timeoutMultiplier !== 1 && timeoutMultiplier !== 1.0) return false;
  return true;
}

export function officialHarborExecutionConformance(input: {
  readonly k: number;
  readonly maxRetries: number;
  readonly jobGrain: "per-dispatch" | "per-arm";
  readonly environmentConfiguration: Readonly<Record<string, unknown>>;
  readonly harborVersion: string;
}): boolean {
  if (input.k < 5 || input.maxRetries !== 3 || input.jobGrain !== "per-arm") return false;
  if (!/^0\.21\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(input.harborVersion)) return false;
  return officialEnvWithoutOverrides(input.environmentConfiguration);
}

const PIER_AGENT_ID = "mini-swe-agent";

export function officialPierExecutionConformance(input: {
  readonly k: number;
  readonly maxRetries: number;
  readonly jobGrain: "per-dispatch" | "per-arm";
  readonly environmentConfiguration: Readonly<Record<string, unknown>>;
  readonly pierVersion: string;
  readonly adapterId: string;
  readonly environmentType: string;
  readonly agentNames: readonly string[];
}): boolean {
  if (input.k < 4 || input.maxRetries !== 3 || input.jobGrain !== "per-arm") return false;
  if (input.adapterId !== "pier") return false;
  if (!/^0\.3\.1(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u.test(input.pierVersion)) return false;
  if (input.environmentType !== "docker" && input.environmentType !== "modal") return false;
  if (input.agentNames.length === 0 || input.agentNames.some((name) => name !== PIER_AGENT_ID)) return false;
  return officialEnvWithoutOverrides(input.environmentConfiguration);
}

export const SWE_BENCH_HARNESS_ADAPTER_ID = "swebench-harness" as const;
export const SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS = 1800 as const;

export function officialSwebenchHarnessConformance(input: {
  readonly k: number;
  readonly harnessVersion: string;
  readonly timeoutSeconds: number;
  readonly timeoutOverride: boolean;
  readonly resourceOverride: boolean;
  readonly evaluatorId: string;
}): boolean {
  if (input.k !== 1) return false;
  if (!/^4\.1\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(input.harnessVersion)) return false;
  if (input.timeoutSeconds !== SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS) return false;
  if (input.timeoutOverride || input.resourceOverride) return false;
  return input.evaluatorId === SWE_BENCH_HARNESS_ADAPTER_ID;
}

export const ARCHIPELAGO_ADAPTER_ID = "archipelago" as const;
export const APEX_AGENTS_DEFAULT_MAX_STEPS = 250 as const;
export const APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS = 10800 as const;
export const APEX_AGENTS_JUDGE_MODEL = "gemini-3-flash" as const;
export const APEX_AGENTS_JUDGE_THINKING = "low" as const;
export const APEX_AGENTS_REACT_AGENT_ID = "react_toolbelt_agent" as const;
export const ARCHIPELAGO_COMMIT_PIN = "0cb5c476c219a9df637e0bd37fb86b2361f4ab89" as const;

export function officialArchipelagoConformance(input: {
  readonly k: number;
  readonly archipelagoCommit: string;
  readonly agentId: string;
  readonly maxSteps: number;
  readonly timeoutSeconds: number;
  readonly judgeModel: string;
  readonly judgeThinking: string;
  readonly webSearch: boolean;
  readonly timeoutOverride: boolean;
  readonly resourceOverride: boolean;
  readonly evaluatorId: string;
}): boolean {
  if (input.k !== 1) return false;
  if (input.archipelagoCommit !== ARCHIPELAGO_COMMIT_PIN) return false;
  if (input.agentId !== APEX_AGENTS_REACT_AGENT_ID) return false;
  if (input.maxSteps !== APEX_AGENTS_DEFAULT_MAX_STEPS) return false;
  if (input.timeoutSeconds !== APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS) return false;
  if (input.judgeModel !== APEX_AGENTS_JUDGE_MODEL) return false;
  if (input.judgeThinking !== APEX_AGENTS_JUDGE_THINKING) return false;
  if (input.webSearch) return false;
  if (input.timeoutOverride || input.resourceOverride) return false;
  return input.evaluatorId === ARCHIPELAGO_ADAPTER_ID;
}

export const APEX_SWE_DEV_ADAPTER_ID = "apex-swe-dev" as const;
export const APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS = 3600 as const;

export function officialApexSweDevConformance(input: {
  readonly k: number;
  readonly nTrials: number;
  readonly timeoutSeconds: number;
  readonly timeoutOverride: boolean;
  readonly resourceOverride: boolean;
  readonly evaluatorId: string;
  readonly messageLimit?: number;
}): boolean {
  if (input.k !== 1 || input.nTrials !== 1) return false;
  if (input.timeoutSeconds !== APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS) return false;
  if (input.timeoutOverride || input.resourceOverride) return false;
  if (input.messageLimit !== undefined && input.messageLimit !== 250) return false;
  return input.evaluatorId === APEX_SWE_DEV_ADAPTER_ID;
}

export function officialInspectEvalConformance(input: {
  readonly k: number;
  readonly specifiedEpochs: number;
  readonly inspectVersion: string;
  readonly adapterId: string;
  readonly solver: string;
  readonly sampleLimit: number | null;
  readonly epochsInRunOptions: boolean;
}): boolean {
  // Defense in depth: today every caller reaches here off an `inspect` adapter, so this is
  // unreachable — it stays so a future third protocol cannot borrow Inspect conformance.
  if (input.adapterId !== "inspect") return false;
  if (input.inspectVersion !== SUPPORTED_INSPECT_VERSION) return false;
  if (input.solver !== "task-default") return false;
  if (input.sampleLimit !== null) return false;
  // Defense in depth: the strict selection schema already refuses `epochs` in runOptions, so
  // this cannot fire today — it stays as the conformance-side guard if that schema loosens.
  if (input.epochsInRunOptions) return false;
  if (!Number.isInteger(input.specifiedEpochs) || input.specifiedEpochs < 1) return false;
  return input.k === input.specifiedEpochs;
}
