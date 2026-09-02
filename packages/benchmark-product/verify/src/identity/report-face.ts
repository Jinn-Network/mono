// SPDX-License-Identifier: Apache-2.0

/**
 * The report face for `colophon-domain-binding/1` (issue #2983, acceptance criteria 2 and 3): who
 * published, in the plainest words the evidence supports, and exactly what trusting it means.
 *
 * The same three rules `../binding/report-face.ts` states, for the same reasons: single-sourced so
 * producer and reader render the same function, keyed on verified facts rather than configuration,
 * and asserting nothing the check did not establish.
 *
 * The third rule does the most work here, because a domain binding is genuinely half-checkable and
 * the half that is missing is the half a reader cares about. Verifying the document establishes
 * that the KEY named the domain. It cannot establish that the DOMAIN named the key -- that is a DNS
 * lookup or an HTTPS fetch on the reader's side, and it is not something a bundle can ever carry,
 * because a recorded observation of a zone is not the zone. So the limits sentence names the
 * remaining step, names who must take it, and names what trusting its answer rests on: DNS
 * resolution, the party controlling the zone, and the registrar behind it. Anyone with the zone can
 * create this binding or remove it, and an answer obtained now says nothing about what the zone held
 * when the bundle was made.
 *
 * That sentence quotes the record verbatim, `did:key` and all, which is the one place this reader
 * puts a raw identifier on the human surface. Issue #3024 keeps them off it because they are "noise
 * a reader has to decode"; here the identifier is not something to decode but the exact literal to
 * compare a TXT record against, so paraphrasing it would remove the only part of the sentence a
 * reader can act on. It appears there and nowhere else.
 */

import {
  DOMAIN_BINDING_MECHANISM_NAMES,
  type VerifiedDomainBinding,
} from "./domain-binding.js";

/**
 * How a bundle's publisher is identified to a reader. `bare-key` is the historical state and stays
 * the default: the absence of a binding is a fact about the publication, and is reported as one.
 *
 * `domain-claimed`, never `domain-bound`. The member names what was established, the way
 * `RunBindingClass`'s members do, and what was established is a claim: the key named the domain.
 * A downstream surface branching on `domain-bound` would reasonably render "domain bound", which is
 * the very assertion `VerifiedDomainBinding.confirmation` exists to withhold.
 */
export type PublisherIdentityClass = "bare-key" | "domain-claimed";

export function publisherIdentityClass(binding: VerifiedDomainBinding | undefined): PublisherIdentityClass {
  return binding === undefined ? "bare-key" : "domain-claimed";
}

/**
 * The lines that name the publisher: the key it actually is, then what it claims to be.
 *
 * The claim line is deliberately ATTRIBUTIVE. Anyone holding a key can sign a statement naming a
 * domain they do not control, and this reader checked only that the key made the statement — so
 * `published by example.com` would assert, at the top of the report and past a paragraph break from
 * its own qualification, the one thing the check did not establish. `renderAnchor` puts `present`
 * beside `verified` on its own head line for exactly this reason, and the sibling
 * `../binding/report-face.ts` was revised three times (#3322, #3425, #3426) on the rule that a
 * weaker basis changes the OPENING rather than leaning harder on a trailing paragraph. `unconfirmed
 * here` is that word, and it names where the confirmation is missing rather than declaring the claim
 * false, because a published record would make it true.
 *
 * The fingerprint is printed either way. Under an unconfirmed claim it is still the only name of
 * this key that this reader established, so removing it would leave a reader who declines to make
 * the lookup with no identity at all.
 */
export function publisherIdentityLines(
  binding: VerifiedDomainBinding | undefined,
  keyFingerprint: string | undefined,
): readonly string[] {
  // A key whose identifier is not a did:key yields no fingerprint. Saying so beats printing nothing,
  // which a reader would read as "there was nothing to say about this key".
  const key = keyFingerprint === undefined
    ? "this key carries no fingerprint this reader can compute"
    : `key ${keyFingerprint}`;
  if (binding === undefined) return [`${key} — no domain bound`];
  binding.confirmation satisfies "key-signature-only";
  return [
    key,
    `claims publication by ${binding.domain} — unconfirmed here; `
    + `check the ${DOMAIN_BINDING_MECHANISM_NAMES[binding.mechanism]} at ${binding.proof.location}`,
    // The record's own line, unwrapped and unquoted, because a reader compares it byte for byte --
    // the same reason `renderAnchor` gives the record digest a line of its own.
    `expect: ${binding.proof.expectedValue}`,
  ];
}

/**
 * What the binding does and does not establish. The unbound case returns `undefined` rather than a
 * sentence: `publisherIdentityLine` has already said there is no binding, and a paragraph about the
 * limits of a thing that is not there is the helper-text cruft this repository removes on sight.
 */
export function publisherIdentitySentence(binding: VerifiedDomainBinding | undefined): string | undefined {
  if (binding === undefined) return undefined;
  const mechanism = DOMAIN_BINDING_MECHANISM_NAMES[binding.mechanism];
  return `The key that signed this bundle also signed a statement naming ${binding.domain}, dated `
    + `${binding.statedAt}, and this reader checked that signature offline. The date is the statement's own; `
    + `nothing here places the signature at it. The ${mechanism} to look up was `
    + `derived from that key, not taken from the statement. What is left is the half no bundle can carry: `
    + `whether ${binding.domain} actually publishes the record named above. `
    + `Checking it is a lookup on your side, and trusting the answer means trusting DNS resolution, whoever `
    + `controls the domain's zone, and its registrar — anyone who can change that zone can create this binding `
    + `or remove it, and an answer obtained now says nothing about what the zone held on the date the `
    + `statement carries.`;
}
