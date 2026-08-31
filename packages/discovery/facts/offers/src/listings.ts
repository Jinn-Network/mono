// SPDX-License-Identifier: MIT

import type { AnnouncedItem, SourceIdentity } from "@jinn-network/record-discovery-protocol";

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

function has(card: Record<string, unknown>, name: string): boolean {
  // Matches `factsConsistency`'s own-property test. Plain indexing would let a field
  // reachable only through a polluted `Object.prototype` be *used* here and *skipped* there,
  // putting the two layers out of step over the same card.
  return Object.prototype.hasOwnProperty.call(card, name);
}

function stringField(card: Record<string, unknown>, name: string): string | undefined {
  if (!has(card, name)) return undefined;
  const value = card[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayField(card: Record<string, unknown>, name: string): string[] | undefined {
  if (!has(card, name)) return undefined;
  const value = card[name];
  if (!Array.isArray(value)) return undefined;
  // Copied, not aliased: the array lives on the caller's `item.facts`, and a validating
  // reader must not hand back a reference whose contents can change after it checked them.
  return value.every((entry) => typeof entry === "string") ? [...(value as string[])] : undefined;
}

/** An amount as the offer schema pins it: an exact positive integer, no sign, no leading zero. */
const CARD_AMOUNT = /^[1-9][0-9]*$/;

/** A digest as `Sha256DigestSchema` pins it. */
const CARD_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Characters whose whole effect is to make one string display as another: the control
 * characters, the two Unicode line separators, and the bidi controls. The offer schema refuses
 * these in a payment destination, where "this is the one field where display spoofing is
 * money"; a card carries no destination, but it does carry a rail identifier a catalog renders
 * beside a price, so the same refusal applies to the one display string a card has.
 */
const DISPLAY_UNSAFE_CHARACTER =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/**
 * Reads the offer card off an announced item, or `undefined` when the item is not an offer
 * or its card is not one this profile can read.
 *
 * Every structural defect is a miss rather than a throw. A card is an unverified statement by
 * whoever announced it, so an index sorting a catalog must be able to walk a feed containing a
 * malformed one; the defect surfaces where it belongs, in the chain-and-facts verifier, which
 * recomputes the card against the record. Sorting is not the place to adjudicate that.
 *
 * What is checked here is only what a card can be checked for WITHOUT fetching an offer, and
 * every check exists because skipping it would yield a wrong *ordering* rather than a miss:
 *
 * - **The card's `offerRecordDigest` must equal the announcement's own `record.digest`.** The
 *   item's digest is bound to the announcement entry; the card's copy is written by the
 *   announcer. Reading the announcer's copy is how an announcer picks its own rank among equal
 *   prices, since the digest is the tie-break, and it is the digest a catalog carries forward
 *   to fetch and verify the offer a row stands for — so a misstated one sends the buyer's
 *   verification at the wrong record. The two values agree in every honest card, so binding
 *   them costs nothing and closes both.
 * - **The two rail arrays must be the same length**, because their alignment is what makes
 *   them one list.
 * - **`priced` must agree with the rail list**, since a free offer is exactly the empty list.
 * - **Rail identifiers must be unique and sorted**, as the offer schema requires of the record.
 *   A card repeating one rail at two prices reads fine otherwise, and `amountOnRail` would rank
 *   the offer at whichever of the two it met first.
 * - **Amounts and digests must match their sealed grammars**, and a rail identifier must carry
 *   no character whose only job is to make it render as a different rail.
 */
export function readOfferCard(item: AnnouncedItem): OfferCard | undefined {
  const record = item.record as AnnouncedItem["record"] | undefined;
  if (record === null || record === undefined) return undefined;
  if (record.kind !== OFFER_RECORD_KIND) return undefined;
  if (typeof item.facts !== "object" || item.facts === null || Array.isArray(item.facts)) {
    return undefined;
  }
  const card = item.facts as Record<string, unknown>;
  const offerRecordDigest = stringField(card, "offerRecordDigest");
  const subject = stringField(card, "subject");
  const priced = has(card, "priced") ? card["priced"] : undefined;
  if (offerRecordDigest === undefined || subject === undefined || typeof priced !== "boolean") {
    return undefined;
  }
  if (!CARD_DIGEST.test(offerRecordDigest) || !CARD_DIGEST.test(subject)) return undefined;
  if (offerRecordDigest !== record.digest) return undefined;
  const railIds = stringArrayField(card, "rails.rail");
  const amounts = stringArrayField(card, "rails.amount");
  if (railIds === undefined || amounts === undefined) return undefined;
  if (railIds.length !== amounts.length) return undefined;
  if (priced !== (railIds.length > 0)) return undefined;
  if (!amounts.every((amount) => CARD_AMOUNT.test(amount))) return undefined;
  if (railIds.some((rail) => rail.length === 0 || DISPLAY_UNSAFE_CHARACTER.test(rail))) {
    return undefined;
  }
  // Strictly ascending in UTF-16 code-unit order, which is what `<` gives and what the offer
  // schema's own comparator gives. Strict, so it refuses a repeated rail in the same pass.
  for (let index = 1; index < railIds.length; index += 1) {
    if (!(railIds[index - 1]! < railIds[index]!)) return undefined;
  }
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
 * One withdrawal as the announcing source published it: the source whose chain carried the
 * `withdrawn` announcement, and the announcement it retracts.
 *
 * Both halves are mandatory, and that is the whole point of the type. Withdrawal is
 * source-scoped by construction — `checkGlobalChainRules` resolves a `retracts` only against
 * announcements earlier in the SAME chain, and retracting anything else is a
 * `foreign-retraction` violation — so a source can only ever withdraw its own announcement.
 * A withdrawn set keyed on the record digest alone would discard that dimension, and folding
 * many sources' withdrawals into one such set applies each source's withdrawal to every other
 * source's announcement of the same digest. Nothing binds an `available` announcement to the
 * announced record's holder (it is a bare `RecordRef`), so any announcer may mirror a
 * competitor's digest, withdraw its own mirror, and silently delist the competitor's live
 * offer from every index that folded that way — the same hazard the `supersedes` edge carries
 * and the README already refuses. Carrying the source makes that fold unexpressible rather
 * than merely discouraged.
 *
 * `announcementId`, not a digest, because an announcementId is what a `withdrawn` announcement
 * actually names. Keying on it also means a source that relists after delisting is live again
 * under its new announcement, which is the honest reading of its own chain.
 */
export interface WithdrawnAnnouncement {
  readonly source: SourceIdentity;
  readonly announcementId: string;
}

/**
 * The identity a withdrawal and an announced item are matched on: the `(agent, name)` source
 * tuple plus the announcement ID. Encoded as JSON so no field's contents can be spelled to
 * look like a boundary between two others.
 */
function withdrawalKey(source: SourceIdentity, announcementId: string): string {
  return JSON.stringify([source.agent, source.name, announcementId]);
}

/**
 * The cards whose offers the announcing source's own chain has not withdrawn.
 *
 * Liveness is not a card field and must not become one: an offer stops applying when its
 * holder delists or supersedes it, and both are `withdrawn` announcements with the existing
 * `"delisted"` / `"superseded"` reason codes. The index derives that set from the feeds it
 * follows and passes it here; the card never claims to be live about itself.
 *
 * Each withdrawal retires only the announcement its own source published (see
 * `WithdrawnAnnouncement`), so an index following many feeds may hand the whole set over at
 * once: one source's withdrawal can never reach another source's announcement, whatever
 * digest the two carry.
 */
export function liveOfferCards(
  cards: readonly OfferCard[],
  withdrawn: Iterable<WithdrawnAnnouncement>,
): OfferCard[] {
  const retired = new Set<string>();
  for (const entry of withdrawn) {
    retired.add(withdrawalKey(entry.source, entry.announcementId));
  }
  return cards.filter((card) => {
    const { source, announcementId } = card.item.provenance;
    return !retired.has(withdrawalKey(source, announcementId));
  });
}

function amountOnRail(card: OfferCard, rail: string): bigint | undefined {
  const entry = card.rails.find((candidate) => candidate.rail === rail);
  // `OfferCard` is exported and its amount grammar is enforced in `readOfferCard`, not in the
  // type. A caller assembling a card literal would otherwise get a `SyntaxError` out of a
  // function whose whole documented posture is that a defect is a miss.
  if (entry === undefined || !CARD_AMOUNT.test(entry.amount)) return undefined;
  return BigInt(entry.amount);
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
 * on the offer digest by code-unit order, so equal prices order the same on every host — no
 * comparison here consults the host locale. Two cards can still compare equal outright, but
 * only when they carry the same digest, which means they are duplicate announcements of one
 * offer and interchangeable in the result.
 *
 * A priced card whose amount on this rail does not match the sealed amount grammar is dropped
 * rather than ranked. `readOfferCard` already refuses one; this covers an `OfferCard` a caller
 * assembled itself.
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
  /**
   * The withdrawals (`delisted` / `superseded`) the followed feeds have published, each
   * carrying the source that published it. Omitted means nothing is known to be withdrawn —
   * never that nothing is live.
   */
  readonly withdrawnAnnouncements?: Iterable<WithdrawnAnnouncement>;
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
 *
 * Fetching no offer is the feature and also the limit. Every row this returns is an
 * unverified statement by whoever announced it, filtered only for what a card can be checked
 * for on its own. A row is a candidate to show, never a term to settle on: what a buyer
 * commits to is checked against the fetched, digest-checked, signature-verified offer.
 * Announcing `priced: false` is the cheapest lie available here, and it is caught the moment
 * anyone verifies — so a catalog that will take money on a row verifies before it does.
 *
 * `withdrawnAnnouncements` is keyed on `(source, announcementId)` — what a `withdrawn`
 * announcement actually names, scoped to the chain entitled to name it. A withdrawal never
 * reaches another source's announcement of the same digest.
 */
export function listOffersForSubject(
  items: readonly AnnouncedItem[],
  query: OfferListingQuery,
): OfferCard[] {
  const live = liveOfferCards(
    offerCardsForSubject(offerCards(items), query.subject),
    query.withdrawnAnnouncements ?? [],
  );
  return cheapestFirstOnRail(live, query.rail);
}
