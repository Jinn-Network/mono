import type { ResourceDescriptor } from "@jinn-network/task-execution-evaluation-harness";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import type { ResolvedAssurance } from "../../domain/draft.js";
import { sha256Hex } from "../../workspace/sealed-store.js";
import type { InspectSelectionManifest } from "./manifest.js";

export type InspectEvaluationStrategy = "embedded" | "separate-log-verification";

export const INSPECT_SEPARATE_ASSURANCE_LIMITATIONS = [
  "Inspect scores came from scorers in the same task execution; official verdicts separately verified the sealed projection from the native log.",
  "Separate verifier processes and evaluator keys on this self-run venue do not establish a separate real-world party.",
  "Log verification is not independent rescoring and does not establish method diversity.",
] as const;

export function inspectLogVerifierParser(manifest: InspectSelectionManifest) {
  return {
    id: "benchmark-product-inspect-score-projection",
    version: manifest.runtime.adapterVersion,
    digest: `sha256:${manifest.runtime.workerSha256}` as const,
  };
}

/** The sole embedded case is the exact disclosed singleton policy. Every other valid policy
 * receives ordinary separate evaluation legs so an override can never accidentally retain an
 * embedded vote. */
export function deriveInspectEvaluationStrategy(
  assurance: Readonly<Partial<ResolvedAssurance>> | undefined,
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
): ResourceDescriptor {
  const method = {
    schema: "jinn.network/benchmark-product/inspect-log-verifier-method/1",
    selectionManifestSha256,
    adapterVersion: manifest.runtime.adapterVersion,
    workerSha256: manifest.runtime.workerSha256,
    inspectVersion: manifest.runtime.inspectVersion,
  } as const;
  return {
    name: "benchmark-product-inspect-log-verifier",
    digest: { sha256: sha256Hex(canonicalJsonBytes(method)) },
  };
}
