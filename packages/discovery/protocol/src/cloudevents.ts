import type { FactsProfileDocument } from "./facts-profile.js";
import { cloudEventsFields } from "./facts-profile.js";
import type { AnnouncedItem } from "./item.js";
import { formatOrigin } from "./grammar.js";

// CloudEvents envelope mapping for the announcement stream (design §9.1).
// Announcement streams are new announcement items from sources a relay
// follows, each event carrying the item plus its provenance: `subject` is
// the record digest; extension attributes carry the record kind, source
// identity, entry digest, announcement ID, and the facts-card fields the
// kind's facts profile declares CloudEvents-liftable (§12).
//
// Observation streams (TEP lifecycle observations, relayed as-is) are a
// SEPARATE stream family under the same wire format (§9.1) -- a relay
// forwards them unaltered and adds nothing; there is deliberately no
// mapping function for them here.

const ANNOUNCEMENT_EVENT_TYPE = "network.jinn.record-discovery.announcement" as const;

export interface AnnouncementEvent {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject: string; // record digest
  time?: string;
  // extension attributes (CE names, lowercase):
  recordkind: string;
  sourceagent: string;
  sourcename: string;
  entrydigest: string;
  announcementid: string;
  [factExtension: string]: unknown; // lifted facts fields
  data: AnnouncedItem;
}

/**
 * Maps an `AnnouncedItem` to its CloudEvents announcement-stream
 * representation (§9.1). Lifts exactly the fields the kind's facts profile
 * declares `cloudEvents`-liftable -- nothing else in the facts card is
 * copied into extension attributes, whether it is record- or substrate-
 * classed.
 */
export function toAnnouncementEvent(
  item: AnnouncedItem,
  profile: FactsProfileDocument | undefined,
): AnnouncementEvent {
  const extensions: Record<string, unknown> = {};
  if (profile !== undefined && typeof item.facts === "object" && item.facts !== null) {
    const facts = item.facts as Record<string, unknown>;
    for (const field of cloudEventsFields(profile)) {
      if (Object.prototype.hasOwnProperty.call(facts, field.name)) {
        extensions[field.cloudEvents!.attribute] = facts[field.name];
      }
    }
  }

  return {
    specversion: "1.0",
    id: item.provenance.announcementId,
    source: formatOrigin(item.provenance.source.agent, item.provenance.source.name),
    type: ANNOUNCEMENT_EVENT_TYPE,
    subject: item.record.digest,
    recordkind: item.record.kind,
    sourceagent: item.provenance.source.agent,
    sourcename: item.provenance.source.name,
    entrydigest: item.provenance.entry,
    announcementid: item.provenance.announcementId,
    ...extensions,
    data: item,
  };
}

/** The at-least-once dedupe key (§9.1): `(source identity, entry digest, announcementId)`. */
export function announcementDedupeKey(event: AnnouncementEvent): string {
  return `${event.sourceagent} ${event.sourcename} ${event.entrydigest} ${event.announcementid}`;
}
