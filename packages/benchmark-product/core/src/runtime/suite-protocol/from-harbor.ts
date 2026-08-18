import type { HarborSelectionManifest } from "../harbor/manifest.js";
import {
  DEEP_SWE_V11_GIT_SHA,
  DEEP_SWE_V11_TASKS_TREE_SHA,
} from "../deep-swe-v1.1/manifest.js";
import { TERMINAL_BENCH_2_1_DATASET_REF } from "../terminal-bench-2-1/manifest.js";
import {
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialHarborExecutionConformance,
  officialPierExecutionConformance,
  suiteLeaderboardLimitation,
  type SuiteComparability,
} from "./comparability.js";
import { SUITE_PROTOCOL_PROFILE, SuiteProtocolSelectionSchema, type SuiteProtocolSelection } from "./manifest.js";
import { allArmsRunComplete, assessArmRunComplete, type MatrixCellAccount } from "./run-complete.js";

export function suiteSelectionFromHarbor(manifest: HarborSelectionManifest): SuiteProtocolSelection | undefined {
  const value = manifest.profiles?.[SUITE_PROTOCOL_PROFILE];
  if (value === undefined) return undefined;
  return SuiteProtocolSelectionSchema.parse(value);
}

export function taskNameByDigestFromSuite(suite: SuiteProtocolSelection): Readonly<Record<string, string>> {
  return Object.fromEntries(suite.items.map((item) => [item.taskSha256, item.taskName]));
}

export interface SuiteQuotePresentation extends SuiteComparability {
  readonly methodLeaderboardEligible: boolean;
  readonly cellCount: string;
  readonly harborVersion: string;
  readonly selectedTaskCount: number;
  readonly armCount: number;
  readonly replicates: number;
}

function methodBitsFromHarbor(input: {
  readonly manifest: HarborSelectionManifest;
  readonly suite: SuiteProtocolSelection;
}): {
  readonly protocol: SuiteProtocolSelection["protocol"];
  readonly coverage: SuiteProtocolSelection["coverage"];
  readonly executionConformance: boolean;
  readonly k: number;
  readonly selectedCount: number;
  readonly datasetCount: number;
  readonly atifPresent: boolean;
  readonly datasetRevisionMatchesLeaderboardPin: boolean;
} {
  const pin = input.suite.protocol === "deep-swe-v1.1"
    ? input.suite.datasetRevision === DEEP_SWE_V11_GIT_SHA
      && input.suite.tasksTreeSha === DEEP_SWE_V11_TASKS_TREE_SHA
    : input.suite.datasetRevision === TERMINAL_BENCH_2_1_DATASET_REF;
  const executionConformance = input.suite.protocol === "deep-swe-v1.1"
    ? officialPierExecutionConformance({
      k: input.manifest.retryPolicy.nAttempts,
      maxRetries: input.manifest.retryPolicy.maxRetries,
      jobGrain: input.manifest.jobGrain ?? "per-dispatch",
      environmentConfiguration: input.manifest.environment.configuration as Readonly<Record<string, unknown>>,
      pierVersion: input.manifest.harbor.version,
      adapterId: input.manifest.adapter.id,
      environmentType: input.manifest.environment.type,
      agentNames: input.manifest.arms.map((arm) => arm.jobAgent.name),
    })
    : officialHarborExecutionConformance({
      k: input.manifest.retryPolicy.nAttempts,
      maxRetries: input.manifest.retryPolicy.maxRetries,
      jobGrain: input.manifest.jobGrain ?? "per-dispatch",
      environmentConfiguration: input.manifest.environment.configuration as Readonly<Record<string, unknown>>,
      harborVersion: input.manifest.harbor.version,
    });
  return {
    protocol: input.suite.protocol,
    coverage: input.suite.coverage,
    executionConformance,
    k: input.suite.replicates,
    selectedCount: input.suite.selectedTaskNames.length,
    datasetCount: input.suite.datasetTaskCount,
    atifPresent: input.suite.atifRequired,
    datasetRevisionMatchesLeaderboardPin: pin,
  };
}

function presentSuiteQuote(
  input: {
    readonly manifest: HarborSelectionManifest;
    readonly armCount: number;
    readonly itemCount: number;
    readonly replicates: number;
  },
  suite: SuiteProtocolSelection,
  bits: SuiteComparability,
  eligible: boolean,
): SuiteQuotePresentation {
  return {
    ...bits,
    methodLeaderboardEligible: eligible,
    cellCount: `${input.itemCount} × ${input.armCount} × ${input.replicates}`,
    harborVersion: input.manifest.harbor.version,
    selectedTaskCount: suite.selectedTaskNames.length,
    armCount: input.armCount,
    replicates: input.replicates,
  };
}

export function suiteQuoteFromHarbor(input: {
  readonly manifest: HarborSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
}): SuiteQuotePresentation | undefined {
  const suite = suiteSelectionFromHarbor(input.manifest);
  if (suite === undefined) return undefined;
  const method = methodBitsFromHarbor({ manifest: input.manifest, suite });
  return presentSuiteQuote(input, suite, deriveSuiteComparability(method), methodLeaderboardEligible(method));
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
    limitation: suiteLeaderboardLimitation(quote, suiteSelectionFromHarbor(input.manifest)?.protocol),
  };
}

export function suiteFactsFromAccountedRun(input: {
  readonly manifest: HarborSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly armJobs: readonly { readonly armId: string; readonly jobDir: string }[];
}): { readonly quote: SuiteQuotePresentation; readonly limitation: string | undefined } | undefined {
  const suite = suiteSelectionFromHarbor(input.manifest);
  if (suite === undefined) return undefined;
  const method = methodBitsFromHarbor({ manifest: input.manifest, suite });
  const complete = allArmsRunComplete(input.armJobs.map((arm) => assessArmRunComplete({
    matrix: input.matrix,
    suite,
    armId: arm.armId,
    jobDir: arm.jobDir,
  })));
  const bits = deriveSuiteComparability({ ...method, ...complete });
  const quote = presentSuiteQuote(input, suite, bits, methodLeaderboardEligible(method));
  return { quote, limitation: suiteLeaderboardLimitation(quote, suite.protocol) };
}

export function suiteComparabilityForArm(input: {
  readonly manifest: HarborSelectionManifest;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly armId: string;
  readonly jobDir: string;
}): SuiteComparability | undefined {
  const suite = suiteSelectionFromHarbor(input.manifest);
  if (suite === undefined) return undefined;
  const method = methodBitsFromHarbor({ manifest: input.manifest, suite });
  const complete = assessArmRunComplete({
    matrix: input.matrix,
    suite,
    armId: input.armId,
    jobDir: input.jobDir,
  });
  return deriveSuiteComparability({ ...method, ...complete });
}

export function suiteLimitationFromHarbor(manifest: HarborSelectionManifest, comparability: SuiteComparability): string | undefined {
  const suite = suiteSelectionFromHarbor(manifest);
  return suiteLeaderboardLimitation(comparability, suite?.protocol);
}
