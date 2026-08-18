/** Inspect eval suite quote/lock/report facts. Not Harbor; not Inspect Hub. */
import {
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialInspectEvalConformance,
  suiteLeaderboardLimitation,
  type SuiteComparability,
} from "./comparability.js";
import type { SuiteQuotePresentation } from "./from-harbor.js";
import { allArmsRunComplete, accountSuiteArmCells, type MatrixCellAccount } from "./run-complete.js";
import type { InspectEvalSelectionManifest } from "../inspect-eval/manifest.js";

/**
 * `replicates` is the PLANNED k of the run being judged, never the sealed `suite.replicates`.
 * The manifest's own superRefine forces `suite.replicates === catalog.specifiedEpochs`, so
 * feeding the sealed value back into the conformance predicate would make its
 * `k === specifiedEpochs` check tautological — and `draft update` can move the planned
 * `replicates` after select. Planned k is what actually ran; that is what must be judged.
 */
function methodBitsFromInspect(manifest: InspectEvalSelectionManifest, replicates: number): {
  readonly protocol: "inspect-eval";
  readonly coverage: InspectEvalSelectionManifest["coverage"];
  readonly executionConformance: boolean;
  readonly k: number;
  readonly selectedCount: number;
  readonly datasetCount: number;
  readonly atifPresent: false;
  readonly datasetRevisionMatchesLeaderboardPin: boolean;
} {
  const suite = manifest.suite;
  return {
    protocol: "inspect-eval",
    coverage: suite.coverage,
    executionConformance: officialInspectEvalConformance({
      k: replicates,
      specifiedEpochs: manifest.catalog.specifiedEpochs,
      inspectVersion: manifest.inspect.runtime.inspectVersion,
      adapterId: "inspect",
      solver: manifest.solver,
      sampleLimit: manifest.sampleLimit,
      epochsInRunOptions: Object.prototype.hasOwnProperty.call(manifest.inspect.runOptions, "epochs"),
    }),
    k: replicates,
    selectedCount: suite.selectedTaskNames.length,
    datasetCount: suite.datasetTaskCount,
    atifPresent: false,
    datasetRevisionMatchesLeaderboardPin: suite.datasetRevision === manifest.catalog.snapshotSha256
      && suite.replicates === manifest.catalog.specifiedEpochs,
  };
}

function presentInspectQuote(
  input: {
    readonly armCount: number;
    readonly itemCount: number;
    readonly replicates: number;
  },
  manifest: InspectEvalSelectionManifest,
  bits: SuiteComparability,
  eligible: boolean,
): SuiteQuotePresentation {
  return {
    ...bits,
    methodLeaderboardEligible: eligible,
    cellCount: `${input.itemCount} × ${input.armCount} × ${input.replicates}`,
    inspectVersion: manifest.inspect.runtime.inspectVersion,
    selectedTaskCount: manifest.suite.selectedTaskNames.length,
    armCount: input.armCount,
    replicates: input.replicates,
  };
}

export function suiteQuoteFromInspect(input: {
  readonly manifest: InspectEvalSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
}): SuiteQuotePresentation {
  const method = methodBitsFromInspect(input.manifest, input.replicates);
  return presentInspectQuote(input, input.manifest, deriveSuiteComparability(method), methodLeaderboardEligible(method));
}

export function suiteFactsFromInspectManifest(input: {
  readonly manifest: InspectEvalSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
}): { readonly quote: SuiteQuotePresentation; readonly limitation: string | undefined } {
  const quote = suiteQuoteFromInspect(input);
  return { quote, limitation: suiteLeaderboardLimitation(quote, "inspect-eval") };
}

export function suiteFactsFromAccountedInspectRun(input: {
  readonly manifest: InspectEvalSelectionManifest;
  readonly armCount: number;
  readonly itemCount: number;
  readonly replicates: number;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly armIds: readonly string[];
}): { readonly quote: SuiteQuotePresentation; readonly limitation: string | undefined } {
  const method = methodBitsFromInspect(input.manifest, input.replicates);
  const complete = allArmsRunComplete(input.armIds.map((armId) => ({
    cellsAccounted: accountSuiteArmCells(input.matrix, input.manifest.suite, armId),
    atifOnRetainedJob: false,
  })));
  const bits = deriveSuiteComparability({
    ...method,
    cellsAccounted: complete.cellsAccounted,
  });
  const quote = presentInspectQuote(input, input.manifest, bits, methodLeaderboardEligible(method));
  return { quote, limitation: suiteLeaderboardLimitation(quote, "inspect-eval") };
}

export function suiteComparabilityForInspectArm(input: {
  readonly manifest: InspectEvalSelectionManifest;
  readonly replicates: number;
  readonly matrix: { readonly cells: readonly MatrixCellAccount[] };
  readonly armId: string;
}): SuiteComparability {
  const method = methodBitsFromInspect(input.manifest, input.replicates);
  return deriveSuiteComparability({
    ...method,
    cellsAccounted: accountSuiteArmCells(input.matrix, input.manifest.suite, input.armId),
  });
}
