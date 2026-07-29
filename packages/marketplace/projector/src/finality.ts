// SPDX-License-Identifier: MIT

import {
  sealJson,
  nextSequence,
  type AnnouncementEntry,
} from "@jinn-network/record-discovery-protocol";
import type { SignedEntry } from "@jinn-network/record-discovery-serve";
import type { Hex } from "viem";
import {
  signAnnouncementEntry,
  type ProjectedAnnouncement,
  type ScopedDiscoverySigner,
} from "./announce.js";
import type { DerivationAnnotation, FinalityTier } from "./derivation.js";

export interface FinalityPolicyOptions {
  /** Default `safe`; `finalized` is the explicit stricter published profile. */
  readonly announceAt?: FinalityTier;
}

export interface FinalityDecision {
  readonly tier: FinalityTier;
  readonly announce: boolean;
  readonly gateExecution: boolean;
}

/** Safe is the default publication threshold; decision-grade compute remains finalized-gated. */
export function finalityPolicy(
  event: Pick<DerivationAnnotation, "finalityTier">,
  options: FinalityPolicyOptions = {},
): FinalityDecision {
  const announceAt = options.announceAt ?? "safe";
  const isFinalized = event.finalityTier === "finalized";
  return {
    tier: event.finalityTier,
    announce: announceAt === "safe" || isFinalized,
    gateExecution: isFinalized,
  };
}

type AvailableProjectedAnnouncement = Extract<
  ProjectedAnnouncement,
  { action: "available" }
>;

/**
 * Produces a new retraction for a now-orphaned availability. The prior value is never changed;
 * callers append the returned action in the next signed source entry.
 */
export function reorgCorrection(
  prior: AvailableProjectedAnnouncement,
  reorgedBlockHash: Hex,
): Extract<ProjectedAnnouncement, { action: "withdrawn" }> {
  if (prior.derivation.blockHash !== reorgedBlockHash) {
    throw new Error(
      `reorged block ${reorgedBlockHash} does not match prior derivation block ${prior.derivation.blockHash}`,
    );
  }
  return {
    announcementId:
      `${prior.announcementId}-reorged-${reorgedBlockHash.slice(2)}`,
    action: "withdrawn",
    retracts: prior.announcementId,
    reason: "reorged",
    derivation: prior.derivation,
  };
}

export interface AppendSignedReorgCorrectionInput {
  readonly priorEntry: AnnouncementEntry;
  readonly prior: AvailableProjectedAnnouncement;
  readonly reorgedBlockHash: Hex;
  readonly timestamp: string;
  readonly signer: ScopedDiscoverySigner;
}

/** Appends the correction at sequence+1 and signs the new entry under the discovery scope. */
export async function appendSignedReorgCorrection(
  input: AppendSignedReorgCorrectionInput,
): Promise<SignedEntry> {
  const correction = reorgCorrection(input.prior, input.reorgedBlockHash);
  const entry: AnnouncementEntry = {
    protocol: input.priorEntry.protocol,
    source: { ...input.priorEntry.source },
    sequence: nextSequence(input.priorEntry.sequence),
    previous: sealJson(input.priorEntry).digest,
    timestamp: input.timestamp,
    announcements: [correction],
  };
  return {
    entry,
    signature: await signAnnouncementEntry(entry, input.signer),
  };
}
