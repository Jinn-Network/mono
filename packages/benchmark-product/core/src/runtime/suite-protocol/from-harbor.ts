import type { HarborSelectionManifest } from "../harbor/manifest.js";
import {
  DEEP_SWE_V11_GIT_SHA,
  DEEP_SWE_V11_TASK_COUNT,
  DEEP_SWE_V11_TASKS_TREE_SHA,
} from "../deep-swe-v1.1/manifest.js";
import { TERMINAL_BENCH_2_1_DATASET_REF } from "../terminal-bench-2-1/manifest.js";
import { TERMINAL_BENCH_3_0_DATASET_REF } from "../terminal-bench-3-0/manifest.js";
import {
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialHarborExecutionConformance,
  officialPierExecutionConformance,
  suiteLeaderboardLimitation,
  type SuiteComparability,
  type SuiteProtocolId,
} from "./comparability.js";
import { SUITE_PROTOCOL_PROFILE, SuiteProtocolSelectionSchema, type SuiteProtocolSelection } from "./manifest.js";
import { allArmsRunComplete, assessArmRunComplete, type MatrixCellAccount } from "./run-complete.js";

export function suiteSelectionFromHarbor(manifest: HarborSelectionManifest): SuiteProtocolSelection | undefined {
  const value = manifest.profiles?.[SUITE_PROTOCOL_PROFILE];
  if (value === undefined) return undefined;
  // Absent means "not a suite run". Present-but-invalid means a tampered or forged sealed
  // profile and must fail loud — `runtime/adapter.ts` parses the same bytes and throws.
  const parsed = SuiteProtocolSelectionSchema.parse(value);
  // Only the Terminal-Bench protocols and DeepSWE v1.1 bind via Harbor/Pier profiles; Verified,
  // APEX-Agents, APEX-SWE-dev, and Inspect eval bind via their own selection manifests.
  return parsed.protocol === "terminal-bench-2.1"
    || parsed.protocol === "terminal-bench-3.0"
    || parsed.protocol === "deep-swe-v1.1"
    ? parsed
    : undefined;
}

function officialPinFor(protocol: SuiteProtocolId): string {
  if (protocol === "terminal-bench-3.0") return TERMINAL_BENCH_3_0_DATASET_REF;
  return TERMINAL_BENCH_2_1_DATASET_REF;
}

export function taskNameByDigestFromSuite(suite: SuiteProtocolSelection): Readonly<Record<string, string>> {
  return Object.fromEntries(suite.items.map((item) => [item.taskSha256, item.taskName]));
}

export interface SuiteQuotePresentation extends SuiteComparability {
  readonly protocol: SuiteProtocolId;
  readonly methodLeaderboardEligible: boolean;
  readonly cellCount: string;
  /** Harbor-family protocols only: the Harbor version this selection pinned. */
  readonly harborVersion?: string;
  /** Protocols whose executor is not Harbor carry their harness version here. */
  readonly harnessVersion?: string;
  /** Inspect eval only: the Inspect version this selection pinned. */
  readonly inspectVersion?: string;
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
  // `tasksTreeSha` is recomputed from the operator's task material at select, so this compares
  // sealed bytes against the official pin rather than a constant against itself.
  const pin = input.suite.protocol === "deep-swe-v1.1"
    ? input.suite.datasetRevision === DEEP_SWE_V11_GIT_SHA
      && input.suite.tasksTreeSha === DEEP_SWE_V11_TASKS_TREE_SHA
      && input.suite.datasetTaskCount === DEEP_SWE_V11_TASK_COUNT
    : input.suite.datasetRevision === officialPinFor(input.suite.protocol);
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
    protocol: suite.protocol,
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
    limitation: suiteLeaderboardLimitation(quote, quote.protocol),
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
  return { quote, limitation: suiteLeaderboardLimitation(quote, quote.protocol) };
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
