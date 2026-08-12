// SPDX-License-Identifier: MIT

import { BENCHMARKING_METHOD_IDS, BENCHMARKING_METHOD_VERSION } from "@jinn-network/benchmarking-records";
import { prefixedDigest } from "@jinn-network/policy-identity";
import { refuse } from "./errors.js";
import type { CampaignObjective, ObjectiveMethodRef } from "./types.js";

export const POLICY_OPTIMIZATION_OBJECTIVE_PRESETS = [
  "more-tasks-succeed@1",
  "same-success-lower-cost@1",
] as const;
export type PolicyOptimizationObjectivePreset = (typeof POLICY_OPTIMIZATION_OBJECTIVE_PRESETS)[number];

export interface CompileObjectivePresetInput {
  readonly baselineArm: string;
  readonly candidateArm: string;
  /** Required by the cost preset; exact sealed split-manifest bytes. */
  readonly splitManifestBytes?: Uint8Array;
  readonly splitManifestDigest?: string;
}

/** Domain-separated deterministic xorshift seed in the method's frozen uint32 range. */
export function noninferioritySeedFromSplitManifest(bytes: Uint8Array, digest: string): number {
  if (prefixedDigest(bytes) !== digest) {
    refuse("invalid-document", "splitManifestDigest", "split manifest bytes do not match their declared digest");
  }
  const domain = new TextEncoder().encode(
    `network.jinn.policy-optimization/noninferiority-iut-seed/1\0${digest}`,
  );
  const seedDigest = prefixedDigest(domain).slice("sha256:".length);
  const value = Number.parseInt(seedDigest.slice(0, 8), 16);
  return value === 0 ? 1 : value;
}

function ref(id: string, parameters: ObjectiveMethodRef["parameters"]): ObjectiveMethodRef {
  return { id, version: BENCHMARKING_METHOD_VERSION, parameters };
}

/** Named product objectives compile only to registry-owned, versioned MethodRefs. */
export function compileObjectivePreset(
  preset: PolicyOptimizationObjectivePreset,
  input: CompileObjectivePresetInput,
): CampaignObjective {
  if (input.baselineArm.length === 0 || input.candidateArm.length === 0
    || input.baselineArm === input.candidateArm) {
    refuse("invalid-document", "objective", "baseline and candidate must be distinct non-empty arm identities");
  }
  if (preset === "more-tasks-succeed@1") {
    return {
      methods: [
        ref(BENCHMARKING_METHOD_IDS.avgAtK, { verdictRule: "sole" }),
        ref(BENCHMARKING_METHOD_IDS.pairedMcnemar, {
          verdictRule: "sole", baseline: input.baselineArm, candidate: input.candidateArm,
        }),
        ref(BENCHMARKING_METHOD_IDS.provenanceClusterSign, {
          verdictRule: "sole", baseline: input.baselineArm, candidate: input.candidateArm,
        }),
      ],
      constraints: [],
    };
  }
  if (preset === "same-success-lower-cost@1") {
    if (input.splitManifestBytes === undefined || input.splitManifestDigest === undefined) {
      refuse("invalid-document", "splitManifest", "the cost preset derives its deterministic seed from exact split-manifest bytes");
    }
    return {
      methods: [ref(BENCHMARKING_METHOD_IDS.noninferiorityIut, {
        verdictRule: "sole",
        baseline: input.baselineArm,
        candidate: input.candidateArm,
        resamples: 10_000,
        seed: noninferioritySeedFromSplitManifest(input.splitManifestBytes, input.splitManifestDigest),
      })],
      constraints: [],
    };
  }
  refuse("invalid-document", "objectivePreset", `unsupported objective preset ${String(preset)}`);
}
