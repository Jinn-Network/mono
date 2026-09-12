import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import type { InspectSelectionManifest } from "./inspect-manifest.js";

export interface InspectAssurance {
  readonly independence?: string;
  readonly minVerdicts?: number;
  readonly distinctEvaluator?: boolean;
  readonly verdictRule?: string;
}

export type InspectEvaluationStrategy = "embedded" | "separate-log-verification";

export const INSPECT_SEPARATE_ASSURANCE_LIMITATIONS = [
  "Inspect scores came from scorers in the same task execution; official verdicts separately verified the sealed projection from the native log.",
  "Separate verifier processes and evaluator keys on this self-run venue do not establish a separate real-world party.",
  "Log verification is not independent rescoring and does not establish method diversity.",
] as const;

export function deriveInspectEvaluationStrategy(
  assurance: Readonly<InspectAssurance> | undefined,
): InspectEvaluationStrategy {
  return (assurance?.independence ?? "disclosed") === "disclosed"
    && (assurance?.minVerdicts ?? 1) === 1
    && (assurance?.distinctEvaluator ?? false) === false
    && (assurance?.verdictRule ?? "sole") === "sole"
    ? "embedded"
    : "separate-log-verification";
}

export function inspectLogVerifierMethod(
  manifest: InspectSelectionManifest,
  selectionManifestSha256: string,
) {
  const method = {
    schema: "jinn.network/benchmark-product/inspect-log-verifier-method/1",
    selectionManifestSha256,
    adapterVersion: manifest.runtime.adapterVersion,
    workerSha256: manifest.runtime.workerSha256,
    inspectVersion: manifest.runtime.inspectVersion,
  } as const;
  return {
    name: "benchmark-product-inspect-log-verifier",
    digest: {
      sha256: createHash("sha256").update(canonicalJsonBytes(method)).digest("hex"),
    },
  } as const;
}
