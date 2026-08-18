import type { SwebenchVerifiedSelectionManifest } from "../swe-bench-verified/manifest.js";
import {
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialSwebenchHarnessConformance,
  suiteLeaderboardLimitation,
  type SuiteComparability,
} from "./comparability.js";
import type { SuiteProtocolSelection } from "./manifest.js";
import { accountSuiteArmCells, type MatrixCellAccount } from "./run-complete.js";
import { harnessReportsPresent } from "../swe-bench-verified/reports.js";
import type { SuiteQuotePresentation } from "./from-harbor.js";

export function suiteSelectionFromSwebench(manifest: SwebenchVerifiedSelectionManifest): SuiteProtocolSelection {
  return manifest.suite;
}

function methodBitsFromSwebench(manifest: SwebenchVerifiedSelectionManifest): {
  readonly protocol: "swe-bench-verified";
  readonly coverage: SuiteProtocolSelection["coverage"];
  readonly executionConformance: boolean;
  readonly k: number;
  readonly selectedCount: number;
  readonly datasetCount: number;
  readonly atifPresent: boolean;
  readonly datasetRevisionMatchesLeaderboardPin: boolean;
} {
  const suite = manifest.suite;
  return {
    protocol: "swe-bench-verified",
    coverage: suite.coverage,
    executionConformance: officialSwebenchHarnessConformance({
      k: suite.replicates,
      harnessVersion: manifest.harness.version,
      timeoutSeconds: manifest.harness.timeoutSeconds,
      timeoutOverride: manifest.harness.timeoutOverride,
      resourceOverride: manifest.harness.resourceOverride,
      evaluatorId: manifest.harness.adapterId,
    }),
    k: suite.replicates,
    selectedCount: suite.selectedTaskNames.length,
    datasetCount: suite.datasetTaskCount,
    atifPresent: suite.atifRequired,
    datasetRevisionMatchesLeaderboardPin: suite.datasetRevision === manifest.dataset.revision,
  };
}

function presentSuiteQuote(
  input: { readonly armCount: number; readonly itemCount: number; readonly replicates: number },
  suite: SuiteProtocolSelection,
  bits: SuiteComparability,
  eligible: boolean,
  harnessVersion: string,
): SuiteQuotePresentation {
  return {
    ...bits,
    methodLeaderboardEligible: eligible,
    cellCount: `${input.itemCount} × ${input.armCount} × ${input.replicates}`,
    harnessVersion,
    selectedTaskCount: suite.selectedTaskNames.length,
    armCount: input.armCount,
    replicates: input.replicates,
  };
}

export function suiteQuoteFromSwebench(input: {
  readonly manifest: SwebenchVerifiedSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
}): SuiteQuotePresentation {
  const suite = suiteSelectionFromSwebench(input.manifest);
  const method = methodBitsFromSwebench(input.manifest);
  return presentSuiteQuote(input, suite, deriveSuiteComparability(method), methodLeaderboardEligible(method), input.manifest.harness.version);
}

export function suiteFactsFromSwebenchManifest(input: {
  readonly manifest: SwebenchVerifiedSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
}): { readonly quote: SuiteQuotePresentation; readonly limitation: string | undefined } {
  const quote = suiteQuoteFromSwebench(input);
  return { quote, limitation: suiteLeaderboardLimitation(quote, "swe-bench-verified") };
}

export function suiteFactsFromAccountedSwebenchRun(input: {
  readonly manifest: SwebenchVerifiedSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly armIds: readonly string[];
  readonly reportRoot: string;
  readonly runId: string;
  readonly modelNameOrPathByArm: Readonly<Record<string, string>>;
}): { readonly quote: SuiteQuotePresentation; readonly limitation: string | undefined } {
  const suite = suiteSelectionFromSwebench(input.manifest);
  const method = methodBitsFromSwebench(input.manifest);
  const cellsAccounted = input.armIds.length > 0
    && input.armIds.every((armId) => accountSuiteArmCells(input.matrix, suite, armId));
  const reports = input.armIds.length > 0 && input.armIds.every((armId) => harnessReportsPresent({
    reportRoot: input.reportRoot,
    runId: input.runId,
    modelNameOrPath: input.modelNameOrPathByArm[armId] ?? armId,
    instanceIds: suite.selectedTaskNames,
  }));
  const bits = deriveSuiteComparability({ ...method, cellsAccounted, harnessReportsPresent: reports });
  const quote = presentSuiteQuote(input, suite, bits, methodLeaderboardEligible(method), input.manifest.harness.version);
  return { quote, limitation: suiteLeaderboardLimitation(quote, "swe-bench-verified") };
}

export function suiteComparabilityForSwebenchArm(input: {
  readonly manifest: SwebenchVerifiedSelectionManifest;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly armId: string;
  readonly reportRoot: string;
  readonly runId: string;
  readonly modelNameOrPath: string;
}): SuiteComparability {
  const suite = suiteSelectionFromSwebench(input.manifest);
  const method = methodBitsFromSwebench(input.manifest);
  const cellsAccounted = accountSuiteArmCells(input.matrix, suite, input.armId);
  const reports = harnessReportsPresent({
    reportRoot: input.reportRoot,
    runId: input.runId,
    modelNameOrPath: input.modelNameOrPath,
    instanceIds: suite.selectedTaskNames,
  });
  return deriveSuiteComparability({ ...method, cellsAccounted, harnessReportsPresent: reports });
}
