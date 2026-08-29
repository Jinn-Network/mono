// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  GOLDEN_OFFERS,
  INVALID_OFFERS,
  loadGoldenDigest,
  loadGoldenDocument,
  loadGoldenEnvelope,
  loadInvalidDocument,
  type GoldenOfferName,
} from "./fixtures.js";
import { OFFER_RECORD_KIND, OFFER_RECORD_MEDIA_TYPE } from "./identifiers.js";
import { parseOfferEnvelope, sealOffer, sealOfferPayload } from "./seal.js";
import { OfferRecordSchema } from "./schema.js";

/** The keyid the shipped golden envelopes declare. */
export const FIXTURE_SIGNER_KEY_ID = "did:key:zOfferFixtureSigner" as const;

/**
 * The deterministic signer the shipped fixtures were sealed with.
 *
 * It is **not** a cryptographic signature: it emits `sha256(preAuthEncoding)`, so the
 * pinned envelope bytes are reproducible by anyone without shipping key material. That is
 * sound here for the same reason it is sound in the rest of this tree — DSSE signature
 * checking is an injected `DsseChainVerifier` port everywhere, never something a record
 * package does itself, so a fixture's signature bytes are opaque to every code path these
 * fixtures exercise. Never use this outside fixtures and tests.
 */
export function createFixtureOfferSigner(keyid: string = FIXTURE_SIGNER_KEY_ID) {
  return async (request: { readonly preAuthEncoding: Uint8Array }) =>
    [{
      signature: new Uint8Array(createHash("sha256").update(request.preAuthEncoding).digest()),
      keyid,
    }] as const;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Record conformance for the offer kind: identifier pinning, schema validation,
 * producer-side re-seal to the pinned bytes, consumer-side digest checking without
 * re-canonicalization, extension round-tripping, and the refused corpus.
 *
 * Any implementation that produces or consumes offers runs this driver to prove it
 * reproduces the frozen record surface. It asserts what an offer *is*; it asserts nothing
 * about whether anyone will honor one — that is the gate's business, and the buyer's
 * warranty is the hash of the bytes they receive.
 */
export function describeOfferRecordConformance(): void {
  describe("Offer record conformance", () => {
    test("the pinned identifiers are exactly the design's strings", () => {
      expect(OFFER_RECORD_KIND).toBe("https://spec.jinn.network/records/offer/v1");
      expect(OFFER_RECORD_MEDIA_TYPE).toBe("application/vnd.jinn.offer.v1+json");
    });

    describe.each(GOLDEN_OFFERS)("golden offer: %s", (name: GoldenOfferName) => {
      test("the sealed envelope parses and its payload is the pinned document", async () => {
        const parsed = parseOfferEnvelope(await loadGoldenEnvelope(name));
        expect(parsed.offer).toEqual(await loadGoldenDocument(name));
        expect(parsed.digest).toBe(await loadGoldenDigest(name));
      });

      test("producer-side re-seal reproduces the pinned envelope bytes and digest", async () => {
        const sealed = await sealOffer({
          offer: await loadGoldenDocument(name),
          signer: createFixtureOfferSigner(),
        });
        expect(decode(sealed.envelopeBytes)).toBe(decode(await loadGoldenEnvelope(name)));
        expect(sealed.digest).toBe(await loadGoldenDigest(name));
      });

      test("sealing the payload is idempotent through a parse", async () => {
        const once = sealOfferPayload(await loadGoldenDocument(name));
        const twice = sealOfferPayload(parseOfferEnvelope(await loadGoldenEnvelope(name)).offer);
        expect(decode(twice)).toBe(decode(once));
      });

      test("the offer carries no protocol fee, cut, or expiry", async () => {
        const offer = parseOfferEnvelope(await loadGoldenEnvelope(name)).offer as
          Record<string, unknown>;
        for (const absent of ["fee", "cut", "protocolFee", "expiresAt", "status", "currency"]) {
          expect(Object.hasOwn(offer, absent), `${absent} must not exist on an offer`).toBe(false);
        }
      });
    });

    test("a free offer is an empty rails list, never an absent one", async () => {
      const free = parseOfferEnvelope(await loadGoldenEnvelope("free")).offer;
      expect(free.rails).toEqual([]);
      expect(Object.hasOwn(free, "rails")).toBe(true);
    });

    test.each(INVALID_OFFERS)("the refused corpus refuses %s", async (name: string) => {
      expect(OfferRecordSchema.safeParse(await loadInvalidDocument(name)).success).toBe(false);
    });
  });
}
