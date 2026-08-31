// SPDX-License-Identifier: MIT

import { parseOfferEnvelope } from "@jinn-network/evidence-offer";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import type {
  FactsRecompute,
  RecordFactRecompute,
  RecordFactValue,
} from "@jinn-network/record-discovery-protocol";

import { OFFER_RECORD_KIND } from "./identifiers.js";

/**
 * Recomputes the offer card from the record's own sealed BYTES — never from a supplied
 * projection. An offer's identity is the digest of its DSSE envelope, so the announced
 * bytes are the envelope; `parseOfferEnvelope` is the strict parser that requires the exact
 * producer encoding and the exact canonical payload inside it, which is what makes the card
 * checkable at all. A card attached to re-serialized bytes recomputes to nothing and reads
 * as inconsistent.
 *
 * Every field is native — read out of this record's own bytes, with no retrieval of any
 * referenced record. `subject` is declared *reference-bearing* in the profile so discovery's
 * `referrers` relation inverts it, which is the query the whole profile exists for ("which
 * offers price `sha256:X`"). It is not thereby a retrievable record: an offer prices any
 * digest-addressed content, an OCI blob included, so there are no referenced bytes to
 * retrieve and re-hash. Same posture as `facts/environments` and its `image.manifestDigest`.
 *
 * `rails.rail` and `rails.amount` are two positionally aligned arrays rather than one array
 * of objects because a record fact is a scalar or an ordered array of scalars; an array of
 * objects is not a representable fact value. Their order is the record's own — the offer
 * schema already requires rails sorted and unique by rail identifier — so index `i` of one
 * array always names the amount at index `i` of the other. A free offer is the empty rail
 * list and carries both arrays empty, matching `priced: false`; absence and emptiness are
 * never confusable, because silence is not free.
 */
export const offerRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const { offer } = parseOfferEnvelope(bytes);
    const facts: Record<string, RecordFactValue> = {
      offerRecordDigest: recordDigest(bytes),
      subject: offer.subject,
      priced: offer.rails.length > 0,
      "rails.rail": offer.rails.map((rail) => rail.rail),
      "rails.amount": offer.rails.map((rail) => rail.amount),
    };
    return facts;
  } catch {
    return {};
  }
};

/**
 * The leaf's `FactsRecompute` registry entry: the host assembles the tree-wide registry by
 * merging each leaf's export. Unknown kinds return `undefined`, preserving discovery's
 * unknown-kind skip behavior.
 */
export const OFFERS_FACTS_RECOMPUTE: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    return kind === OFFER_RECORD_KIND ? offerRecompute : undefined;
  },
};
