import type { DsseEnvelope } from "@jinn-network/trust-core";
import type {
  AnnouncementEntry,
  ParsedWireDsseEnvelope,
  SourceCursor,
  SourceHead,
  WireDsseEnvelope,
} from "@jinn-network/record-discovery-protocol";
import {
  archivePagePath,
  compareCodeUnitStrings,
  headPath,
  parseAnnouncementEntry,
  parseSourceHead,
  parseWireDsseEnvelope,
} from "@jinn-network/record-discovery-protocol";

import type { Transport } from "./ports.js";

// Chain-walk sync (design §5.3): cold sync walks archive pages backward
// from the current page toward genesis (§5.3 rule 3, §7 item 2 -- O(pages),
// not O(entries)); a returning consumer walks only back to its high-water
// mark (§5.3 rule 5). Linkage depth here is data acquisition only --
// `verify-driver.ts` (Task 20) is what actually VERIFIES the walked chain
// against the high-water mark or genesis; this module just fetches and
// parses the wire bytes into the shapes `verifySourceChain` consumes.
//
// The archive-page and head-envelope wire shapes mirror
// `record-discovery-serve`'s own writer (layout.ts/archive.ts/head.ts) by
// convention -- discovery's design leaves these serving-plane object
// bodies "implementation," pinning only their existence and properties
// (§7), not a JSON Schema `protocol` freezes. `client` cannot depend on
// `serve` (guard-enforced boundary), so this module independently parses
// the same shapes serve independently writes; kept honest by both sides
// deriving from the same design section and by this package's own tests.

/** Describes where to reach one source's serving-plane objects (design §7). */
export interface SourceEndpoint {
  agent: string;
  name: string;
  /** Base URL; `headPath`/`archivePagePath` resolve against this. */
  servingRoot: string;
  /** The current (newest) archive page's URL (the well-known document's `archiveRoot`, §7 item 3). */
  archiveRootUrl: string;
}

export interface SyncedEntry {
  entry: AnnouncementEntry;
  signature?: DsseEnvelope;
}

export interface SyncedHead {
  head: SourceHead;
  signature?: DsseEnvelope;
}

/**
 * Public client entry for the protocol's one strict wire decoder. The verification driver accepts
 * the returned `envelope`; callers may retain `payloadBytes`/`signatureBytes` for byte evidence.
 */
export function decodeWireEnvelopeForVerification(value: unknown): ParsedWireDsseEnvelope {
  return parseWireDsseEnvelope(value);
}

function isWireEnvelopeCandidate(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.hasOwn(value, "payloadType") || Object.hasOwn(value, "payload") || Object.hasOwn(value, "signatures"))
  );
}

async function fetchJson(url: string, transport: Transport): Promise<unknown> {
  const response = await transport.fetch(url);
  return JSON.parse(new TextDecoder().decode(response.bytes));
}

/** Fetches and parses a source's head, whether published (DSSE-enveloped) or unpublished (bare), §5.5. */
export async function fetchHead(source: SourceEndpoint, transport: Transport): Promise<SyncedHead> {
  const parsed = await fetchJson(source.servingRoot + headPath(source.name), transport);
  if (isWireEnvelopeCandidate(parsed)) {
    const decoded = parseWireDsseEnvelope(parsed);
    const head = parseSourceHead(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded.payloadBytes)));
    return { head, signature: decoded.envelope as DsseEnvelope };
  }
  return { head: parseSourceHead(parsed) };
}

interface WireSignedEntry {
  entry: unknown;
  signature?: WireDsseEnvelope;
}

interface WireArchivePage {
  protocol: string;
  source: string;
  page: string;
  prevArchive: string | null;
  entries: WireSignedEntry[];
}

async function fetchPage(url: string, transport: Transport): Promise<WireArchivePage> {
  return (await fetchJson(url, transport)) as WireArchivePage;
}

