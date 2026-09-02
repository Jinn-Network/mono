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
 */
export type PublisherIdentityClass = "bare-key" | "domain-bound";

export function publisherIdentityClass(binding: VerifiedDomainBinding | undefined): PublisherIdentityClass {
  return binding === undefined ? "bare-key" : "domain-bound";
}

/**
 * The one line that names the publisher. Bound, it is the domain with the proof mechanism named
 * plainly beside it; unbound, it is the bare key fingerprint, which is the only honest name a key
 * with no binding has.
 */
export function publisherIdentityLine(
  binding: VerifiedDomainBinding | undefined,
  keyFingerprint: string | undefined,
): string {
  if (binding !== undefined) {
    return `published by ${binding.domain} — ${DOMAIN_BINDING_MECHANISM_NAMES[binding.mechanism]} `
      + `at ${binding.proof.location}`;
  }
  // A key whose identifier is not a did:key yields no fingerprint. Saying so beats printing nothing,
  // which a reader would read as "there was nothing to say about this key".
  return keyFingerprint === undefined
    ? "no domain bound; this key carries no fingerprint this reader can compute"
    : `no domain bound; key ${keyFingerprint}`;
}

/**
 * What the binding does and does not establish. The unbound case returns `undefined` rather than a
 * sentence: `publisherIdentityLine` has already said there is no binding, and a paragraph about the
 * limits of a thing that is not there is the helper-text cruft this repository removes on sight.
 */
export function publisherIdentitySentence(binding: VerifiedDomainBinding | undefined): string | undefined {
  if (binding === undefined) return undefined;
  const mechanism = DOMAIN_BINDING_MECHANISM_NAMES[binding.mechanism];
  return `The key that signed this bundle also signed a statement naming ${binding.domain}, and this reader `
    + `checked that signature offline. The ${mechanism} to look up was derived from that key, not taken from `
    + `the statement. What is left is the half no bundle can carry: whether ${binding.domain} publishes `
    + `"${binding.proof.expectedValue}" at ${binding.proof.location}. Checking it is a lookup on your side, and `
    + `trusting the answer means trusting DNS resolution, whoever controls the domain's zone, and its registrar `
    + `— anyone who can change that zone can create this binding or remove it, and an answer obtained now says `
    + `nothing about what the zone held when this bundle was made.`;
}
