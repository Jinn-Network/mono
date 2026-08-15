import type { AnnouncementEntry } from "@jinn-network/record-discovery-protocol";
import {
  CEILINGS,
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  compareCodeUnitStrings,
  formatSequence,
  sealJson,
} from "@jinn-network/record-discovery-protocol";

import type { BlobStore } from "./ports.js";
import type { DsseEnvelope } from "./head.js";

// Archive pages (design §7 item 2): RFC-5005-shaped immutable pages of
// announcement entries in sequence order, each linking to its predecessor
// page (the `prev-archive` relation, RFC 8288 -- represented here as the
// `prevArchive` field on the page's own sealed I-JSON body, since this
// protocol serves JSON pages rather than an Atom/RSS document). Cold sync
// walks from the newest page back toward genesis (design §5.3 rule 3).
//
// Each page entry pairs the bare entry with its own append-time DSSE
// signature (§5.1: "entries carry their own append-time signatures for
// per-item accountability"; §10.3 step 5 verifies them as corroboration).
// This is the same `{entry, signature}` pairing `verifySourceChain` reads
// (protocol's `verify/source-chain.ts`) and the §18 vectors' own
// `entries: [{entry, signature}, ...]` shape -- `signature` is present
// under the published-source profile and omitted under the unpublished
// profile (§5.5).

export interface SignedEntry {
  entry: AnnouncementEntry;
  signature?: DsseEnvelope;
}

/** A page's own sealed shape: signed entries in sequence order, plus the link to its predecessor page. */
export interface ArchivePage {
  protocol: string;
  source: string;
  page: string;
  prevArchive: string | null;
  entries: SignedEntry[];
}

const ARCHIVE_PAGE_CONTENT_TYPE = "application/json";

/**
 * Partitions `entries` (sorted by `sequence`, §5.1's fixed-width strings
 * compared via `compareCodeUnitStrings`) into archive pages, each page's
 * sealed body at most `maxPageBytes` (default `CEILINGS.archivePageBytes`,
 * §5.1's advisory ceiling -- HARD under the published-source profile).
 * Writes every page and returns the ordered page identifiers (oldest
 * first); each page's own `prevArchive` field links it to its predecessor,
 * so a consumer can walk from the newest page backward without needing
 * this ordered list.
 */
export async function writeArchivePages(
  store: BlobStore,
  sourceName: string,
  entries: readonly SignedEntry[],
  maxPageBytes: number = CEILINGS.archivePageBytes,
): Promise<{ pages: string[] }> {
  const ordered = [...entries].sort((a, b) => compareCodeUnitStrings(a.entry.sequence, b.entry.sequence));

  const batches: SignedEntry[][] = [];
  let current: SignedEntry[] = [];
  let currentBytes = 0;
  for (const signed of ordered) {
    const entryBytes = sealJson(signed).bytes.length;
    if (current.length > 0 && currentBytes + entryBytes > maxPageBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(signed);
    currentBytes += entryBytes;
  }
  if (current.length > 0) batches.push(current);

  const pages: string[] = [];
  let prevArchive: string | null = null;
  for (let index = 0; index < batches.length; index += 1) {
    const page = formatSequence(BigInt(index + 1));
    const body: ArchivePage = {
      protocol: RECORD_DISCOVERY_VERSION,
      source: sourceName,
      page,
      prevArchive,
      entries: batches[index]!,
    };
    const { bytes } = sealJson(body);
    await store.put(archivePagePath(sourceName, page), bytes, ARCHIVE_PAGE_CONTENT_TYPE);
    pages.push(page);
    prevArchive = page;
  }
  return { pages };
}
