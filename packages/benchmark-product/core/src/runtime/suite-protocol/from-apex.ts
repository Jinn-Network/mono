import type { ApexSweDevSelectionManifest } from "../apex-swe-dev/manifest.js";
import { harnessReportsPresent } from "../apex-swe-dev/reports.js";
import {
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialApexSweDevConformance,
  suiteLeaderboardLimitation,
  type SuiteComparability,
} from "./comparability.js";
import type { SuiteQuotePresentation } from "./from-harbor.js";
import type { ApexSweDevSuiteProtocolSelection } from "./manifest.js";
import { accountSuiteArmCells, type MatrixCellAccount } from "./run-complete.js";

export function suiteSelectionFromApexSweDev(manifest: ApexSweDevSelectionManifest): ApexSweDevSuiteProtocolSelection {
  return manifest.suite;
}

function methodBitsFromApex(manifest: ApexSweDevSelectionManifest): {
  readonly protocol: "apex-swe-dev";
  readonly coverage: ApexSweDevSuiteProtocolSelection["coverage"];
  readonly executionConformance: boolean;
  readonly k: number;
  readonly selectedCount: number;
  readonly datasetCount: number;
  readonly atifPresent: boolean;
  readonly datasetRevisionMatchesLeaderboardPin: boolean;
} {
  const suite = manifest.suite;
  return {
    protocol: "apex-swe-dev",
    coverage: suite.coverage,
    // Defense in depth, not a runtime check: every input below is already a `z.literal` in
    // `ApexSweDevSelectionManifestSchema`, so a parsed manifest cannot reach here non-conforming.
    // Re-deriving the bit keeps the published conformance claim independent of the schema pins.
    executionConformance: officialApexSweDevConformance({
      k: suite.replicates,
      nTrials: manifest.harness.nTrials,
      timeoutSeconds: manifest.harness.timeoutSeconds,
      timeoutOverride: manifest.harness.timeoutOverride,
      resourceOverride: manifest.harness.resourceOverride,
      evaluatorId: manifest.harness.adapterId,
      messageLimit: manifest.harness.messageLimit,
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
  suite: ApexSweDevSuiteProtocolSelection,
  bits: SuiteComparability,
  eligible: boolean,
  apxVersion: string,
): SuiteQuotePresentation {
  return {
    ...bits,
    methodLeaderboardEligible: eligible,
    cellCount: `${input.itemCount} × ${input.armCount} × ${input.replicates}`,
    harnessVersion: apxVersion,
    selectedTaskCount: suite.selectedTaskNames.length,
    armCount: input.armCount,
    replicates: input.replicates,
  };
}

export function suiteQuoteFromApexSweDev(input: {
  readonly manifest: ApexSweDevSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
}): SuiteQuotePresentation {
  const suite = suiteSelectionFromApexSweDev(input.manifest);
  const method = methodBitsFromApex(input.manifest);
  return presentSuiteQuote(input, suite, deriveSuiteComparability(method), methodLeaderboardEligible(method), input.manifest.harness.apxVersion);
}

export function suiteFactsFromAccountedApexSweDevRun(input: {
  readonly manifest: ApexSweDevSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly armIds: readonly string[];
  readonly reportRoot: string;
}): { readonly quote: SuiteQuotePresentation; readonly limitation: string | undefined } {
  const suite = suiteSelectionFromApexSweDev(input.manifest);
  const method = methodBitsFromApex(input.manifest);
  const cellsAccounted = input.armIds.length > 0
    && input.armIds.every((armId) => accountSuiteArmCells(input.matrix, suite, armId));
  const reports = harnessReportsPresent({
    reportRoot: input.reportRoot,
    tasks: input.manifest.selectedTasks,
  });
  const bits = deriveSuiteComparability({ ...method, cellsAccounted, harnessReportsPresent: reports });
  const quote = presentSuiteQuote(input, suite, bits, methodLeaderboardEligible(method), input.manifest.harness.apxVersion);
  return { quote, limitation: suiteLeaderboardLimitation(quote, "apex-swe-dev") };
}

export function suiteComparabilityForApexSweDevArm(input: {
  readonly manifest: ApexSweDevSelectionManifest;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly armId: string;
  readonly reportRoot: string;
}): SuiteComparability {
  const suite = suiteSelectionFromApexSweDev(input.manifest);
  const method = methodBitsFromApex(input.manifest);
  const cellsAccounted = accountSuiteArmCells(input.matrix, suite, input.armId);
  const reports = harnessReportsPresent({
    reportRoot: input.reportRoot,
    tasks: input.manifest.selectedTasks,
  });
  return deriveSuiteComparability({ ...method, cellsAccounted, harnessReportsPresent: reports });
}
