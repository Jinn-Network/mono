// SPDX-License-Identifier: Apache-2.0

/**
 * `colophon-domain-binding/1` (issue #2983): a signing key bound to a domain its holder controls,
 * by a proof the holder serves themselves.
 *
 * The problem is that a bundle's signer is a key, and a key is not an organization. A reader who
 * sees `sha256:9f3c…` has no way to reach "published by example.com". The standard answer is a
 * domain proof, and this is that answer at the smallest size it works at.
 *
 * Four rules shape it.
 *
 * - **Trust material is the reader's, not the bundle's.** This document is supplied to the verifier
 *   the way `--tsa-root` is, and no frozen bundle format moves to carry it. A binding is a claim
 *   about who published, which is exactly the kind of claim a reader should be able to evaluate,
 *   replace, or refuse without the producer's cooperation.
 * - **The proof location is DERIVED, never asserted.** A document that carried its own "look here"
 *   would let a publisher point a reader at a host they control instead of the domain they claim.
 *   So `domainBindingProof` computes the record to look up from `(domain, keyId, mechanism)` alone,
 *   and this module never reads such a field because the schema has none.
 * - **The key is the identifier.** `keyId` is a `did:key:z…`, which carries the Ed25519 public key
 *   in its own bytes (`./did-key.ts`), so the signature check needs nothing from the bundle but the
 *   fact that this keyId signed it. That is what makes one implementation work for every bundle
 *   format rather than one per trust grammar.
 * - **The offline half is stated as a half.** Everything here establishes that THE KEY asserted the
 *   domain. That the DOMAIN asserts the key is a DNS lookup or an HTTPS fetch, and it is the
 *   reader's; `./report-face.ts` says so in the sentence a reader actually reads.
 */

import { verify as verifySignature } from "node:crypto";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { refuse } from "../profile/errors.js";
import { ed25519PublicKeyFromDidKey } from "./did-key.js";

export const DOMAIN_BINDING_FORMAT = "colophon-domain-binding/1" as const;

/**
 * The two self-served mechanisms. Both are things only the domain's controller can do, and neither
 * needs a third party to attest anything.
 */
export const DOMAIN_BINDING_MECHANISMS = ["dns-txt", "well-known-url"] as const;
export type DomainBindingMechanism = (typeof DOMAIN_BINDING_MECHANISMS)[number];

/** How the mechanism is named on the human surface -- plainly, per the issue's second criterion. */
export const DOMAIN_BINDING_MECHANISM_NAMES: Record<DomainBindingMechanism, string> = {
  "dns-txt": "DNS TXT record",
  "well-known-url": "well-known URL",
};

/**
 * A registrable-looking hostname in its only accepted spelling: lowercase, dot-separated LDH
 * labels, at least two of them, no scheme, port, path, userinfo, trailing dot, or wildcard. The
 * point is not to model the public suffix list -- it is that one domain has one spelling here, so
 * two bindings for the same domain cannot render as two different publishers.
 */
const DomainSchema = z.string()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);

const DidKeySchema = z.string().regex(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/u);

/** The document minus its signature: exactly the bytes the signature covers. */
export const DomainBindingStatementSchema = z.strictObject({
  format: z.literal(DOMAIN_BINDING_FORMAT),
  domain: DomainSchema,
  keyId: DidKeySchema,
  mechanism: z.enum(DOMAIN_BINDING_MECHANISMS),
  statedAt: z.string().datetime({ offset: true }),
});
export type DomainBindingStatement = z.infer<typeof DomainBindingStatementSchema>;

export const DomainBindingDocumentSchema = DomainBindingStatementSchema.extend({
  /** Ed25519 over `domainBindingStatementBytes`, base64. */
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u),
});
export type DomainBindingDocument = z.infer<typeof DomainBindingDocumentSchema>;

/** The exact record a domain must publish for one binding. */
export interface DomainBindingProof {
  readonly mechanism: DomainBindingMechanism;
  /** The DNS name to query, or the URL to fetch. */
  readonly location: string;
  /** The exact line that record must contain. */
  readonly expectedValue: string;
}

/** A binding whose offline half checked out. */
export interface VerifiedDomainBinding extends DomainBindingStatement {
  readonly proof: DomainBindingProof;
  /**
   * What was actually established, in the type system, so no surface can render this value while
   * implying more. There is exactly one member and there may never be a second one produced by this
   * function: confirming the domain needs a DNS or HTTPS lookup, which happens on the reader's side
   * and is not something `verifyDomainBinding` can do or report.
   */
  readonly confirmation: "key-signature-only";
}

/** The label prefix on the published record, and the DNS name it lives under. */
const RECORD_PREFIX = "colophon-domain-binding=1";
const DNS_LABEL = "_colophon";
const WELL_KNOWN_PATH = "/.well-known/colophon-domain-binding.txt";

/** The bytes the signature covers: the canonical encoding of the statement, signature excluded. */
export function domainBindingStatementBytes(statement: DomainBindingStatement): Uint8Array {
  return canonicalJsonBytes(DomainBindingStatementSchema.parse(statement));
}

/**
 * Where to look, and what must be there. Derived from the binding alone -- see this module's third
 * rule. Both mechanisms publish the identical line, so a claimant who moves from DNS to a URL
 * republishes the same bytes under a different address.
 */
export function domainBindingProof(
  domain: string,
  keyId: string,
  mechanism: DomainBindingMechanism,
): DomainBindingProof {
  const expectedValue = `${RECORD_PREFIX}; key=${keyId}`;
  return mechanism === "dns-txt"
    ? { mechanism, location: `${DNS_LABEL}.${domain}`, expectedValue }
    : { mechanism, location: `https://${domain}${WELL_KNOWN_PATH}`, expectedValue };
}

/**
 * The offline check, in full.
 *
 * `signerKeyIds` is the set of keys that actually signed the bundle in hand. A binding for a key
 * that did not sign it is refused rather than rendered: it would otherwise let any domain holder
 * caption someone else's bundle with their own name.
 *
 * `refuse` rather than a boolean, because a supplied binding that does not check out is a reader
 * error worth naming -- silently falling back to the bare fingerprint would hide the one case where
 * a reader most needs to be told something is wrong.
 */
export function verifyDomainBinding(
  documentBytes: Uint8Array,
  signerKeyIds: Iterable<string>,
): VerifiedDomainBinding {
  const path = "domain-binding";
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(documentBytes));
  } catch {
    refuse("validation", path, "the domain binding is not valid UTF-8 JSON");
  }
  const parsed = DomainBindingDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    refuse("validation", path, `the domain binding does not satisfy ${DOMAIN_BINDING_FORMAT}`);
  }
  const { signature, ...statement } = parsed.data;

  const publicKey = ed25519PublicKeyFromDidKey(statement.keyId);
  if (publicKey === undefined) {
    refuse("validation", path, "the domain binding's keyId is not an Ed25519 did:key identifier");
  }
  const verified = verifySignature(
    null,
    Buffer.from(domainBindingStatementBytes(statement)),
    publicKey,
    Buffer.from(signature, "base64"),
  );
  if (!verified) {
    refuse("record-integrity", path, "the domain binding's signature does not verify under its own key");
  }
  if (![...signerKeyIds].includes(statement.keyId)) {
    refuse(
      "conflict",
      path,
      "the domain binding names a key that did not sign this bundle",
    );
  }
  return {
    ...statement,
    proof: domainBindingProof(statement.domain, statement.keyId, statement.mechanism),
    confirmation: "key-signature-only",
  };
}
