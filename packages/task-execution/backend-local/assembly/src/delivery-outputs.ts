// SPDX-License-Identifier: Apache-2.0

import type { TaskSpecification } from "@jinn-network/task-execution-protocol";
import type { OutputArtifact } from "@jinn-network/task-execution-workspace";

/** One `DeliveryRecord.outputs` entry, structurally derived so a protocol change cannot drift it. */
export type DeliveryOutput = {
  readonly name: string;
  readonly mediaType?: string;
  readonly digest: { readonly sha256: string };
};

/**
 * Derives the sealed Delivery's declared `outputs` from a completed harvest (#39).
 *
 * The Task is the requester's signed contract and the profile is the law: a Delivery declares the
 * Task's declared outputs, nothing else. The harvest manifest is deliberately WIDER than that --
 * it collects the whole `out/` tree plus harness-written `logs/`, because the backend needs those
 * bytes for the attempt record, the evidence receipt, and `readResultEnvelope` (whose structured
 * envelope must be a contained, harvested `out/` path). None of that is a Task output.
 *
 * Sealing the raw manifest put every one of those files into the signed Delivery's `outputs`,
 * which the evaluator's `verifyEvaluationSubject` refuses: an undeclared name fails its Task-
 * declaration check, and the extra entries fail its cardinality check against the supplied
 * Results. The live gate's first-ever harness run refused exactly this way on
 * `structured-output.json` alongside a misnamed `prediction.json`.
 *
 * Nothing is lost by narrowing: the full manifest is still journaled, still on the attempt record,
 * and still in the evidence receipt. Only the signed contract narrows -- to what was asked for.
 *
 * A declared output the harness never wrote is simply absent (the harvest already records it as an
 * omission). This function never substitutes, renames, or invents an output.
 */
export function deliveryOutputsFromHarvest(
  manifest: readonly OutputArtifact[],
  declaredOutputs: TaskSpecification["outputs"],
): readonly DeliveryOutput[] {
  const declared = new Set(declaredOutputs.map((output) => output.name));
  return manifest
    .filter((artifact) => declared.has(artifact.path))
    .map((artifact) => ({
      name: artifact.path,
      ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
      digest: { sha256: String(artifact.sha256).replace(/^sha256:/u, "") },
    }));
}
