import { createHash } from "node:crypto";

import { OFFER_RECORD_KIND, sealOffer, sealOfferPayload } from "@jinn-network/evidence-offer";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import type { ReferencedBytes } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import { offerRecompute, OFFERS_FACTS_RECOMPUTE } from "./recompute.js";

const SUBJECT = `sha256:${"a".repeat(64)}` as const;
const OLAS = "https://spec.jinn.network/rails/eip155-8453-erc20-olas/v1";
const USDC = "https://spec.jinn.network/rails/eip155-8453-erc20-usdc/v1";

/**
 * Not a cryptographic signature — `sha256(preAuthEncoding)`, so these bytes are reproducible
 * without key material. Sound here for the same reason it is sound in the record package's
 * own fixtures: DSSE signature checking is an injected port everywhere, and no code path
 * under test looks at these bytes.
 */
const signer = async (request: { readonly preAuthEncoding: Uint8Array }) =>
  [{
    signature: new Uint8Array(createHash("sha256").update(request.preAuthEncoding).digest()),
    keyid: "did:key:zOfferFactsTestSigner",
  }] as const;

const priced = {
  kind: OFFER_RECORD_KIND,
  subject: SUBJECT,
  rails: [
    { rail: OLAS, to: "0x1111111111111111111111111111111111111111", amount: "2500000000000000000" },
    { rail: USDC, to: "0x2222222222222222222222222222222222222222", amount: "1500000" },
  ],
  gate: { uri: "https://gate.example/offers" },
};

const free = {
  kind: OFFER_RECORD_KIND,
  subject: SUBJECT,
  rails: [],
  gate: { uri: "https://gate.example/offers" },
};

/** No recompute in this leaf reads referenced bytes; a port that always misses proves it. */
const noReferencedBytes: ReferencedBytes = { async "fetch"() { return undefined; } };

describe("offer record-fact recompute", () => {
  it("recomputes the whole card from a priced offer's sealed envelope bytes", async () => {
    const sealed = await sealOffer({ offer: priced, signer });
    expect(await offerRecompute(sealed.envelopeBytes, noReferencedBytes)).toEqual({
      offerRecordDigest: recordDigest(sealed.envelopeBytes),
      subject: SUBJECT,
      priced: true,
      "rails.rail": [OLAS, USDC],
      "rails.amount": ["2500000000000000000", "1500000"],
    });
  });

  it("keeps the rail identifiers and their amounts positionally aligned", async () => {
    const sealed = await sealOffer({ offer: priced, signer });
    const facts = await offerRecompute(sealed.envelopeBytes, noReferencedBytes);
    const rails = facts["rails.rail"] as readonly string[];
    const amounts = facts["rails.amount"] as readonly string[];
    expect(rails.length).toBe(amounts.length);
    expect(rails.map((rail, index) => [rail, amounts[index]])).toEqual([
      [OLAS, "2500000000000000000"],
      [USDC, "1500000"],
    ]);
  });

  it("reports a free offer as an empty rail list, never as absent rails", async () => {
    const sealed = await sealOffer({ offer: free, signer });
    expect(await offerRecompute(sealed.envelopeBytes, noReferencedBytes)).toEqual({
      offerRecordDigest: recordDigest(sealed.envelopeBytes),
      subject: SUBJECT,
      priced: false,
      "rails.rail": [],
      "rails.amount": [],
    });
  });

  it("announces the supersession edge only when the offer carries one", async () => {
    const predecessor = await sealOffer({ offer: priced, signer });
    const superseding = await sealOffer({
      offer: { ...priced, supersedes: predecessor.digest },
      signer,
    });
    expect(await offerRecompute(predecessor.envelopeBytes, noReferencedBytes))
      .not.toHaveProperty("supersedes");
    expect(await offerRecompute(superseding.envelopeBytes, noReferencedBytes))
      .toMatchObject({ supersedes: predecessor.digest });
  });

  it("recomputes nothing from a bare canonical payload — an offer's identity is its envelope", async () => {
    expect(await offerRecompute(sealOfferPayload(priced), noReferencedBytes)).toEqual({});
  });

  it("recomputes nothing from bytes that are not a sealed offer", async () => {
    expect(await offerRecompute(new TextEncoder().encode("{}"), noReferencedBytes)).toEqual({});
  });

  it("recomputes nothing from a re-serialized envelope, so a card on it reads inconsistent", async () => {
    const sealed = await sealOffer({ offer: priced, signer });
    const reserialized = new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(sealed.envelopeBytes)), null, 2),
    );
    expect(await offerRecompute(reserialized, noReferencedBytes)).toEqual({});
  });
});

describe("the leaf's facts-recompute registry", () => {
  it("serves the offer kind and skips every other", () => {
    expect(OFFERS_FACTS_RECOMPUTE.get(OFFER_RECORD_KIND)).toBe(offerRecompute);
    expect(OFFERS_FACTS_RECOMPUTE.get("https://spec.jinn.network/records/environment/v1"))
      .toBeUndefined();
  });
});
