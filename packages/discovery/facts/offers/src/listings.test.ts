// The index-side demonstration: "offers for subject X, live, cheapest first", answered from
// announcement cards alone. Every card here is recomputed from a real sealed offer envelope,
// so the catalog under test is one an honest feed would actually publish -- but nothing in
// the query path fetches an offer, which is the property the profile exists to give an index.
import { createHash } from "node:crypto";

import { OFFER_RECORD_KIND, sealOffer } from "@jinn-network/evidence-offer";
import type { AnnouncedItem } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  cheapestFirstOnRail,
  liveOfferCards,
  listOffersForSubject,
  offerCards,
  offerCardsForSubject,
  readOfferCard,
} from "./listings.js";
import { offerRecompute } from "./recompute.js";

const SOURCE = { agent: "did:key:zOfferListingHolder", name: "offers" };
const SUBJECT = `sha256:${"a".repeat(64)}` as const;
const OTHER_SUBJECT = `sha256:${"b".repeat(64)}` as const;
const OLAS = "https://spec.jinn.network/rails/eip155-8453-erc20-olas/v1";
const USDC = "https://spec.jinn.network/rails/eip155-8453-erc20-usdc/v1";

const signer = async (request: { readonly preAuthEncoding: Uint8Array }) =>
  [{
    signature: new Uint8Array(createHash("sha256").update(request.preAuthEncoding).digest()),
    keyid: "did:key:zOfferListingSigner",
  }] as const;

const noReferencedBytes = { async "fetch"() { return undefined; } };

interface OfferTerms {
  readonly subject: string;
  readonly rails: readonly { rail: string; amount: string }[];
}

let announcementCounter = 0;

/** Seals an offer, recomputes its card from the sealed bytes, and announces it. */
async function announce(terms: OfferTerms): Promise<AnnouncedItem> {
  const sealed = await sealOffer({
    offer: {
      kind: OFFER_RECORD_KIND,
      subject: terms.subject,
      rails: terms.rails.map((rail, index) => ({
        rail: rail.rail,
        to: `0x${String(index + 1).repeat(40).slice(0, 40)}`,
        amount: rail.amount,
      })),
      gate: { uri: "https://gate.example/offers" },
    },
    signer,
  });
  const facts = await offerRecompute(sealed.envelopeBytes, noReferencedBytes);
  announcementCounter += 1;
  return {
    record: { kind: OFFER_RECORD_KIND, digest: sealed.digest },
    facts,
    provenance: {
      source: SOURCE,
      entry: `sha256:${"e".repeat(64)}`,
      announcementId: `ann-${announcementCounter}`,
    },
  };
}

function digest(item: AnnouncedItem): string {
  return item.record.digest;
}

describe("reading an offer card off an announced item", () => {
  it("reads a priced card back as aligned rail entries", async () => {
    const item = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "1500000" }] });
    expect(readOfferCard(item)).toMatchObject({
      subject: SUBJECT,
      priced: true,
      rails: [{ rail: USDC, amount: "1500000" }],
    });
  });

  it("reads a free card back as priced:false with no rail entries", async () => {
    const item = await announce({ subject: SUBJECT, rails: [] });
    expect(readOfferCard(item)).toMatchObject({ priced: false, rails: [] });
  });

  it("misses an item of another kind", async () => {
    const item = await announce({ subject: SUBJECT, rails: [] });
    expect(readOfferCard({
      ...item,
      record: { ...item.record, kind: "https://spec.jinn.network/records/environment/v1" },
    })).toBeUndefined();
  });

  it("misses rather than throws on a card an index cannot read", async () => {
    const item = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "1500000" }] });
    const card = item.facts as Record<string, unknown>;
    for (const broken of [
      undefined,
      "not an object",
      { ...card, "rails.amount": [] },                    // arrays out of alignment
      { ...card, "rails.amount": ["1.5"] },               // not an exact integer amount
      { ...card, "rails.amount": ["01"] },                // leading zero: a second spelling
      { ...card, priced: false },                         // free/priced contradicts the rails
      { ...card, subject: 7 },
      { ...card, "rails.rail": "not an array" },
    ]) {
      expect(readOfferCard({ ...item, facts: broken })).toBeUndefined();
    }
  });
});

describe("offers for one subject", () => {
  it("keeps only the cards pricing that subject", async () => {
    const mine = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const theirs = await announce({ subject: OTHER_SUBJECT, rails: [{ rail: USDC, amount: "1" }] });
    expect(
      offerCardsForSubject(offerCards([mine, theirs]), SUBJECT).map((card) => card.offerRecordDigest),
    ).toEqual([digest(mine)]);
  });
});

