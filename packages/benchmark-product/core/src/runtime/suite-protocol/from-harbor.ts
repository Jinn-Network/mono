import type { HarborSelectionManifest } from "../harbor/manifest.js";
import { TERMINAL_BENCH_2_1_DATASET_REF } from "../terminal-bench-2-1/manifest.js";
import {
  deriveSuiteComparability,
  officialHarborExecutionConformance,
  suiteLeaderboardLimitation,
  type SuiteComparability,
} from "./comparability.js";
import { SUITE_PROTOCOL_PROFILE, SuiteProtocolSelectionSchema, type SuiteProtocolSelection } from "./manifest.js";

export function suiteSelectionFromHarbor(manifest: HarborSelectionManifest): SuiteProtocolSelection | undefined {
  const value = manifest.profiles?.[SUITE_PROTOCOL_PROFILE];
  if (value === undefined) return undefined;
  return SuiteProtocolSelectionSchema.parse(value);
}

export function taskNameByDigestFromSuite(suite: SuiteProtocolSelection): Readonly<Record<string, string>> {
  return Object.fromEntries(suite.items.map((item) => [item.taskSha256, item.taskName]));
}

export interface SuiteQuotePresentation extends SuiteComparability {
  readonly cellCount: string;
  readonly harborVersion: string;
  readonly selectedTaskCount: number;
  readonly armCount: number;
  readonly replicates: number;
}

export function suiteQuoteFromHarbor(input: {
  readonly manifest: HarborSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
}): SuiteQuotePresentation | undefined {
  const suite = suiteSelectionFromHarbor(input.manifest);
  if (suite === undefined) return undefined;
  const executionConformance = officialHarborExecutionConformance({
    k: input.manifest.retryPolicy.nAttempts,
    maxRetries: input.manifest.retryPolicy.maxRetries,
    jobGrain: input.manifest.jobGrain ?? "per-dispatch",
    environmentConfiguration: input.manifest.environment.configuration as Readonly<Record<string, unknown>>,
    harborVersion: input.manifest.harbor.version,
  });
  const bits = deriveSuiteComparability({
    coverage: suite.coverage,
    executionConformance,
    k: suite.replicates,
    selectedCount: suite.selectedTaskNames.length,
    datasetCount: suite.datasetTaskCount,
    atifPresent: suite.atifRequired,
    datasetRevisionMatchesLeaderboardPin: suite.datasetRevision === TERMINAL_BENCH_2_1_DATASET_REF,
  });
  return {
    ...bits,
    cellCount: `${input.itemCount} × ${input.armCount} × ${input.replicates}`,
    harborVersion: input.manifest.harbor.version,
    selectedTaskCount: suite.selectedTaskNames.length,
    armCount: input.armCount,
    replicates: input.replicates,
  };
}

export function suiteFactsFromHarborManifest(input: {
  readonly manifest: HarborSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
}): { readonly quote: SuiteQuotePresentation; readonly limitation: string | undefined } | undefined {
  const quote = suiteQuoteFromHarbor(input);
  if (quote === undefined) return undefined;
  return {
    quote,
    limitation: suiteLeaderboardLimitation(quote),
  };
}
