import type { VerdictRule } from "@jinn-network/task-execution-profiles";
import {
  INSPECT_ADAPTER_ID,
  isInspectMultiScorerSelection,
  type InspectSelectionManifest,
} from "./inspect-manifest.js";

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

/** Public method disclosure derived only from the authenticated Inspect selection. */
export function describeInspectRuntimeMethod(
  manifest: InspectSelectionManifest,
  selectionManifestSha256: string,
): InspectRuntimeMethodDisclosure {
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
  };
}