describe("liveness comes from the chain, never from the card", () => {
  it("drops offers the holder delisted or superseded", async () => {
    const kept = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const delisted = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "1" }] });
    const superseded = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "2" }] });
    const withdrawn = new Set([digest(delisted), digest(superseded)]);
    expect(
      liveOfferCards(offerCards([kept, delisted, superseded]), withdrawn)
        .map((card) => card.offerRecordDigest),
    ).toEqual([digest(kept)]);
  });
});

describe("cheapest first, within one rail", () => {
  it("orders priced offers by exact amount and puts free offers first", async () => {
    const gratis = await announce({ subject: SUBJECT, rails: [] });
    const dear = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "9000000" }] });
    const cheap = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "1500000" }] });
    expect(
      cheapestFirstOnRail(offerCards([dear, gratis, cheap]), USDC).map(digestOfCard),
    ).toEqual([digest(gratis), digest(cheap), digest(dear)]);
  });

  it("compares amounts as integers, not as text or as floats", async () => {
    // "9" sorts after "10" as text; 1e18+1 and 1e18+2 collapse to one value as doubles.
    const nine = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "9" }] });
    const ten = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const huge = await announce({
      subject: SUBJECT,
      rails: [{ rail: USDC, amount: "1000000000000000001" }],
    });
    const huger = await announce({
      subject: SUBJECT,
      rails: [{ rail: USDC, amount: "1000000000000000002" }],
    });
    expect(
      cheapestFirstOnRail(offerCards([huger, ten, huge, nine]), USDC).map(digestOfCard),
    ).toEqual([digest(nine), digest(ten), digest(huge), digest(huger)]);
  });

  it("drops a priced offer that does not quote the rail — unpriced there is not free", async () => {
    const usdcOnly = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const olasOnly = await announce({ subject: SUBJECT, rails: [{ rail: OLAS, amount: "1" }] });
    expect(cheapestFirstOnRail(offerCards([usdcOnly, olasOnly]), USDC).map(digestOfCard))
      .toEqual([digest(usdcOnly)]);
  });

  it("ranks a multi-rail offer by the amount it quotes on the chosen rail", async () => {
    // Cheap in OLAS, dear in USDC: which one is 'cheapest' is a question only a rail answers.
    const skewed = await announce({
      subject: SUBJECT,
      rails: [{ rail: OLAS, amount: "1" }, { rail: USDC, amount: "9000000" }],
    });
    const flat = await announce({
      subject: SUBJECT,
      rails: [{ rail: OLAS, amount: "5" }, { rail: USDC, amount: "10" }],
    });
    expect(cheapestFirstOnRail(offerCards([skewed, flat]), OLAS).map(digestOfCard))
      .toEqual([digest(skewed), digest(flat)]);
    expect(cheapestFirstOnRail(offerCards([skewed, flat]), USDC).map(digestOfCard))
      .toEqual([digest(flat), digest(skewed)]);
  });

  it("breaks ties on the offer digest so one input set has one output order", async () => {
    const first = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const second = await announce({
      subject: SUBJECT,
      rails: [{ rail: OLAS, amount: "10" }, { rail: USDC, amount: "10" }],
    });
    const forward = cheapestFirstOnRail(offerCards([first, second]), USDC).map(digestOfCard);
    const backward = cheapestFirstOnRail(offerCards([second, first]), USDC).map(digestOfCard);
    expect(forward).toEqual(backward);
    expect(forward).toEqual([...forward].sort());
  });
});

describe("the whole listing query, from cards alone", () => {
  it("answers 'offers for subject X, live, cheapest first'", async () => {
    const cheapestButDelisted = await announce({
      subject: SUBJECT,
      rails: [{ rail: USDC, amount: "1" }],
    });
    const cheap = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "1500000" }] });
    const dear = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "9000000" }] });
    const otherSubject = await announce({
      subject: OTHER_SUBJECT,
      rails: [{ rail: USDC, amount: "2" }],
    });
    const otherRail = await announce({ subject: SUBJECT, rails: [{ rail: OLAS, amount: "3" }] });

    expect(
      listOffersForSubject([dear, otherSubject, cheapestButDelisted, otherRail, cheap], {
        subject: SUBJECT,
        rail: USDC,
        withdrawnOfferDigests: new Set([digest(cheapestButDelisted)]),
      }).map(digestOfCard),
    ).toEqual([digest(cheap), digest(dear)]);
  });

  it("treats an unsupplied withdrawn set as 'nothing withdrawn', never as 'nothing live'", async () => {
    const only = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    expect(listOffersForSubject([only], { subject: SUBJECT, rail: USDC }).map(digestOfCard))
      .toEqual([digest(only)]);
  });

  it("returns nothing for a subject nobody has offered", async () => {
    const only = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    expect(listOffersForSubject([only], { subject: OTHER_SUBJECT, rail: USDC })).toEqual([]);
  });
});

function digestOfCard(card: { readonly offerRecordDigest: string }): string {
  return card.offerRecordDigest;
}
