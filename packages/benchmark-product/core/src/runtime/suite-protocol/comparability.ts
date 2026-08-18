/** Two-axis official-suite comparability. Not Report v2 required fields. */

export const SUITE_COVERAGE = ["one_task", "ten_task", "full", "custom"] as const;
export type SuiteCoverage = (typeof SUITE_COVERAGE)[number];
export type SuiteProtocolId = "terminal-bench-2.1" | "deep-swe-v1.1";

export interface SuiteComparability {
  readonly executionConformance: boolean;
  readonly coverage: SuiteCoverage;
  readonly leaderboardSubmitReady: boolean;
}

export interface DeriveSuiteComparabilityInput {
  readonly coverage: SuiteCoverage;
  readonly executionConformance: boolean;
  readonly k: number;
  readonly selectedCount: number;
  readonly datasetCount: number;
  readonly atifPresent: boolean;
  readonly datasetRevisionMatchesLeaderboardPin?: boolean;
  /** Present only after collect. Omitted at quote → not leaderboard-ready. */
  readonly cellsAccounted?: boolean;
  /** ATIF bytes on the retained Harbor/Pier job, not quote-time `atifRequired`. */
  readonly atifOnRetainedJob?: boolean;
  /** Per-trial Pier `reward.json` on judged cells. Required for DeepSWE ready; ignored for TB 2.1. */
  readonly rewardOnRetainedJob?: boolean;
  /** Defaults to Terminal-Bench 2.1 so existing callers stay protocol-specific. */
  readonly protocol?: SuiteProtocolId;
}

export const SUITE_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not a Terminal-Bench 2.1 leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 5 as judged or Harbor-error 0, or ATIF trajectories are missing from the retained Harbor job.";

export const DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not a DeepSWE v1.1 leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 4 as judged or Pier-error 0, or ATIF trajectories are missing from the retained Pier job.";

export const COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE =
  "Community submissions are currently closed for Terminal-Bench 2.1. Colophon does not place the leaderboard row.";

export const DEEPSWE_CLOSED_SUBMIT_SENTENCE =
  "Colophon does not place the Datacurve leaderboard row. Export is a derived Pier job tree for email to serena@datacurve.ai.";

function protocolOf(input: { readonly protocol?: SuiteProtocolId }): SuiteProtocolId {
  return input.protocol ?? "terminal-bench-2.1";
}

function minReplicates(protocol: SuiteProtocolId): number {
  return protocol === "deep-swe-v1.1" ? 4 : 5;
}

export function methodLeaderboardEligible(input: DeriveSuiteComparabilityInput): boolean {
  return input.coverage === "full"
    && input.executionConformance
    && input.k >= minReplicates(protocolOf(input))
    && input.selectedCount === input.datasetCount
    && input.datasetCount > 0
    && input.atifPresent
    && input.datasetRevisionMatchesLeaderboardPin !== false;
}

export function deriveSuiteComparability(input: DeriveSuiteComparabilityInput): SuiteComparability {
  const protocol = protocolOf(input);
  const rewardReady = protocol !== "deep-swe-v1.1" || input.rewardOnRetainedJob === true;
  return {
    executionConformance: input.executionConformance,
    coverage: input.coverage,
    leaderboardSubmitReady: methodLeaderboardEligible(input)
      && input.cellsAccounted === true
      && input.atifOnRetainedJob === true
      && rewardReady,
  };
}

export function suiteLeaderboardLimitation(
  comparability: SuiteComparability,
  protocol: SuiteProtocolId = "terminal-bench-2.1",
): string | undefined {
  if (comparability.leaderboardSubmitReady) return undefined;
  return protocol === "deep-swe-v1.1"
    ? DEEPSWE_NOT_LEADERBOARD_READY_LIMITATION
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
