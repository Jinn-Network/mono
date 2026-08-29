// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings, Sha256DigestSchema } from "@jinn-network/trust-core";
import { z } from "zod";

import { isAbsoluteUri, namespacedObject } from "./extensions.js";
import { OFFER_RECORD_KIND } from "./identifiers.js";

const AbsoluteUri = z
  .string()
  .refine(isAbsoluteUri, "must be an absolute URI with no whitespace");

/**
 * A payment amount is an exact integer written as a string in the rail's native units.
 *
 * A string rather than a number because native units routinely exceed
 * `Number.MAX_SAFE_INTEGER` (wei, for one) and the sealed bytes admit only exact I-JSON
 * integers. No sign, no decimal point, no leading zeros: one amount has one spelling, or
 * two identical prices would seal to two digests.
 *
 * Zero is refused. A free offer is spelled by the empty `rails` list, so a `"0"` entry
 * would be a second spelling of the same terms — and it would put a rail identifier and a
 * payment destination on an offer that never takes a payment.
 */
const RailAmount = z
  .string()
  .regex(
    /^[1-9][0-9]*$/,
    "amount is an exact positive integer in the rail's native units, written without sign, "
      + "decimal point, or leading zeros; a free offer is the empty rails list",
  );

/**
 * One self-describing payment entry. `rail` names the payment system, `to` is the
 * rail-specific destination (opaque here — this package binds no rail), and `amount` is
 * exact in that rail's units. No reference currency and no conversion appears anywhere:
 * equivalence across a multi-rail offer is the holder's assertion, sealed with the offer.
 */
export const OfferRailSchema = namespacedObject({
  rail: AbsoluteUri,
  to: z.string().min(1, "to is the rail-specific destination and cannot be empty"),
  amount: RailAmount,
});
export type OfferRail = z.infer<typeof OfferRailSchema>;

/**
 * Where to present payment and collect bytes. Required even for a free offer — served on
 * sight still means served from somewhere. The gate protocol itself is a separate concern
 * (the paid-retrieval gate issue); this record only points at one.
 *
 * The scheme is deliberately unconstrained, because a gate may legitimately live behind
 * `https`, `ipfs`, or a scheme that does not exist yet. A `uri` is therefore an address a
 * buyer's own client decides how to dereference, never a link a consumer may hand to a
 * browser or a shell unexamined: anyone can seal an offer naming any gate.
 */
export const OfferGateSchema = namespacedObject({ uri: AbsoluteUri });
export type OfferGate = z.infer<typeof OfferGateSchema>;

/**
 * `rails` is required and MAY be empty.
 *
 * Empty is the explicit free offer. It is deliberately not optional: absence and emptiness
 * must not be confusable, because the market's other half of that rule is that a record
 * with no live offer is simply not offered — silence is not free.
 *
 * Entries are unique by `rail` and sorted by `rail` in UTF-16 code-unit order. Unique
 * because "pay on one of its rails" is ambiguous when one rail carries two amounts, and the
 * gate matches a rail entry by integer-exact amount. Sorted because equal terms must seal to
 * equal bytes and JCS does not sort arrays, so the schema does.
 */
const OfferRailsSchema = z.array(OfferRailSchema).superRefine((rails, ctx) => {
  for (let index = 1; index < rails.length; index += 1) {
    const previous = rails[index - 1]!.rail;
    const current = rails[index]!.rail;
    const order = compareCodeUnitStrings(previous, current);
    if (order === 0) {
      ctx.addIssue({
        code: "custom",
        path: [index, "rail"],
        message: `rails must be unique by rail identifier; "${current}" appears more than once`,
      });
    } else if (order > 0) {
      ctx.addIssue({
        code: "custom",
        path: [index, "rail"],
        message:
          "rails must be sorted by rail identifier in UTF-16 code-unit order so that equal "
          + "terms seal to equal bytes",
      });
    }
  }
});

/**
 * One offer prices one subject, always. `subject` is the digest of any digest-addressed
 * content — usually a sealed record, equally an artifact such as an OCI image blob, which
 * is what makes an environment sellable piece by piece.
 *
 * Repricing is supersession, never mutation: `supersedes` names the offer this one
 * replaces, and the replacement is a new record with a new digest.
 *
 * There is no protocol fee field, no cut, and no expiry: an offer stops applying when the
 * holder supersedes or delists it on their own announcement chain.
 */
export const OfferRecordSchema = namespacedObject({
  kind: z.literal(OFFER_RECORD_KIND),
  subject: Sha256DigestSchema,
  rails: OfferRailsSchema,
  gate: OfferGateSchema,
  supersedes: Sha256DigestSchema.optional(),
});
export type OfferRecord = z.infer<typeof OfferRecordSchema>;

/** An offer with no rail entries is served on sight; zero is first-class, never absence. */
export function isFreeOffer(offer: OfferRecord): boolean {
  return offer.rails.length === 0;
}
