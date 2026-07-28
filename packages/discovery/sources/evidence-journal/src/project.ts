import type { EvidenceRecordFamily } from "@jinn-network/evidence-repository";
import type { PublishedEvidenceLocation, RecordLocationWithdrawal } from "@jinn-network/evidence-discovery";
import type { AvailableAnnouncement, PublishedLocation, WithdrawnAnnouncement } from "@jinn-network/record-discovery-protocol";
import { RECORD_KINDS, sealJson } from "@jinn-network/record-discovery-protocol";

import type { EvidenceJournalEntry } from "./ports.js";

// The pinned §11 field-map, as pure functions with no I/O and no persisted
// state -- `reconcile.ts` sequences and re-seals what these produce.

/** `reference.family` -> record-kind URI (§12, §11's crosswalk table row 1). */
export function familyToKind(family: EvidenceRecordFamily): string {
  switch (family) {
    case "execution-evidence":
      return RECORD_KINDS.executionEvidence;
    case "result-evaluation":
      return RECORD_KINDS.resultEvaluation;
    case "execution-verification":
      return RECORD_KINDS.executionVerification;
    default: {
      const exhaustive: never = family;
      throw new Error(`Unknown evidence record family: ${String(exhaustive)}`);
    }
  }
}

/**
 * `publishedLocation` -> a discovery `PublishedLocation` (§11: `publishedLocation`
 * -> `locations[]`). Evidence's `locator` is an arbitrary JSON object;
 * discovery's `PublishedLocation.locator` is a string (§5.1), so the object
 * is encoded through the same RFC 8785 JCS canonicalizer every sealed
 * document in this tree uses (`sealJson`) -- deterministic, and stable
 * across re-runs (the same locator object always encodes to the same
 * string).
 */
export function projectLocation(location: PublishedEvidenceLocation): PublishedLocation {
  return {
    profile: location.bindingProfile,
    locator: new TextDecoder().decode(sealJson(location.locator).bytes),
  };
}

/**
 * One evidence "available" announcement (from the journal) -> one discovery
 * `AvailableAnnouncement` (§11 crosswalk row 1). `announcementId` is reused
 * verbatim (already unique within the evidence source, which is what
 * discovery requires of it too); `repositoryId` stays local and is dropped
 * (§11: "which local repository instance ... never published"); the wrapper
 * emits no facts card in v1 (design §11, plan Out-of-scope).
 */
export function projectAvailableAnnouncement(entry: EvidenceJournalEntry): AvailableAnnouncement {
  const { announcement } = entry;
  const location = announcement.publishedLocation;
  return {
    announcementId: announcement.announcementId,
    action: "available",
    record: {
      kind: familyToKind(announcement.reference.family),
      digest: announcement.reference.digest,
    },
    ...(location === undefined ? {} : { locations: [projectLocation(location)] }),
  };
}

/**
 * One catalog withdrawal -> one discovery `WithdrawnAnnouncement` (§11
 * crosswalk row 2). `reason` is always `"delisted"`: the evidence layer has
 * no substrate fact to reorg away from (§11: "the layer has no substrate and
 * never emits `reorged`"). `sourceId` stays local, same as `repositoryId`
 * above -- the discovery entry already carries the wrapper's own source
 * identity at the entry level (§5.1).
 */
export function projectWithdrawnAnnouncement(withdrawal: RecordLocationWithdrawal): WithdrawnAnnouncement {
  return {
    announcementId: withdrawal.announcementId,
    action: "withdrawn",
    retracts: withdrawal.retractsAnnouncementId,
    reason: "delisted",
  };
}
