/** Two-axis official-suite comparability. Not Report v2 required fields. */

export const SUITE_COVERAGE = ["one_task", "ten_task", "full", "custom"] as const;
export type SuiteCoverage = (typeof SUITE_COVERAGE)[number];
export type SuiteProtocolId = "terminal-bench-2.1" | "swe-bench-verified" | "apex-agents";

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
  /** Present only after collect. Omitted at quote → not leaderboard-ready. */
  readonly cellsAccounted?: boolean;
  /** ATIF bytes on the retained Harbor job, not quote-time `atifRequired`. TB 2.1 only. */
  readonly atifOnRetainedJob?: boolean;
  /** Harness `report.json` present per selected instance. Verified only. */
  readonly harnessReportsPresent?: boolean;
  /** Archipelago `grades.json` present per selected task_id. APEX-Agents only. */
  readonly archipelagoGradesPresent?: boolean;
}

export const SUITE_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not a Terminal-Bench 2.1 leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 5 as judged or Harbor-error 0, or ATIF trajectories are missing from the retained Harbor job.";

export const SWE_BENCH_VERIFIED_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not a SWE-bench Verified leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset instance × 1 as judged or unscorable, or a swebench.harness report.json is missing for an instance.";

export const COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE =
  "Community submissions are currently closed for Terminal-Bench 2.1. Colophon does not place the leaderboard row.";

export const SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place the swebench.com row. Predictions export is a derived artifact for their submit flow.";

export const APEX_AGENTS_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not an APEX-Agents leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 1 as judged or unscorable, or an Archipelago grades.json is missing for a task.";

export const APEX_AGENTS_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place the Mercor APEX-Agents row. Inspection export is a derived artifact; the Colophon bundle is the claim of record.";

export function methodLeaderboardEligible(input: DeriveSuiteComparabilityInput): boolean {
  const protocol = input.protocol ?? "terminal-bench-2.1";
  if (protocol === "swe-bench-verified" || protocol === "apex-agents") {
    return input.coverage === "full"
      && input.executionConformance
      && input.k === 1
      && input.selectedCount === input.datasetCount
      && input.datasetCount > 0
      && input.datasetRevisionMatchesLeaderboardPin !== false;
  }
  return input.coverage === "full"
    && input.executionConformance
    && input.k >= 5
    && input.selectedCount === input.datasetCount
    && input.datasetCount > 0
    && input.atifPresent
    && input.datasetRevisionMatchesLeaderboardPin !== false;
}

export function deriveSuiteComparability(input: DeriveSuiteComparabilityInput): SuiteComparability {
  const protocol = input.protocol ?? "terminal-bench-2.1";
  const collected = protocol === "swe-bench-verified"
    ? input.cellsAccounted === true && input.harnessReportsPresent === true
    : protocol === "apex-agents"
      ? input.cellsAccounted === true && input.archipelagoGradesPresent === true
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
  if (comparability.leaderboardSubmitReady) return undefined;
  if (protocol === "swe-bench-verified") return SWE_BENCH_VERIFIED_NOT_LEADERBOARD_READY_LIMITATION;
  if (protocol === "apex-agents") return APEX_AGENTS_NOT_LEADERBOARD_READY_LIMITATION;
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

export function officialHarborExecutionConformance(input: {
  readonly k: number;
  readonly maxRetries: number;
  readonly jobGrain: "per-dispatch" | "per-arm";
  readonly environmentConfiguration: Readonly<Record<string, unknown>>;
  readonly harborVersion: string;
}): boolean {
  if (input.k < 5 || input.maxRetries !== 3 || input.jobGrain !== "per-arm") return false;
  if (!/^0\.21\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(input.harborVersion)) return false;
  for (const key of Object.keys(input.environmentConfiguration)) {
    if (OFFICIAL_ENV_FORBIDDEN.has(key)) return false;
    if (TIMEOUT_KEYS.has(key)) return false;
  }
  const kwargs = input.environmentConfiguration.kwargs;
  if (kwargs !== undefined && typeof kwargs === "object" && kwargs !== null) {
    for (const key of Object.keys(kwargs as Record<string, unknown>)) {
      if (TIMEOUT_KEYS.has(key)) return false;
    }
  }
  const timeoutMultiplier = input.environmentConfiguration.timeout_multiplier;
  if (timeoutMultiplier !== undefined && timeoutMultiplier !== 1 && timeoutMultiplier !== 1.0) return false;
  return true;
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
