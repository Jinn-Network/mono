/** Two-axis official-suite comparability. Not Report v2 required fields. */

export const SUITE_COVERAGE = ["one_task", "ten_task", "full", "custom"] as const;
export type SuiteCoverage = (typeof SUITE_COVERAGE)[number];
export type SuiteProtocolId = "terminal-bench-2.1" | "apex-swe-dev";

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
  /** Mercor harness JSON present per selected task. APEX-SWE-dev only. */
  readonly harnessReportsPresent?: boolean;
}

export const SUITE_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not a Terminal-Bench 2.1 leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 5 as judged or Harbor-error 0, or ATIF trajectories are missing from the retained Harbor job.";

export const APEX_SWE_DEV_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not an APEX-SWE leaderboard submission: APEX-SWE-dev locks the public 50-task set and cannot wear the 200-task APEX-SWE leaderboard name, even when coverage is full and every cell is accounted.";

export const COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE =
  "Community submissions are currently closed for Terminal-Bench 2.1. Colophon does not place the leaderboard row.";

export const APEX_SWE_DEV_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place a Mercor APEX-SWE leaderboard row. The public 50 is APEX-SWE-dev, not the held-out 200.";

export function methodLeaderboardEligible(input: DeriveSuiteComparabilityInput): boolean {
  if ((input.protocol ?? "terminal-bench-2.1") === "apex-swe-dev") return false;
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
  const collected = protocol === "apex-swe-dev"
    ? input.cellsAccounted === true && input.harnessReportsPresent === true
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
  return protocol === "apex-swe-dev"
    ? APEX_SWE_DEV_NOT_LEADERBOARD_READY_LIMITATION
    : SUITE_NOT_LEADERBOARD_READY_LIMITATION;
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
