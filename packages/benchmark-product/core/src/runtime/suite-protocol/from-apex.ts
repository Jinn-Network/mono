import {
  APEX_AGENTS_DATASET_REVISION,
  APEX_AGENTS_DATASET_TASK_COUNT,
  type ApexAgentsSelectionManifest,
} from "../apex-agents/manifest.js";
import {
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialArchipelagoConformance,
  suiteLeaderboardLimitation,
  type SuiteComparability,
} from "./comparability.js";
import type { SuiteProtocolSelection } from "./manifest.js";
import { accountSuiteArmCells, type MatrixCellAccount } from "./run-complete.js";
import { archipelagoGradesPresent } from "../apex-agents/grades.js";
import type { SuiteQuotePresentation } from "./from-harbor.js";

export function suiteSelectionFromApex(manifest: ApexAgentsSelectionManifest): SuiteProtocolSelection {
  return manifest.suite;
}

/**
 * Test seam only. Production callers leave it unset so the sealed 480-task size applies;
 * a fixture dataset passes its own size to exercise the eligible branch without 480 tasks.
 */
export interface OfficialApexDatasetSize {
  readonly officialDatasetTaskCount?: number;
}

function methodBitsFromApex(
  manifest: ApexAgentsSelectionManifest,
  officialDatasetTaskCount: number = APEX_AGENTS_DATASET_TASK_COUNT,
): {
  readonly protocol: "apex-agents";
  readonly coverage: SuiteProtocolSelection["coverage"];
  readonly executionConformance: boolean;
  readonly k: number;
  readonly selectedCount: number;
  readonly datasetCount: number;
  readonly atifPresent: boolean;
  readonly datasetRevisionMatchesLeaderboardPin: boolean;
  readonly datasetCountMatchesLeaderboardPin: boolean;
} {
  const suite = manifest.suite;
  return {
    protocol: "apex-agents",
    coverage: suite.coverage,
    executionConformance: officialArchipelagoConformance({
      k: suite.replicates,
      archipelagoCommit: manifest.archipelago.commit,
      agentId: manifest.archipelago.agentId,
      maxSteps: manifest.archipelago.maxSteps,
      timeoutSeconds: manifest.archipelago.timeoutSeconds,
      judgeModel: manifest.archipelago.judgeModel,
      judgeThinking: manifest.archipelago.judgeThinking,
      webSearch: manifest.archipelago.webSearch,
      timeoutOverride: manifest.archipelago.timeoutOverride,
      resourceOverride: manifest.archipelago.resourceOverride,
      evaluatorId: manifest.archipelago.adapterId,
    }),
    k: suite.replicates,
    selectedCount: suite.selectedTaskNames.length,
    datasetCount: suite.datasetTaskCount,
    atifPresent: suite.atifRequired,
    datasetRevisionMatchesLeaderboardPin: suite.datasetRevision === APEX_AGENTS_DATASET_REVISION,
    datasetCountMatchesLeaderboardPin: suite.datasetTaskCount === officialDatasetTaskCount,
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

export function suiteQuoteFromApex(input: {
  readonly manifest: ApexAgentsSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
} & OfficialApexDatasetSize): SuiteQuotePresentation {
  const suite = suiteSelectionFromApex(input.manifest);
  const method = methodBitsFromApex(input.manifest, input.officialDatasetTaskCount);
  return presentSuiteQuote(input, suite, deriveSuiteComparability(method), methodLeaderboardEligible(method), input.manifest.archipelago.commit);
}

export function suiteFactsFromApexManifest(input: {
  readonly manifest: ApexAgentsSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
} & OfficialApexDatasetSize): { readonly quote: SuiteQuotePresentation; readonly limitation: string | undefined } {
  const quote = suiteQuoteFromApex(input);
  return { quote, limitation: suiteLeaderboardLimitation(quote, "apex-agents") };
}

export function suiteFactsFromAccountedApexRun(input: {
  readonly manifest: ApexAgentsSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly armIds: readonly string[];
  readonly reportRoot: string;
} & OfficialApexDatasetSize): { readonly quote: SuiteQuotePresentation; readonly limitation: string | undefined } {
  const suite = suiteSelectionFromApex(input.manifest);
  const method = methodBitsFromApex(input.manifest, input.officialDatasetTaskCount);
  const cellsAccounted = input.armIds.length > 0
    && input.armIds.every((armId) => accountSuiteArmCells(input.matrix, suite, armId));
  const grades = archipelagoGradesPresent({
    reportRoot: input.reportRoot,
    taskIds: suite.selectedTaskNames,
  });
  const bits = deriveSuiteComparability({ ...method, cellsAccounted, archipelagoGradesPresent: grades });
  const quote = presentSuiteQuote(input, suite, bits, methodLeaderboardEligible(method), input.manifest.archipelago.commit);
  return { quote, limitation: suiteLeaderboardLimitation(quote, "apex-agents") };
}

export function suiteComparabilityForApexArm(input: {
  readonly manifest: ApexAgentsSelectionManifest;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly armId: string;
  readonly reportRoot: string;
} & OfficialApexDatasetSize): SuiteComparability {
  const suite = suiteSelectionFromApex(input.manifest);
  const method = methodBitsFromApex(input.manifest, input.officialDatasetTaskCount);
  const cellsAccounted = accountSuiteArmCells(input.matrix, suite, input.armId);
  const grades = archipelagoGradesPresent({
    reportRoot: input.reportRoot,
    taskIds: suite.selectedTaskNames,
  });
  return deriveSuiteComparability({ ...method, cellsAccounted, archipelagoGradesPresent: grades });
}
