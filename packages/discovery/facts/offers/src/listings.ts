// SPDX-License-Identifier: MIT

import type { AnnouncedItem } from "@jinn-network/record-discovery-protocol";

import { OFFER_RECORD_KIND } from "./identifiers.js";

/**
 * One rail entry as an announcement card carries it: the rail identifier and the exact
 * integer amount in that rail's native units, as a string.
 */
export interface OfferCardRail {
  readonly rail: string;
  readonly amount: string;
}

/**
 * An offer card read back out of an `AnnouncedItem`. This is a *hint*, not a term: an index
 * renders a priced catalog from cards, and anything a buyer commits to is checked against
 * the fetched, digest-checked, signature-verified offer.
 */
export interface OfferCard {
  readonly offerRecordDigest: string;
  readonly subject: string;
  readonly priced: boolean;
  readonly rails: readonly OfferCardRail[];
  readonly item: AnnouncedItem;
}

function stringField(card: Record<string, unknown>, name: string): string | undefined {
  const value = card[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayField(card: Record<string, unknown>, name: string): string[] | undefined {
  const value = card[name];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

/** An amount as the offer schema pins it: an exact positive integer, no sign, no leading zero. */
const CARD_AMOUNT = /^[1-9][0-9]*$/;

/**
 * Reads the offer card off an announced item, or `undefined` when the item is not an offer
 * or its card is not one this profile can read.
 *
 * Every structural defect is a miss rather than a throw. A card is an unverified statement
 * by whoever announced it, so an index sorting a catalog must be able to walk a feed
 * containing a malformed one; the defect surfaces where it belongs, in the chain-and-facts
 * verifier, which recomputes the card against the record and reports the announcing feed's
 * inconsistency. Sorting is not the place to adjudicate that.
 *
 * The two rail arrays must be the same length, because their alignment is what makes them
 * one list; a mismatched pair says nothing readable and is a miss.
 */
export function readOfferCard(item: AnnouncedItem): OfferCard | undefined {
  if (item.record.kind !== OFFER_RECORD_KIND) return undefined;
  if (typeof item.facts !== "object" || item.facts === null || Array.isArray(item.facts)) {
    return undefined;
  }
  const card = item.facts as Record<string, unknown>;
  const offerRecordDigest = stringField(card, "offerRecordDigest");
  const subject = stringField(card, "subject");
  const priced = card["priced"];
  if (offerRecordDigest === undefined || subject === undefined || typeof priced !== "boolean") {
    return undefined;
  }
  const railIds = stringArrayField(card, "rails.rail");
  const amounts = stringArrayField(card, "rails.amount");
  if (railIds === undefined || amounts === undefined) return undefined;
  if (railIds.length !== amounts.length) return undefined;
  if (priced !== (railIds.length > 0)) return undefined;
  if (!amounts.every((amount) => CARD_AMOUNT.test(amount))) return undefined;
  return {
    offerRecordDigest,
    subject,
    priced,
    rails: railIds.map((rail, index) => ({ rail, amount: amounts[index]! })),
    item,
  };
}

/** Every readable offer card in `items`, in announcement order. */
export function offerCards(items: readonly AnnouncedItem[]): OfferCard[] {
  return items.flatMap((item) => {
    const card = readOfferCard(item);
    return card === undefined ? [] : [card];
  });
}

/**
 * The cards pricing one subject — the `referrers` inversion of the profile's
 * reference-bearing `subject` field, done locally over a set of items already in hand.
 */
export function offerCardsForSubject(
  cards: readonly OfferCard[],
  subject: string,
): OfferCard[] {
  return cards.filter((card) => card.subject === subject);
}

/**
 * The cards whose offers the holder's own announcement chain has not withdrawn.
 *
 * Liveness is not a card field and must not become one: an offer stops applying when its
 * holder delists or supersedes it, and both are `withdrawn` announcements with the existing
 * `"delisted"` / `"superseded"` reason codes. The index derives that set from the feeds it
 * follows and passes it here; the card never claims to be live about itself.
 */
export function liveOfferCards(
  cards: readonly OfferCard[],
  withdrawnOfferDigests: ReadonlySet<string>,
): OfferCard[] {
  return cards.filter((card) => !withdrawnOfferDigests.has(card.offerRecordDigest));
}

function amountOnRail(card: OfferCard, rail: string): bigint | undefined {
  const entry = card.rails.find((candidate) => candidate.rail === rail);
  return entry === undefined ? undefined : BigInt(entry.amount);
}

/**
 * Orders cards cheapest first for one named rail.
 *
 * One rail, always. An offer carries no reference currency and no conversion — equivalence
 * across a multi-rail offer is the holder's own assertion — so there is no total order over
 * prices quoted on different rails, and inventing one here would be this package asserting
 * an exchange rate. A caller who wants a catalog ranked "cheapest" picks the rail it settles
 * in.
 *
 * A free offer costs nothing on every rail and therefore sorts ahead of every priced one. A
 * priced offer that does not quote this rail is not orderable against it and is dropped —
 * it is unpriced *in this rail's terms*, which is not the same as free.
 *
 * Amounts are compared as big integers, never as numbers: native units routinely exceed
 * `Number.MAX_SAFE_INTEGER` (wei), where two distinct prices would compare equal. Ties break
 * on the offer digest by code-unit order, so one input set has one output order on every
 * host — the discovery tree's canonical-bytes discipline, which is also why no comparison
 * here consults the host locale.
 */
export function cheapestFirstOnRail(
  cards: readonly OfferCard[],
  rail: string,
): OfferCard[] {
  interface Ranked { readonly card: OfferCard; readonly amount: bigint | undefined }
  const ranked: Ranked[] = cards.flatMap((card): Ranked[] => {
    if (!card.priced) return [{ card, amount: undefined }];
    const amount = amountOnRail(card, rail);
    return amount === undefined ? [] : [{ card, amount }];
  });
  return ranked
    .sort((left, right) => {
      if (left.amount === undefined || right.amount === undefined) {
        if (left.amount === right.amount) return compareDigests(left.card, right.card);
        return left.amount === undefined ? -1 : 1;
      }
      if (left.amount !== right.amount) return left.amount < right.amount ? -1 : 1;
      return compareDigests(left.card, right.card);
    })
    .map((entry) => entry.card);
}

function compareDigests(left: OfferCard, right: OfferCard): number {
  if (left.offerRecordDigest === right.offerRecordDigest) return 0;
  return left.offerRecordDigest < right.offerRecordDigest ? -1 : 1;
}

export interface OfferListingQuery {
  /** The digest of the content being priced. */
  readonly subject: string;
  /** The rail the caller settles in; ordering only ever exists within one rail. */
  readonly rail: string;
  /** Offer digests the followed feeds have withdrawn (`delisted` / `superseded`). */
  readonly withdrawnOfferDigests?: ReadonlySet<string>;
}

/**
 * "Offers for subject X, live, cheapest first" — answered from announcement cards alone,
 * fetching no offer.
 *
 * This is the listing the profile exists to make renderable. A listing is exactly two
 * announcements on the holder's own append-only chain: the subject announced as available,
 * and its offer announced beside it. Nobody's permission is needed to publish those, and
 * nobody's permission is needed to build an index over them — competing indexes are the
 * intended shape.
 */
export function listOffersForSubject(
  items: readonly AnnouncedItem[],
  query: OfferListingQuery,
): OfferCard[] {
  const live = liveOfferCards(
    offerCardsForSubject(offerCards(items), query.subject),
    query.withdrawnOfferDigests ?? new Set<string>(),
  );
  return cheapestFirstOnRail(live, query.rail);
}
