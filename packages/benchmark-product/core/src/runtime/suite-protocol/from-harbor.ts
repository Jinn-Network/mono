import { harborSuiteMethodFacts, type SuiteMethodFacts } from "@colophon-claims/check";
import type { HarborSelectionManifest } from "../harbor/manifest.js";
import {
  deriveSuiteComparability,
  methodLeaderboardEligible,
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


export function taskNameByDigestFromSuite(suite: SuiteProtocolSelection): Readonly<Record<string, string>> {
  return Object.fromEntries(suite.items.map((item) => [item.taskSha256, item.taskName]));
}

export function digestByTaskNameFromSuite(suite: SuiteProtocolSelection): Readonly<Record<string, string>> {
  // Inverse of `taskNameByDigestFromSuite`. Named Harbor import uses this table as the front door.
  return Object.fromEntries(suite.items.map((item) => [item.taskName, item.taskSha256]));
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
}): SuiteMethodFacts {
  // The checker's, so `report` and a reader of a bundle declaring `suite-comparability` decide the
  // method half from the same fields of the same sealed manifest (issue #4761).
  return harborSuiteMethodFacts(input.manifest, input.suite);
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
