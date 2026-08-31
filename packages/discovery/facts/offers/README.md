# @jinn-network/record-discovery-facts-offers

> Candidate in `implementations-v1`. Eligible for receipt-gated canary; that is not independent ratification.

The record-discovery facts profile for the offer record kind, the recompute function a
consumer runs to re-derive that card from the record's own sealed bytes, and the card-only
listing queries an index answers with them.

The card carries the offer's own digest, the `subject` it prices, whether the offer is
`priced` or free, and — for a priced offer — the rail identifiers with their amounts.
Nothing else. The offer remains the binding document: anything a buyer commits to is checked
against the fetched, digest-checked, signature-verified offer, never against a card.

`subject` is declared reference-bearing, so discovery's `referrers` relation inverts it:
"which offers price `sha256:X`" is a first-class query, answered without fetching an offer.

Announcements confer no validity. A card is a filter-before-fetch hint; every decision-grade
use requires the fetched, digest-checked record.

## A listing is two announcements

With this profile, a listing is exactly two announcements on the holder's own append-only
chain: the subject record announced as available, and its offer announced beside it.

The announcement chain is holder-owned and openly readable. Nobody's permission is needed to
list a record, and nobody's permission is needed to build an index over the feeds. Competing
indexes are the intended shape.

## Locations match the terms

A location is a hint about *where* bytes live; an offer says *on what terms* they are had.
They are independent signed acts answering different questions, and access control is
outside the discovery protocol's scope. Concretely, for a listing:

- a free-and-open subject carries ordinary open locations;
- a priced subject carries gate locations, or none;
- a subject with no locations and no offer is announced existence-only and is not
  retrievable.

An open HTTPS location beside a priced offer is the holder undercutting their own gate.
It is legal — their bytes, their chain — but do not publish one, and an index may flag the
mismatch.

## Withdrawal and supersession

Neither is a card field, and neither should become one. An offer stops applying when its
holder delists or supersedes it, and both are ordinary `withdrawn` announcements carrying
the existing `"delisted"` / `"superseded"` reason codes. `liveOfferCards` takes the
withdrawn set an index derived from the feeds it follows; a card never claims to be live
about itself.

## Ordering is per rail

An offer carries no reference currency and no conversion — equivalence across a multi-rail
offer is the holder's own assertion — so there is no total order over prices quoted on
different rails. `cheapestFirstOnRail` therefore ranks within one named rail: the caller
picks the rail it settles in. A free offer costs nothing on every rail and sorts ahead of
every priced one; a priced offer that does not quote the named rail is dropped, being
unpriced *in that rail's terms*, which is not the same as free.

```ts
import {
  listOffersForSubject,
} from "@jinn-network/record-discovery-facts-offers";

const catalog = listOffersForSubject(announcedItems, {
  subject: "sha256:…",
  rail: "https://rails.example/usdc-base",
  withdrawnOfferDigests: withdrawn,
});
```

## Card and record must agree

A card that disagrees with its record is a defect of the announcing feed. The chain-and-facts
verifier checks it the way it checks every other facts profile: `factsConsistency` recomputes
each record-classed field from the record's own fetched bytes through this leaf's
`OFFERS_FACTS_RECOMPUTE` and compares field by field. `src/facts-conformance.test.ts` drives
that at the public `verifyItem` boundary.
