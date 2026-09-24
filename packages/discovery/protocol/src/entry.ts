import { z } from "zod";
import { GENESIS_SEQUENCE, RECORD_DISCOVERY_VERSION } from "./identifiers.js";
import { isSourceName } from "./grammar.js";
import type { PublishedLocation, RecordRef } from "./item.js";

// Announcement Entry (§5.1) -- the append-only sealed unit. Field set and
// semantics frozen at design §16 item 2: source tuple with pinned name
// grammar, gap-free increment-by-one sequence with pinned genesis,
// `previous` linkage, `announcements[]` items with available/withdrawn,
// mandatory withdrawal reason codes, same-source retraction of `available`
// only (chain-level; enforced in M4), source-wide `announcementId`
// uniqueness (chain-wide part enforced in M4 -- this module enforces
// per-entry uniqueness only, since a lone entry cannot see its siblings).

export interface AvailableAnnouncement {
  announcementId: string;
  action: "available";
  record: RecordRef;
  locations?: PublishedLocation[];
  facts?: unknown;
}

export interface WithdrawnAnnouncement {
  announcementId: string;
  action: "withdrawn";
  retracts: string;
  reason: "delisted" | "superseded" | "reorged" | "error";
}

export type Announcement = AvailableAnnouncement | WithdrawnAnnouncement;

export interface AnnouncementEntry {
  protocol: string;
  source: { agent: string; name: string };
  sequence: string;
  previous: `sha256:${string}` | null;
  timestamp: string;
  announcements: Announcement[];
}

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const SequenceSchema = z.string().regex(/^[0-9]{16}$/);

const RecordRefSchema = z.looseObject({
  kind: z.string().min(1),
  digest: Sha256DigestSchema,
  mediaType: z.string().optional(),
});

const PublishedLocationSchema = z.looseObject({
  profile: z.string().min(1),
  locator: z.string().min(1),
});

const AvailableAnnouncementSchema = z.looseObject({
  announcementId: z.string().min(1),
  action: z.literal("available"),
  record: RecordRefSchema,
  locations: z.array(PublishedLocationSchema).optional(),
  facts: z.unknown().optional(),
});

const WITHDRAWAL_REASONS = ["delisted", "superseded", "reorged", "error"] as const;

const WithdrawnAnnouncementSchema = z.looseObject({
  announcementId: z.string().min(1),
  action: z.literal("withdrawn"),
  retracts: z.string().min(1),
  reason: z.enum(WITHDRAWAL_REASONS),
});

const AnnouncementSchema = z.discriminatedUnion("action", [
  AvailableAnnouncementSchema,
  WithdrawnAnnouncementSchema,
]);

const AnnouncementEntrySchema = z.looseObject({
  protocol: z.literal(RECORD_DISCOVERY_VERSION),
  source: z.looseObject({ agent: z.string().min(1), name: z.string().min(1) }),
  sequence: SequenceSchema,
  previous: z.union([Sha256DigestSchema, z.null()]),
  // Deliberately laxer than `HeadTimestampSchema`, and the asymmetry is a
  // decision, not an oversight (#4095).
  //
  // `assertIntentOwnership` pins `head.issuedAt === entry.timestamp`, and
  // `issuedAt` is calendar-strict RFC 3339 with a mandatory offset (#3482) --
  // so on the WRITE path this field is already strict, transitively, and the
  // durable writer is its single authority. `parseAnnouncementEntry`, by
  // contrast, parses bytes received from a PEER during an archive walk.
  // `timestamp` is not a §5.2 window field: nothing here reads it as an
  // instant, and tightening the schema would retroactively refuse
  // already-signed, digest-chained historical entries. That is a protocol
  // compatibility change, decided in a protocol change -- not here.
  timestamp: z.string().min(1),
  announcements: z.array(AnnouncementSchema).min(1),
});

/**
 * Parses and validates an Announcement Entry per §5.1/§16 item 2: rejects
 * duplicate `announcementId`s within the entry, enforces the genesis <->
 * `previous === null` coupling, and requires a non-empty `announcements[]`.
 */
export function parseAnnouncementEntry(json: unknown): AnnouncementEntry {
  const parsed = AnnouncementEntrySchema.parse(json);

  if (!isSourceName(parsed.source.name)) {
    throw new Error(`Entry source name is not source-name-shaped (§5.1 SOURCE_NAME_GRAMMAR): ${parsed.source.name}`);
  }

  const seen = new Set<string>();
  for (const announcement of parsed.announcements) {
    if (seen.has(announcement.announcementId)) {
      throw new Error(
        `Duplicate announcementId within one entry: ${announcement.announcementId}`,
      );
    }
    seen.add(announcement.announcementId);
  }

  const isGenesis = parsed.sequence === GENESIS_SEQUENCE;
  if (isGenesis && parsed.previous !== null) {
    throw new Error("The genesis entry (sequence === GENESIS_SEQUENCE) must have previous === null.");
  }
  if (!isGenesis && parsed.previous === null) {
    throw new Error("Only the genesis entry may have previous === null.");
  }

  return parsed as AnnouncementEntry;
}
