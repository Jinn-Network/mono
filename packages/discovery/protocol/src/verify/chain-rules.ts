import { CEILINGS } from "../identifiers.js";
import { nextSequence } from "../grammar.js";
import { compareCodeUnitStrings } from "../order.js";
import { sealJson } from "../sealing.js";
import type { AnnouncementEntry } from "../entry.js";

// Chain rules (design §5.3): the structural graph rules a consumer applies
// over the entries a source (or its mirrors/peers) has surfaced, independent
// of the two named verification procedures' signature/freshness/HWM
// concerns. Two families:
//
//   - GLOBAL rules hold over the FULL set of observed entries, regardless of
//     which one the presented head cites -- a fork or a duplicate genesis is
//     equivocation evidence even when the head only cites one of the
//     colliding entries (e.g. a sibling surfaced by a peer mirror or an
//     archive page, §5.3 rule 2, §10.2 head exchange).
//   - LINKAGE is the walk from a specific starting digest (the head's cited
//     entry) back to a boundary (the consumer's high-water mark, or genesis
//     on first adoption, §5.3 rule 5), checking sequence contiguity and the
//     published-source profile's hard ceilings (§5.1) as it goes.

export interface DigestedEntry {
  digest: `sha256:${string}`;
  entry: AnnouncementEntry;
  sealedBytes: Uint8Array;
}

/** Seals every fed entry once, keyed by its own digest for chain-walk lookups. */
export function digestEntries(entries: readonly AnnouncementEntry[]): DigestedEntry[] {
  return entries.map((entry) => {
    const { bytes, digest } = sealJson(entry);
    return { digest, entry, sealedBytes: bytes };
  });
}

export type GlobalChainRuleFailure =
  | { kind: "duplicate-genesis" }
  | { kind: "forked"; a: AnnouncementEntry; b: AnnouncementEntry }
  | { kind: "duplicate-announcement-id"; announcementId: string }
  | { kind: "foreign-retraction"; announcementId: string }
  | { kind: "withdrawal-of-withdrawal"; announcementId: string };

/**
 * The global structural invariants (§5.1, §5.3 rule 2): at most one genesis
 * entry; no second signed child of any entry (fork, no benign reading);
 * source-wide `announcementId` uniqueness; withdrawal validity (`retracts`
 * targets an earlier `available` from this source, never a `withdrawn`).
 * Returns the first violation found, or `undefined` if the observed set is
 * internally consistent.
 */
export function checkGlobalChainRules(digested: readonly DigestedEntry[]): GlobalChainRuleFailure | undefined {
  const genesisDigests = new Set(
    digested.filter((d) => d.entry.previous === null).map((d) => d.digest),
  );
  if (genesisDigests.size > 1) return { kind: "duplicate-genesis" };

  const byPrevious = new Map<string, DigestedEntry[]>();
  for (const d of digested) {
    if (d.entry.previous === null) continue;
    const siblings = byPrevious.get(d.entry.previous) ?? [];
    siblings.push(d);
    byPrevious.set(d.entry.previous, siblings);
  }
  for (const siblings of byPrevious.values()) {
    const distinct = [...new Map(siblings.map((d): [string, DigestedEntry] => [d.digest, d])).values()];
    if (distinct.length > 1) {
      return { kind: "forked", a: distinct[0]!.entry, b: distinct[1]!.entry };
    }
  }

  // Source-wide announcementId uniqueness + withdrawal validity, scanned in
  // ascending sequence order (digest tie-break for determinism, matching
  // the tree's UTF-16 code-unit ordering rule).
  const ordered = [...digested].sort((left, right) => {
    if (left.entry.sequence !== right.entry.sequence) {
      return left.entry.sequence < right.entry.sequence ? -1 : 1;
    }
    return compareCodeUnitStrings(left.digest, right.digest);
  });
  const actionById = new Map<string, "available" | "withdrawn">();
  for (const { entry } of ordered) {
    for (const announcement of entry.announcements) {
      if (announcement.action === "available") {
        if (actionById.has(announcement.announcementId)) {
          return { kind: "duplicate-announcement-id", announcementId: announcement.announcementId };
        }
        actionById.set(announcement.announcementId, "available");
      } else {
        if (actionById.has(announcement.announcementId)) {
          return { kind: "duplicate-announcement-id", announcementId: announcement.announcementId };
        }
        const targetAction = actionById.get(announcement.retracts);
        if (targetAction === undefined) {
          return { kind: "foreign-retraction", announcementId: announcement.announcementId };
        }
        if (targetAction === "withdrawn") {
          return { kind: "withdrawal-of-withdrawal", announcementId: announcement.announcementId };
        }
        actionById.set(announcement.announcementId, "withdrawn");
      }
    }
  }
  return undefined;
}

export type LinkageFailure =
  | { kind: "linkage" }
  | { kind: "sequence-contiguity" }
  | { kind: "entry-ceiling" };

export type LinkageResult =
  | { ok: true; walked: DigestedEntry[] }
  | { ok: false; failure: LinkageFailure };

/**
 * Walks entries backward from `headEntryDigest` via `previous`, verifying
 * sequence contiguity (increment-by-one, §5.1) and the published-source
 * profile's hard entry ceilings (§5.1) as it goes, until reaching either
 * `stopAtDigest` (the consumer's high-water mark entry, for a returning
 * consumer) or genesis (`previous === null`, first adoption, §5.3 rule 5).
 * Returns the walked entries in walk order (head-to-boundary, inclusive).
 */
export function walkLinkage(params: {
  byDigest: Map<string, DigestedEntry>;
  headEntryDigest: string;
  stopAtDigest: string | undefined; // undefined => walk to genesis
}): LinkageResult {
  const { byDigest, headEntryDigest, stopAtDigest } = params;
  const walked: DigestedEntry[] = [];
  let cursor = headEntryDigest;
  for (;;) {
    const node = byDigest.get(cursor);
    if (node === undefined) return { ok: false, failure: { kind: "linkage" } };
    if (node.sealedBytes.length > CEILINGS.entrySealedBytes) {
      return { ok: false, failure: { kind: "entry-ceiling" } };
    }
    if (node.entry.announcements.length > CEILINGS.itemsPerEntry) {
      return { ok: false, failure: { kind: "entry-ceiling" } };
    }
    walked.push(node);

    if (stopAtDigest !== undefined && node.digest === stopAtDigest) {
      return { ok: true, walked };
    }
    if (node.entry.previous === null) {
      return stopAtDigest === undefined
        ? { ok: true, walked }
        : { ok: false, failure: { kind: "linkage" } }; // returning consumer's high-water mark never reached
    }

    const parent = byDigest.get(node.entry.previous);
    if (parent === undefined) return { ok: false, failure: { kind: "linkage" } };
    if (nextSequence(parent.entry.sequence) !== node.entry.sequence) {
      return { ok: false, failure: { kind: "sequence-contiguity" } };
    }
    cursor = node.entry.previous;
  }
}
