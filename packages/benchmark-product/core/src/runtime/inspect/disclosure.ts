import type { VerdictRule } from "@jinn-network/task-execution-profiles";
import type { EvaluationRuntimeBinding, ResolvedAssurance } from "../../domain/draft.js";
import { deriveInspectEvaluationStrategy } from "./assurance.js";
import { readInspectSelectionManifest } from "./host.js";
import {
  INSPECT_ADAPTER_ID,
  isInspectMultiScorerSelection,
  type InspectSelectionManifest,
} from "./manifest.js";

export interface InspectScoringProjectionDisclosure {
  readonly measurementName: string;
  readonly scorerName: string;
  readonly subScoreKey?: string;
  readonly passValue: string | number | boolean | null;
}

export interface InspectRuntimeMethodDisclosure {
  readonly adapterId: typeof INSPECT_ADAPTER_ID;
  readonly selectionManifestSha256: string;
  readonly scorerNames: readonly string[];
  readonly projections: readonly InspectScoringProjectionDisclosure[];
  readonly verdictRule: VerdictRule;
  readonly verdictRuleText: string;
  readonly nativeAnalysis: {
    readonly metrics: unknown;
    readonly epochReducers: readonly string[] | null;
  };
  readonly evaluatorRelationship: "same-execution-scorer";
  readonly scoreSourceRelationship: "same-execution-scorer";
  readonly officialEvaluationRelationship: "same-execution-scorer" | "separate-log-verifier";
  readonly officialEvaluatorCount: number;
  readonly partyIndependence: "not-established";
}

function ruleText(rule: VerdictRule): string {
  if ("threshold" in rule) {
    return `${rule.threshold.measurement} ${rule.threshold.op} ${JSON.stringify(rule.threshold.value)}`;
  }
  if ("all" in rule) return `all(${rule.all.map(ruleText).join(", ")})`;
  if ("any" in rule) return `any(${rule.any.map(ruleText).join(", ")})`;
  if ("not" in rule) return `not(${ruleText(rule.not)})`;
  if ("inconclusiveWhen" in rule) {
    return `inconclusive[${rule.class}] when ${ruleText(rule.inconclusiveWhen)}`;
  }
  return "pass" in rule ? "pass" : "fail";
}

export function describeInspectRuntimeMethod(
  manifest: InspectSelectionManifest,
  selectionManifestSha256: string,
  assurance?: Readonly<Partial<ResolvedAssurance>>,
): InspectRuntimeMethodDisclosure {
  const strategy = deriveInspectEvaluationStrategy(assurance);
  const projections: readonly InspectScoringProjectionDisclosure[] = isInspectMultiScorerSelection(manifest)
    ? manifest.scoring.projections
    : [{
      measurementName: "inspect-score-pass",
      scorerName: manifest.scorer.name,
      passValue: manifest.scorer.passValue,
    }];
  const verdictRule: VerdictRule = isInspectMultiScorerSelection(manifest)
    ? manifest.scoring.verdictRule
    : { threshold: { measurement: "inspect-score-pass", op: "eq", value: true } };
  return {
    adapterId: INSPECT_ADAPTER_ID,
    selectionManifestSha256,
    scorerNames: isInspectMultiScorerSelection(manifest)
      ? manifest.scorers.map((scorer) => scorer.name)
      : [manifest.scorer.name],
    projections,
    verdictRule,
    verdictRuleText: ruleText(verdictRule),
    nativeAnalysis: isInspectMultiScorerSelection(manifest)
      ? {
        metrics: manifest.scoring.inspectMetrics,
        epochReducers: manifest.scoring.inspectEpochReducers,
      }
      : { metrics: null, epochReducers: null },
    evaluatorRelationship: "same-execution-scorer",
    scoreSourceRelationship: "same-execution-scorer",
    officialEvaluationRelationship: strategy === "embedded"
      ? "same-execution-scorer"
      : "separate-log-verifier",
    officialEvaluatorCount: assurance?.minVerdicts ?? 1,
    partyIndependence: "not-established",
  };
}

export function inspectRuntimeMethodForBinding(
  workspaceDir: string,
  binding: EvaluationRuntimeBinding | undefined,
  assurance?: Readonly<Partial<ResolvedAssurance>>,
): InspectRuntimeMethodDisclosure | undefined {
  if (binding?.adapterId !== INSPECT_ADAPTER_ID) return undefined;
  return describeInspectRuntimeMethod(
    readInspectSelectionManifest(workspaceDir, binding.selectionManifestSha256),
    binding.selectionManifestSha256,
    assurance,
  );
}
