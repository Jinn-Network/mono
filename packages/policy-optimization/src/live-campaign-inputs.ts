// SPDX-License-Identifier: MIT

import { canonicalJsonBytes, compareCodeUnitStrings, prefixedDigest, type JsonValue } from "@jinn-network/policy-identity";
import { refuse } from "./errors.js";
import {
  parseExactNextRunPolicySnapshot,
  type NextRunRoute,
} from "./next-run-policy-snapshot.js";
import {
  compileObjectivePreset,
  POLICY_OPTIMIZATION_OBJECTIVE_PRESETS,
  type PolicyOptimizationObjectivePreset,
} from "./objective-presets.js";
import { parseExactPolicyOptimizationSplitManifest } from "./split-manifest.js";
import type {
  PolicyOptimizationAllocationPreset,
  PolicyOptimizationJourney,
} from "./split-manifest.js";
import { SAME_OPERATOR_EVALUATION_LIMITATION } from "./recommendation.js";
import type { CampaignObjective } from "./types.js";

export const LIVE_CAMPAIGN_INPUTS_FORMAT_TOKEN =
  "network.jinn.policy-optimization.live-campaign-inputs/1.0" as const;
export const LIVE_CAMPAIGN_AUTHORING_FORMAT_TOKEN =
  "network.jinn.policy-optimization.live-campaign-authoring/1.0" as const;

export interface LiveCampaignCompileInput {
  readonly snapshotBytes: Uint8Array;
  readonly splitManifestBytes: Uint8Array;
  readonly objectivePreset: PolicyOptimizationObjectivePreset;
  readonly baselineArm: string;
  readonly candidateArm: string;
  readonly replicates: number;
  readonly candidatePayloadRisks: readonly string[];
}

export interface LiveCampaignInputs {
  readonly formatToken: typeof LIVE_CAMPAIGN_INPUTS_FORMAT_TOKEN;
  readonly route: NextRunRoute;
  readonly configRevision: string;
  readonly snapshotDigest: string;
  readonly splitManifestDigest: string;
  readonly seed: { readonly kind: "tuple"; readonly digest: string };
  readonly journey: PolicyOptimizationJourney;
  readonly allocationPreset: PolicyOptimizationAllocationPreset;
  readonly pool: {
    readonly snapshotDigest: string;
    readonly eligibleGroups: number;
    readonly exclusions: readonly { readonly id: string; readonly reason: string }[];
  };
  readonly evidenceAccess: {
    readonly exploration: {
      readonly proposerGroups: readonly string[];
      readonly selectionGroups: readonly string[];
    };
    readonly confirmationGroups: readonly string[];
    readonly challengerSource: "selected-from-exploration" | "operator-supplied";
    readonly freezeChallengerBeforeConfirmationReveal: true;
    readonly consumeConfirmationOnFirstRevealOrDispatch: true;
  };
  readonly objectivePreset: PolicyOptimizationObjectivePreset;
  readonly objective: CampaignObjective;
  readonly arms: { readonly baseline: string; readonly candidate: string };
  readonly candidatePayloadRisks: readonly string[];
  readonly executionCells: {
    readonly replicates: number;
    readonly selection: number;
    readonly confirmation: number;
    readonly total: number;
  };
  readonly independence: "disclosed";
  readonly limitations: readonly [typeof SAME_OPERATOR_EVALUATION_LIMITATION];
}

export interface SealedLiveCampaignInputs {
  readonly campaign: LiveCampaignInputs;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnitStrings);
}