function toSyncedEntries(page: WireArchivePage): SyncedEntry[] {
  return page.entries.map((signed) => {
    const signature = signed.signature === undefined ? undefined : parseWireDsseEnvelope(signed.signature).envelope;
    return {
      entry: parseAnnouncementEntry(signed.entry),
      ...(signature === undefined ? {} : { signature: signature as DsseEnvelope }),
    };
  });
}

function pageUrl(source: SourceEndpoint, page: string): string {
  return source.servingRoot + archivePagePath(source.name, page);
}

/**
 * Walks every archive page backward from the current page to genesis
 * (§5.3 rule 3), yielding entries oldest-first -- the depth a first-time
 * adopter of a source MUST cover before any decision-grade use (§5.3
 * rule 5).
 */
export async function* coldSync(
  source: SourceEndpoint,
  ports: { transport: Transport },
): AsyncIterable<SyncedEntry> {
  const pagesNewestFirst: WireArchivePage[] = [];
  let url: string | undefined = source.archiveRootUrl;
  while (url !== undefined) {
    const page: WireArchivePage = await fetchPage(url, ports.transport);
    pagesNewestFirst.push(page);
    url = page.prevArchive === null ? undefined : pageUrl(source, page.prevArchive);
  }
  for (let index = pagesNewestFirst.length - 1; index >= 0; index -= 1) {
    for (const signed of toSyncedEntries(pagesNewestFirst[index]!)) yield signed;
  }
}

/**
 * Walks archive pages backward from the current page only until every
 * entry newer than `hwm` has been collected (§5.3 rule 5: a returning
 * consumer verifies linkage back to its high-water mark, never further),
 * yielding entries oldest-first.
 */
export async function* returningSync(
  source: SourceEndpoint,
  hwm: SourceCursor,
  ports: { transport: Transport },
): AsyncIterable<SyncedEntry> {
  const collected: SyncedEntry[] = [];
  let url: string | undefined = source.archiveRootUrl;
  while (url !== undefined) {
    const page: WireArchivePage = await fetchPage(url, ports.transport);
    const synced = toSyncedEntries(page);
    const reachedHwm = synced.some((signed) => compareCodeUnitStrings(signed.entry.sequence, hwm.sequence) <= 0);
    collected.push(...synced.filter((signed) => compareCodeUnitStrings(signed.entry.sequence, hwm.sequence) > 0));
    if (reachedHwm) break;
    url = page.prevArchive === null ? undefined : pageUrl(source, page.prevArchive);
  }
  collected.sort((a, b) => compareCodeUnitStrings(a.entry.sequence, b.entry.sequence));
  for (const signed of collected) yield signed;
}

export interface ResolvedMirrorHead {
  endpoint: SourceEndpoint;
  synced: SyncedHead;
}

/**
 * Retrieves the head from every mirror and returns the highest valid
 * `(sequence, issuedAt)` (design §5.2/§13.3: a consumer with no
 * high-water mark for a source MUST retrieve the head from every
 * reachable mirror and proceed from the highest). Mirrors that fail to
 * respond are skipped, not fatal. Returns `undefined` only if every
 * mirror failed.
 */
export async function resolveHeadAcrossMirrors(
  mirrors: readonly SourceEndpoint[],
  ports: { transport: Transport },
): Promise<ResolvedMirrorHead | undefined> {
  let best: ResolvedMirrorHead | undefined;
  for (const endpoint of mirrors) {
    let synced: SyncedHead;
    try {
      synced = await fetchHead(endpoint, ports.transport);
    } catch {
      continue;
    }
    if (
      best === undefined ||
      compareCodeUnitStrings(synced.head.sequence, best.synced.head.sequence) > 0 ||
      (synced.head.sequence === best.synced.head.sequence &&
        new Date(synced.head.issuedAt).getTime() > new Date(best.synced.head.issuedAt).getTime())
    ) {
      best = { endpoint, synced };
    }
  }
  return best;
}
