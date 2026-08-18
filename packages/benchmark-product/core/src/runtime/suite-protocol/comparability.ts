/** Two-axis official-suite comparability. Not Report v2 required fields. */

export const SUITE_COVERAGE = ["one_task", "ten_task", "full", "custom"] as const;
export type SuiteCoverage = (typeof SUITE_COVERAGE)[number];
export type SuiteProtocolId = "terminal-bench-2.1" | "inspect-eval";

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
}

export const SUITE_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not a Terminal-Bench 2.1 leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 5 as judged or Harbor-error 0, or ATIF trajectories are missing from the retained Harbor job.";

export const INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION =
  "This run is not eval complete for the sealed Inspect eval: coverage is not the full sample catalog, execution was not protocol-conforming, or the Matrix does not account every catalog sample × specified epochs as judged or unscorable. Colophon does not place an Inspect Hub row.";

export const COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE =
  "Community submissions are currently closed for Terminal-Bench 2.1. Colophon does not place the leaderboard row.";

export const INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE =
  "Colophon does not place an Inspect Hub row. An Inspect View bundle is a derived artifact, not the claim of record.";

export function methodLeaderboardEligible(input: DeriveSuiteComparabilityInput): boolean {
  if ((input.protocol ?? "terminal-bench-2.1") === "inspect-eval") {
    return input.coverage === "full"
      && input.executionConformance
      && input.k >= 1
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
  const collected = protocol === "inspect-eval"
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
    // `suiteComparability` on the claim is three protocol-agnostic booleans written by both
    // protocols, and the Inspect-named copy otherwise lives only in the NOT-ready limitation.
    // Without this a ready Inspect eval claim carries no text naming Inspect anywhere, so it
    // reads identically to a Terminal-Bench 2.1 leaderboard-ready claim. TB 2.1 keeps
    // returning undefined here — its closed-submissions copy rides on the Hub export.
    return protocol === "inspect-eval" ? INSPECT_EVAL_SUBMIT_CLOSED_SENTENCE : undefined;
  }
  return protocol === "inspect-eval"
    ? INSPECT_EVAL_NOT_LEADERBOARD_READY_LIMITATION
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

export function officialInspectEvalConformance(input: {
  readonly k: number;
  readonly specifiedEpochs: number;
  readonly inspectVersion: string;
  readonly adapterId: string;
  readonly solver: string;
  readonly sampleLimit: number | null;
  readonly epochsInRunOptions: boolean;
}): boolean {
  if (input.adapterId !== "inspect") return false;
  if (input.inspectVersion !== "0.3.255") return false;
  if (input.solver !== "task-default") return false;
  if (input.sampleLimit !== null) return false;
  if (input.epochsInRunOptions) return false;
  if (!Number.isInteger(input.specifiedEpochs) || input.specifiedEpochs < 1) return false;
  return input.k === input.specifiedEpochs;
}