export function compileLiveCampaignInputs(input: LiveCampaignCompileInput): SealedLiveCampaignInputs {
  if (!Number.isSafeInteger(input.replicates) || input.replicates < 1) {
    refuse("invalid-document", "replicates", "replicates must be a positive safe integer");
  }
  const snapshot = parseExactNextRunPolicySnapshot(input.snapshotBytes);
  const split = parseExactPolicyOptimizationSplitManifest(input.splitManifestBytes);
  const snapshotDigest = prefixedDigest(input.snapshotBytes);
  const splitManifestDigest = prefixedDigest(input.splitManifestBytes);
  if (split.seed.snapshotDigest !== snapshotDigest || split.seed.tupleDigest !== snapshot.seed.digest) {
    refuse("invalid-document", "splitManifest.seed", "split manifest does not bind the exact next-run snapshot and tuple seed");
  }
  const objective = compileObjectivePreset(input.objectivePreset, {
    baselineArm: input.baselineArm,
    candidateArm: input.candidateArm,
    splitManifestBytes: input.splitManifestBytes,
    splitManifestDigest,
  });
  const selection = split.assignments.development.length * 2 * input.replicates;
  const confirmation = split.assignments.promotion.length * 2 * input.replicates;
  if (!Number.isSafeInteger(selection + confirmation)) {
    refuse("invalid-document", "executionCells", "execution cell count exceeds safe integer range");
  }
  const campaign: LiveCampaignInputs = {
    formatToken: LIVE_CAMPAIGN_INPUTS_FORMAT_TOKEN,
    route: snapshot.route,
    configRevision: snapshot.configRevision,
    snapshotDigest,
    splitManifestDigest,
    seed: { kind: "tuple", digest: snapshot.seed.digest },
    journey: split.allocation.journey,
    allocationPreset: split.allocation.preset,
    pool: {
      snapshotDigest: split.poolSnapshot.digest,
      eligibleGroups: split.groups.length,
      exclusions: split.exclusions.map((entry) => ({ ...entry })),
    },
    evidenceAccess: {
      exploration: {
        proposerGroups: [...split.assignments.training],
        selectionGroups: [...split.assignments.development],
      },
      confirmationGroups: [...split.assignments.promotion],
      challengerSource: split.allocation.journey === "explore-confirm"
        ? "selected-from-exploration"
        : "operator-supplied",
      freezeChallengerBeforeConfirmationReveal: true,
      consumeConfirmationOnFirstRevealOrDispatch: true,
    },
    objectivePreset: input.objectivePreset,
    objective,
    arms: { baseline: input.baselineArm, candidate: input.candidateArm },
    candidatePayloadRisks: sortedUnique(input.candidatePayloadRisks),
    executionCells: {
      replicates: input.replicates,
      selection,
      confirmation,
      total: selection + confirmation,
    },
    independence: "disclosed",
    limitations: [SAME_OPERATOR_EVALUATION_LIMITATION],
  };
  const bytes = canonicalJsonBytes(campaign as unknown as JsonValue);
  return { campaign, bytes, digest: prefixedDigest(bytes) };
}

export interface LiveCampaignAuthoringDocument {
  readonly formatToken: typeof LIVE_CAMPAIGN_AUTHORING_FORMAT_TOKEN;
  readonly snapshotBase64: string;
  readonly splitManifestBase64: string;
  readonly objectivePreset: PolicyOptimizationObjectivePreset;
  readonly baselineArm: string;
  readonly candidateArm: string;
  readonly replicates: number;
  readonly candidatePayloadRisks: readonly string[];
}

function decodeExactBase64(value: unknown, path: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    refuse("invalid-document", path, "exact standard base64 is required");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) refuse("invalid-document", path, "base64 spelling is not exact");
  return bytes;
}

export function compileLiveCampaignAuthoringDocument(bytes: Uint8Array): SealedLiveCampaignInputs {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { refuse("invalid-document", "document", "authoring document must be UTF-8 JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse("invalid-document", "document", "authoring document must be an object");
  }
  const document = value as Record<string, unknown>;
  const expectedKeys = [
    "formatToken", "snapshotBase64", "splitManifestBase64", "objectivePreset",
    "baselineArm", "candidateArm", "replicates", "candidatePayloadRisks",
  ].sort();
  const actualKeys = Object.keys(document).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    refuse("invalid-document", "document", "authoring document has missing or unknown fields");
  }
  const canonical = canonicalJsonBytes(document as JsonValue);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
    refuse("invalid-document", "document", "authoring document is not exact canonical JSON");
  }
  if (document["formatToken"] !== LIVE_CAMPAIGN_AUTHORING_FORMAT_TOKEN
    || !POLICY_OPTIMIZATION_OBJECTIVE_PRESETS.includes(document["objectivePreset"] as PolicyOptimizationObjectivePreset)
    || typeof document["baselineArm"] !== "string"
    || typeof document["candidateArm"] !== "string"
    || typeof document["replicates"] !== "number"
    || !Array.isArray(document["candidatePayloadRisks"])
    || document["candidatePayloadRisks"].some((risk) => typeof risk !== "string" || risk.length === 0)) {
    refuse("invalid-document", "document", "authoring document fields are invalid");
  }
  return compileLiveCampaignInputs({
    snapshotBytes: decodeExactBase64(document["snapshotBase64"], "snapshotBase64"),
    splitManifestBytes: decodeExactBase64(document["splitManifestBase64"], "splitManifestBase64"),
    objectivePreset: document["objectivePreset"] as PolicyOptimizationObjectivePreset,
    baselineArm: document["baselineArm"] as string,
    candidateArm: document["candidateArm"] as string,
    replicates: document["replicates"] as number,
    candidatePayloadRisks: document["candidatePayloadRisks"] as string[],
  });
}
