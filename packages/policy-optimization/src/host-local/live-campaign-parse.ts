// SPDX-License-Identifier: MIT

import { canonicalJsonBytes, type JsonValue } from "@jinn-network/policy-identity";
import { z } from "zod";
import {
  LIVE_CAMPAIGN_INPUTS_FORMAT_TOKEN,
  normalizeAffectedRoutes,
  type LiveCampaignInputs,
} from "../live-campaign-inputs.js";
import { SAME_OPERATOR_EVALUATION_LIMITATION } from "../recommendation.js";
import { HostStateError } from "./state.js";

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const NonEmpty = z.string().min(1);
const Method = z.strictObject({
  id: NonEmpty,
  version: NonEmpty,
  parameters: z.record(z.string(), z.json()),
});
const CampaignSchema = z.strictObject({
  formatToken: z.literal(LIVE_CAMPAIGN_INPUTS_FORMAT_TOKEN),
  route: z.strictObject({ taskProfile: NonEmpty, route: NonEmpty.optional() }),
  // Optional only for replay of already-prepared v1 artifacts. Every new compiler emits it.
  affectedRoutes: z.array(z.strictObject({ taskProfile: NonEmpty, route: NonEmpty.optional() })).min(1).optional(),
  affectedRouteDeclaration: z.strictObject({
    source: z.literal("operator-declared"),
    completeness: z.literal("not-independently-proven"),
  }).optional(),
  configRevision: Digest,
  snapshotDigest: Digest,
  splitManifestDigest: Digest,
  seed: z.strictObject({ kind: z.literal("tuple"), digest: Digest }),
  journey: z.enum(["explore-confirm", "confirm-only"]),
  allocationPreset: z.enum(["balanced-3-3-6@1", "test-this-change@1", "custom@1"]),
  pool: z.strictObject({
    snapshotDigest: Digest,
    eligibleGroups: z.number().int().nonnegative(),
    exclusions: z.array(z.strictObject({ id: NonEmpty, reason: NonEmpty })),
  }),
  evidenceAccess: z.strictObject({
    exploration: z.strictObject({ proposerGroups: z.array(Digest), selectionGroups: z.array(Digest) }),
    confirmationGroups: z.array(Digest),
    challengerSource: z.enum(["selected-from-exploration", "operator-supplied"]),
    freezeChallengerBeforeConfirmationReveal: z.literal(true),
    consumeConfirmationOnFirstRevealOrDispatch: z.literal(true),
  }),
  objectivePreset: z.enum(["more-tasks-succeed@1", "same-success-lower-cost@1"]),
  objective: z.strictObject({
    methods: z.array(Method).min(1),
    constraints: z.array(z.strictObject({
      method: Method,
      relation: z.enum(["must-not-decrease", "must-not-increase"]),
    })),
  }),
  arms: z.strictObject({ baseline: NonEmpty, candidate: NonEmpty }),
  candidatePayloadRisks: z.array(NonEmpty),
  executionCells: z.strictObject({
    replicates: z.number().int().positive(),
    selection: z.number().int().nonnegative(),
    confirmation: z.number().int().positive(),
    total: z.number().int().positive(),
  }),
  independence: z.literal("disclosed"),
  limitations: z.tuple([z.literal(SAME_OPERATOR_EVALUATION_LIMITATION)]),
});

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Exact local parser used before any live side effect. */
export function parseExactLiveCampaignInputs(bytes: Uint8Array): LiveCampaignInputs {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HostStateError("state-io", "campaign inputs are not UTF-8 JSON"); }
  const parsed = CampaignSchema.safeParse(value);
  if (!parsed.success || !sameBytes(bytes, canonicalJsonBytes(parsed.data as unknown as JsonValue))) {
    throw new HostStateError("state-io", "campaign inputs are not an exact supported canonical document");
  }
  if (parsed.data.executionCells.total
    !== parsed.data.executionCells.selection + parsed.data.executionCells.confirmation) {
    throw new HostStateError("state-io", "campaign input cell totals contradict their split");
  }
  return {
    ...parsed.data,
    affectedRoutes: normalizeAffectedRoutes(
      parsed.data.route,
      parsed.data.affectedRoutes ?? [parsed.data.route],
    ),
    affectedRouteDeclaration: parsed.data.affectedRouteDeclaration ?? {
      source: "operator-declared",
      completeness: "not-independently-proven",
    },
  } as LiveCampaignInputs;
}
