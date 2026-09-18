import { ANCHOR_EVIDENCE_KIND } from "@jinn-network/trust-core";
import type { Announcement } from "../entry.js";
import { RECORD_KINDS } from "../identifiers.js";
import { compareCodeUnitStrings } from "../order.js";
import type { AnchoredEntryOutcome } from "./outcomes.js";
import type { AnchoredEntryHoldStore } from "./ports.js";

/**
 * Named verification: `anchored-entry-hold` (publication-head anchoring
 * design §5.4 step 5). The procedure does not verify proofs — that is
 * steps 1–4, already ordinary consumer operations. It records a verified
 * tuple and refuses a later chain that no longer contains that digest at
 * that sequence.
 *
 * First hold for an origin wins. A visit with no hold and no `observed`
 * tuple is `ok` with `hold: undefined`: there is nothing to enforce yet.
 *
 * `entries` are the visit's verified walk (the fed suffix on a returning
 * sync). A held sequence absent from that bag is still present when
 * `coveredThrough` — the high-water mark this visit linked to — is at or
 * past the held sequence: that prefix is exactly what the mark exists to
 * avoid refetching. A fed or walked entry at the held sequence with a
 * different digest is always `missing-held-entry`.
 */
export async function verifyAnchoredEntryHold(opts: {
  origin: string;
  entries: readonly { sequence: string; digest: `sha256:${string}` }[];
  ports: { holds: AnchoredEntryHoldStore };
  /**
   * Sequence of the high-water mark this visit's linkage walk connected to.
   * Absent on first adoption (no prefix has been checkpointed yet).
   */
  coveredThrough?: { sequence: string };
  observed?: {
    sequence: string;
    entryDigest: `sha256:${string}`;
    anchorRecordDigest: `sha256:${string}`;
    anchoredTime: string;
  };
}): Promise<AnchoredEntryOutcome> {
  const existing = await opts.ports.holds.get(opts.origin);
  if (existing !== undefined) {
    if (!heldEntryIsPresent(opts.entries, existing, opts.coveredThrough)) {
      return { status: "missing-held-entry", hold: existing };
    }
    return { status: "ok", hold: existing };
  }
  if (opts.observed === undefined) return { status: "ok", hold: undefined };
  const hold = { origin: opts.origin, ...opts.observed };
  await opts.ports.holds.put(hold);
  return { status: "ok", hold };
}

function heldEntryIsPresent(
  entries: readonly { sequence: string; digest: `sha256:${string}` }[],
  hold: { sequence: string; entryDigest: `sha256:${string}` },
  coveredThrough: { sequence: string } | undefined,
): boolean {
  const atSequence = entries.find((entry) => entry.sequence === hold.sequence);
  if (atSequence !== undefined) return atSequence.digest === hold.entryDigest;
  return (
    coveredThrough !== undefined && compareCodeUnitStrings(coveredThrough.sequence, hold.sequence) >= 0
  );
}

export function isAnchorAnnouncement(announcement: Announcement): boolean {
  return announcement.action === "available" && announcement.record.kind === ANCHOR_EVIDENCE_KIND;
}

export function isAnchorAnnouncingEntry(entry: { announcements: readonly Announcement[] }): boolean {
  return entry.announcements.length > 0 && entry.announcements.every(isAnchorAnnouncement);
}

export type EntryAnchorCoverage = {
  readonly anchored: readonly string[];
  readonly gaps: readonly string[];
  readonly pending: string | undefined;
  readonly unreadable: readonly string[];
};

/**
 * Pure coverage census for the runbook walk (design §4.3 / §5.2). `anchors`
 * are subjects already bound to fetched record bytes (unreadable announcing
 * entries are named separately rather than counted as ordinary gaps).
 */
export function enumerateEntryAnchorCoverage(input: {
  readonly entries: readonly {
    readonly sequence: string;
    readonly digest: `sha256:${string}`;
    readonly announcements: readonly Announcement[];
  }[];
  readonly anchors: readonly { readonly subjectKind: string; readonly subjectDigest: string }[];
  readonly unreadable: readonly string[];
}): EntryAnchorCoverage {
  const unreadable = new Set(input.unreadable);
  const ordered = [...input.entries].sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));
  const substantive = ordered.filter((entry) => !isAnchorAnnouncingEntry(entry) || unreadable.has(entry.sequence));
  const anchoredDigests = new Set(
    input.anchors
      .filter((anchor) => anchor.subjectKind === RECORD_KINDS.announcementEntry)
      .map((anchor) => stripSha256Prefix(anchor.subjectDigest)),
  );
  const anchored: string[] = [];
  const gaps: string[] = [];
  for (const entry of substantive) {
    if (unreadable.has(entry.sequence)) continue;
    if (anchoredDigests.has(stripSha256Prefix(entry.digest))) anchored.push(entry.sequence);
    else gaps.push(entry.sequence);
  }
  const tip = ordered.at(-1);
  let pending: string | undefined;
  if (tip !== undefined && !isAnchorAnnouncingEntry(tip) && gaps.at(-1) === tip.sequence) {
    pending = tip.sequence;
    gaps.pop();
  }
  return { anchored, gaps, pending, unreadable: [...unreadable].sort() };
}

function stripSha256Prefix(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}
