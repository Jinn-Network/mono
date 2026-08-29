// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest, ValidationDiagnostic } from "@jinn-network/trust-core";

import type { OfferRecord } from "./schema.js";

/** One verified offer, as a caller holds it: its identity, its terms, and whose it is. */
export interface OfferEntry {
  readonly digest: Sha256Digest;
  readonly offer: OfferRecord;
  /** The Agent IRI `verifyOffer` resolved the signature to. */
  readonly holder: string;
}

export interface SupersessionReport {
  /** Input order preserved. */
  readonly live: readonly OfferEntry[];
  readonly superseded: readonly OfferEntry[];
  readonly diagnostics: readonly ValidationDiagnostic[];
}

/**
 * Resolves which offers in a set still apply. Repricing is supersession, never mutation, so
 * "the current price" is only ever a property of a set of offers — which is why this is a
 * fold over a set rather than a field on a record.
 *
 * A supersession is honored only when it names an offer in the set that has the same
 * subject and the same holder. Both refusals are the same rule: an offer prices one
 * subject, and only the holder can offer, so neither cross-subject nor cross-holder
 * supersession can be a thing a holder is entitled to assert. A refused supersession is a
 * defect of the offering feed, reported here; it never silently retires someone's offer.
 *
 * `supersedes` naming an offer outside the set is not a defect — the predecessor is simply
 * not in hand — so the successor stays live and the fact is reported as information.
 *
 * Two offers superseding one predecessor is a fork: both stay live and the predecessor is
 * retired. The holder's own append-only announcement chain, not this function, orders them.
 */
export function resolveLiveOffers(entries: readonly OfferEntry[]): SupersessionReport {
  const diagnostics: ValidationDiagnostic[] = [];
  const byDigest = new Map<Sha256Digest, OfferEntry>();
  const unique: OfferEntry[] = [];

  entries.forEach((entry, index) => {
    if (byDigest.has(entry.digest)) {
      diagnostics.push({
        code: "DUPLICATE_OFFER",
        path: String(index),
        message: `offer ${entry.digest} appears more than once; the later copy is ignored`,
      });
      return;
    }
    byDigest.set(entry.digest, entry);
    unique.push(entry);
  });

  const supersededDigests = new Set<Sha256Digest>();
  const supersedersByPredecessor = new Map<Sha256Digest, number>();
  /** successor digest -> the predecessor its honored supersession retires. */
  const honoredEdges = new Map<Sha256Digest, Sha256Digest>();

  unique.forEach((entry, index) => {
    // The schema pins `supersedes` to the `sha256:<64 lowercase hex>` grammar, which is
    // exactly `Sha256Digest`; zod infers the regex-refined string as plain `string`.
    const predecessorDigest = entry.offer.supersedes as Sha256Digest | undefined;
    if (predecessorDigest === undefined) return;
    if (predecessorDigest === entry.digest) {
      // Unreachable against honestly sealed bytes — a digest cannot be known before the
      // bytes that contain it exist — so this is only ever hand-written input.
      diagnostics.push({
        code: "SELF_SUPERSESSION",
        path: `${index}.supersedes`,
        message: `offer ${entry.digest} supersedes itself`,
      });
      return;
    }
    const predecessor = byDigest.get(predecessorDigest);
    if (predecessor === undefined) {
      diagnostics.push({
        code: "UNKNOWN_PREDECESSOR",
        path: `${index}.supersedes`,
        message:
          `offer ${entry.digest} supersedes ${predecessorDigest}, which is not in this set; `
          + "the successor is live and the predecessor's state is unknown here",
      });
      return;
    }
    if (predecessor.offer.subject !== entry.offer.subject) {
      diagnostics.push({
        code: "SUBJECT_MISMATCH",
        path: `${index}.supersedes`,
        message:
          `offer ${entry.digest} prices ${entry.offer.subject} but supersedes an offer for `
          + `${predecessor.offer.subject}; one offer prices one subject, so the supersession is refused`,
      });
      return;
    }
    if (predecessor.holder !== entry.holder) {
      diagnostics.push({
        code: "FOREIGN_SUPERSESSION",
        path: `${index}.supersedes`,
        message:
          `offer ${entry.digest} by ${entry.holder} cannot supersede an offer by `
          + `${predecessor.holder}; only the holder can retire their own offer`,
      });
      return;
    }
    const forkCount = (supersedersByPredecessor.get(predecessorDigest) ?? 0) + 1;
    supersedersByPredecessor.set(predecessorDigest, forkCount);
    if (forkCount > 1) {
      diagnostics.push({
        code: "SUPERSESSION_FORK",
        path: `${index}.supersedes`,
        message:
          `offer ${predecessorDigest} is superseded by more than one offer; all successors are `
          + "live and the holder's announcement chain orders them",
      });
    }
    supersededDigests.add(predecessorDigest);
    honoredEdges.set(entry.digest, predecessorDigest);
  });

  // A cycle cannot occur in honestly sealed bytes — an offer's digest is not knowable before
  // the bytes naming it exist — so, like self-supersession above, this only ever arrives as
  // hand-written input. It gets the same treatment for the same reason: retiring every member
  // of a cycle would silently empty a holder's live set for a subject, and a set that vanishes
  // with no diagnostic is the worst possible answer. The edges are dropped and every member
  // stays live.
  for (const digest of honoredEdges.keys()) {
    const path: Sha256Digest[] = [];
    for (let cursor: Sha256Digest | undefined = digest; cursor !== undefined;) {
      if (path.includes(cursor)) {
        const cycle = path.slice(path.indexOf(cursor));
        for (const member of cycle) {
          const predecessor = honoredEdges.get(member);
          honoredEdges.delete(member);
          if (predecessor !== undefined) supersededDigests.delete(predecessor);
        }
        diagnostics.push({
          code: "SUPERSESSION_CYCLE",
          path: "",
          message:
            `offers ${cycle.join(", ")} supersede one another in a cycle; the supersessions are `
            + "refused and every member stays live",
        });
        break;
      }
      path.push(cursor);
      cursor = honoredEdges.get(cursor);
    }
  }

  return {
    live: unique.filter((entry) => !supersededDigests.has(entry.digest)),
    superseded: unique.filter((entry) => supersededDigests.has(entry.digest)),
    diagnostics,
  };
}
