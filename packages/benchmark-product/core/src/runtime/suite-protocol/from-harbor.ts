import type { HarborSelectionManifest } from "../harbor/manifest.js";
import { TERMINAL_BENCH_2_1_DATASET_REF } from "../terminal-bench-2-1/manifest.js";
import { TERMINAL_BENCH_3_0_DATASET_REF } from "../terminal-bench-3-0/manifest.js";
import {
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialHarborExecutionConformance,
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
  // Only the Terminal-Bench protocols bind via Harbor profiles; Verified, APEX-Agents, and
  // APEX-SWE-dev bind via their own selection manifests.
  return parsed.protocol === "terminal-bench-2.1" || parsed.protocol === "terminal-bench-3.0" ? parsed : undefined;
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
  readonly selectedTaskCount: number;
  readonly armCount: number;
  readonly replicates: number;
}

function methodBitsFromHarbor(input: {
  readonly manifest: HarborSelectionManifest;
  readonly suite: SuiteProtocolSelection;
}): {
  readonly coverage: SuiteProtocolSelection["coverage"];
  readonly executionConformance: boolean;
  readonly k: number;
  readonly selectedCount: number;
  readonly datasetCount: number;
  readonly atifPresent: boolean;
  readonly datasetRevisionMatchesLeaderboardPin: boolean;
} {
  return {
    coverage: input.suite.coverage,
    executionConformance: officialHarborExecutionConformance({
      k: input.manifest.retryPolicy.nAttempts,
      maxRetries: input.manifest.retryPolicy.maxRetries,
      jobGrain: input.manifest.jobGrain ?? "per-dispatch",
      environmentConfiguration: input.manifest.environment.configuration as Readonly<Record<string, unknown>>,
      harborVersion: input.manifest.harbor.version,
    }),
    k: input.suite.replicates,
    selectedCount: input.suite.selectedTaskNames.length,
    datasetCount: input.suite.datasetTaskCount,
    atifPresent: input.suite.atifRequired,
    datasetRevisionMatchesLeaderboardPin: input.suite.datasetRevision === officialPinFor(input.suite.protocol),
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
