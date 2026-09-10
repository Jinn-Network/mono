// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings, Sha256DigestSchema } from "@jinn-network/trust-core";
import { z } from "zod";

import { isAbsoluteUri, isNormalizedAbsoluteUri, namespacedObject } from "./extensions.js";
import { OFFER_RECORD_KIND } from "./identifiers.js";

const AbsoluteUri = z
  .string()
  .refine(isAbsoluteUri, "must be an absolute URI with no whitespace");

/** For a URI that is an identity key — see `isNormalizedAbsoluteUri`. */
const NormalizedAbsoluteUri = z
  .string()
  .refine(
    isNormalizedAbsoluteUri,
    "must be an absolute URI already in its normalized spelling (lowercase scheme and host, "
      + "no default port, no dot segments, no trailing-dot host, no empty query or fragment, "
      + "percent-escapes uppercase and never over an unreserved character, and no raw character "
      + "RFC 3986 requires escaped in that component), so one rail spelled with a special scheme "
      + "has exactly one identifier",
  );

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
 * Characters that make one destination render as another: the control characters `\p{Cc}` —
 * C0, DEL, and C1 (a line feed
 * splices a second line into a naive display, a NUL truncates one), the two Unicode line
 * separators, which splice a line the same way in HTML and most UI toolkits, and the Unicode
 * bidi controls (U+202E between two halves of an address reverses what a buyer reads). The
 * bidi half is exactly `\p{Bidi_Control}` — all twelve, U+061C included, since ALM reorders a
 * neutral run the same way its counterpart U+200F RLM does. This is the one field where
 * display spoofing is money.
 */
const DISPLAY_UNSAFE_CHARACTER =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/**
 * At least one character that is neither whitespace nor an invisible formatting character. That
 * refuses the ways a destination is blank in practice — `""`, `" "`, an ideographic space, a
 * lone zero-width space, a lone byte-order mark — without reaching for every codepoint that
 * happens to render as nothing, which is the doorway to the unbounded confusables problem this
 * package declines to own. Only the WHOLE value is judged: a format
 * character *inside* a destination stays legal, because ZWJ and ZWNJ are load-bearing in Indic
 * and Arabic scripts and a rail may put human-readable text here.
 */
const VISIBLE_CHARACTER = /[^\s\p{Cf}]/u;

/**
 * Every Unicode format character except the two joiners the reason above names. An allow-set,
 * written as a negative lookahead because the `v`-flag set difference `[\p{Cf}--[\u200C\u200D]]`
 * needs an ES2024 target this package does not have.
 *
 * It overlaps `DISPLAY_UNSAFE_CHARACTER` on the twelve bidi controls and neither subsumes the
 * other: that rule also covers `\p{Cc}` and the two line separators, which are not `\p{Cf}`,
 * and this one covers 156 format characters it does not reach. The overlap is deliberate,
 * because the two rules ask different questions — `DISPLAY_UNSAFE_CHARACTER` asks whether a
 * value reorders or splices what a buyer reads, this one asks whether it hides content inside
 * itself — and a bidi control is honestly both. zod runs every chained refine, so a value that
 * is both reports both messages.
 *
 * The 96-character tag block U+E0020–U+E007F is why this is worth the cost: it carries
 * arbitrary invisible ASCII inside a payment address, which is a channel and not a script.
 *
 * The cost, plainly: 156 format characters now have no accepted spelling inside a `to` value at
 * all, among them the Arabic and Syriac prefixed format controls (U+0600–U+0605, U+06DD,
 * U+070F) and the Egyptian quadrat controls (U+13430–U+1343F). A rail vocabulary that needs one
 * owes its own rule, the same way an opaque scheme does.
 *
 * What this closes is one channel, not the class, and the residue is larger than the two joiners
 * it deliberately keeps. The 256 variation selectors — U+FE00–U+FE0F and U+E0100–U+E01EF — are
 * `\p{Mn}`, so no rule here has ever reached them, and they smuggle a payload after an ASCII
 * character exactly as the tag block did. So do U+3164 HANGUL FILLER, U+115F, U+1160, the
 * Mongolian free variation selectors, and every unassigned code point, none of which is `\p{Cf}`
 * either. Naming them is the point: this rule shrinks the invisible-payload alphabet, it does not
 * empty it, and a reader who takes the sentence above for a closed class would be wrong. Closing
 * the rest means an allow-set over the whole of Unicode rather than over `\p{Cf}`, which is the
 * unbounded confusables problem this package declines three lines above.
 *
 * One more thing the shape of this rule decides rather than the rule itself: `\p{Cf}` resolves
 * against the engine's Unicode tables, so which characters are refused moves with the runtime.
 * `VISIBLE_CHARACTER` already had that dependency; this widens it to 156 more code points. Two
 * verifiers on different ICU versions can therefore disagree about one sealed offer, and the
 * `engines` floor is what bounds the spread today rather than a frozen list.
 */
const INTERIOR_FORMAT_CHARACTER = /(?![\u200C\u200D])\p{Cf}/u;

/**
 * The rail-specific payment destination. Its *syntax* stays opaque — this package binds no
 * rail and cannot know what a well-formed destination looks like on one that does not exist
 * yet, so no address shape is imposed here and none should be. What is refused is only what
 * is indefensible on every rail: a value with no character that is neither whitespace nor a
 * format character, one carrying characters whose whole effect is to make it display as a
 * different address than it is, and one carrying a format character other than ZWJ or ZWNJ,
 * whose whole effect is to hide content inside the address.
 */
const RailDestination = z
  .string()
  .refine(
    (value) => VISIBLE_CHARACTER.test(value),
    "to is the rail-specific destination and must carry at least one character that is neither "
      + "whitespace nor a Unicode format character",
  )
  .refine(
    (value) => !DISPLAY_UNSAFE_CHARACTER.test(value),
    "to must not carry control characters, line separators, or Unicode bidi controls, which "
      + "make one payment destination display as another",
  )
  .refine(
    (value) => !INTERIOR_FORMAT_CHARACTER.test(value),
    "to must not carry a Unicode format character other than ZWJ or ZWNJ, which hides content "
      + "inside a payment destination",
  );

/**
 * One self-describing payment entry. `rail` names the payment system, `to` is the
 * rail-specific destination (opaque here — this package binds no rail), and `amount` is
 * exact in that rail's units. No reference currency and no conversion appears anywhere:
 * equivalence across a multi-rail offer is the holder's assertion, sealed with the offer.
 */
export const OfferRailSchema = namespacedObject({
  rail: NormalizedAbsoluteUri,
  to: RailDestination,
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
 *
 * Both rules compare rail identifiers as exact strings, which is why `rail` must already be in
 * its normalized spelling: without that, two spellings of one URI would pass uniqueness and
 * sortedness alike, and the offer would carry one rail at two prices. `isNormalizedAbsoluteUri`
 * states exactly how far that reaches — it collapses every equivalent spelling under a special
 * scheme, and no scheme whose hosts or paths are opaque.
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

/**
 * Puts rail entries in the order the schema requires. Producers hold terms in whatever order
 * they were priced; sealing refuses an unsorted list rather than reordering it, because a
 * canonicalizer that silently rewrites content is how one document quietly becomes another.
 * This is the sanctioned way to satisfy the rule without every producer reimplementing
 * UTF-16 code-unit ordering — the one ordering that never consults the host locale.
 */
export function sortOfferRails<T extends { readonly rail: string }>(
  rails: readonly T[],
): readonly T[] {
  return [...rails].sort((left, right) => compareCodeUnitStrings(left.rail, right.rail));
}
