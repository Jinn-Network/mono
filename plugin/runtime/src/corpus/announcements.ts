// SPDX-License-Identifier: Apache-2.0

import type { EvidenceRecordAnnouncement, JsonValue } from "@jinn-network/evidence-discovery";
import type { EvidenceRecordFamily, Sha256Digest } from "@jinn-network/evidence-repository";
import {
  LOCATION_PROFILE_HTTPS,
  LOCATION_PROFILE_IPFS,
  RECORD_KINDS,
  type AnnouncementEntry,
  type PublishedLocation,
} from "@jinn-network/record-discovery-protocol";

import type { MirrorSourceConfig } from "../config.js";
import type { CorpusAdmission } from "./admission.js";

export const FAMILY_BY_RECORD_KIND: ReadonlyMap<string, EvidenceRecordFamily> = new Map([
  [RECORD_KINDS.executionEvidence, "execution-evidence"],
  [RECORD_KINDS.resultEvaluation, "result-evaluation"],
  [RECORD_KINDS.executionVerification, "execution-verification"],
]);

export type ExclusionReason = "admission-rejected" | "unsupported-kind";

export interface ExcludedAnnouncement {
  readonly announcementId: string;
  readonly reason: ExclusionReason;
  readonly detail: string;
}

export interface AnnouncementAdaptation {
  readonly announcements: readonly EvidenceRecordAnnouncement[];
  readonly excluded: readonly ExcludedAnnouncement[];
}

export function sourceIdOf(source: Pick<MirrorSourceConfig, "agent" | "name">): string {
  return `${source.agent}/${source.name}`;
}

/**
 * Record discovery carries a location as `{ profile, locator: string }`;
 * the evidence catalog carries one as `{ bindingProfile, locator: object }`.
 * The two models are not unified upstream (C5 Finding F2); this function is
 * the single bridging point, and an unrecognized profile yields no location
 * rather than an invented one.
 */
function toPublishedLocation(
  locations: readonly PublishedLocation[] | undefined,
): { readonly bindingProfile: string; readonly locator: Readonly<Record<string, JsonValue>> } | undefined {
  for (const location of locations ?? []) {
    if (location.profile === LOCATION_PROFILE_HTTPS) {
      return { bindingProfile: location.profile, locator: { uri: location.locator } };
    }
    if (location.profile === LOCATION_PROFILE_IPFS) {
      return { bindingProfile: location.profile, locator: { cid: location.locator } };
    }
  }
  return undefined;
}

/**
 * Adapts one announcement entry into the evidence indexer's announcement
 * shape, applying SOURCE (announcer) admission first.
 *
 * Admission runs here, at the acquisition boundary, so a rejected archive's
 * content never enters the catalog at all. PRODUCER admission runs later, in
 * `read.ts`, because the producing agent's identity lives inside the record
 * and is only known after projection — and because running it at read time
 * means a policy change takes effect immediately over already-mirrored
 * content instead of requiring a re-sync.
 */
export function adaptAnnouncementEntry(
  entry: AnnouncementEntry,
  source: MirrorSourceConfig,
  admission: CorpusAdmission,
): AnnouncementAdaptation {
  const excludeAll = (detail: string): AnnouncementAdaptation => ({
    announcements: [],
    excluded: entry.announcements.map((announcement) => ({
      announcementId: announcement.announcementId,
      reason: "admission-rejected" as const,
      detail,
    })),
  });

  if (entry.source.agent !== source.agent || entry.source.name !== source.name) {
    return excludeAll("source-mismatch");
  }

  const decision = admission.admitSource({ agent: entry.source.agent, name: entry.source.name });
  if (decision.status === "rejected") return excludeAll(decision.reason);

  const sourceId = sourceIdOf(source);
  const announcements: EvidenceRecordAnnouncement[] = [];
  const excluded: ExcludedAnnouncement[] = [];

  for (const announcement of entry.announcements) {
    if (announcement.action === "withdrawn") {
      announcements.push({
        kind: "withdrawn",
        sourceId,
        announcementId: announcement.announcementId,
        retractsAnnouncementId: announcement.retracts,
      });
      continue;
    }

    const family = FAMILY_BY_RECORD_KIND.get(announcement.record.kind);
    if (family === undefined) {
      excluded.push({
        announcementId: announcement.announcementId,
        reason: "unsupported-kind",
        detail: announcement.record.kind,
      });
      continue;
    }

    const publishedLocation = toPublishedLocation(announcement.locations);
    announcements.push({
      kind: "available",
      sourceId,
      announcementId: announcement.announcementId,
      repositoryId: source.repositoryId,
      reference: { family, digest: announcement.record.digest as Sha256Digest },
      ...(publishedLocation === undefined ? {} : { publishedLocation }),
    });
  }

  return { announcements, excluded };
}
