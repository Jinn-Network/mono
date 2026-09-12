// The index-side demonstration: "offers for subject X, live, cheapest first", answered from
// announcement cards alone. Every card here is recomputed from a real sealed offer envelope,
// so the catalog under test is one an honest feed would actually publish -- but nothing in
// the query path fetches an offer, which is the property the profile exists to give an index.
import { createHash } from "node:crypto";

import { OFFER_RECORD_KIND, OfferRailSchema, sealOffer } from "@jinn-network/evidence-offer";
import type { AnnouncedItem } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  cheapestFirstOnRail,
  liveOfferCards,
  listOffersForSubject,
  offerCards,
  offerCardsForSubject,
  readOfferCard,
  type WithdrawnAnnouncement,
} from "./listings.js";
import { offerRecompute } from "./recompute.js";

const SOURCE = { agent: "did:key:zOfferListingHolder", name: "offers" };
// A second, unrelated announcer. Nothing stops it mirroring the holder's digests.
const HOSTILE_SOURCE = { agent: "did:key:zHostileAnnouncer", name: "offers" };
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
  readonly source?: { agent: string; name: string };
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
      source: terms.source ?? SOURCE,
      entry: `sha256:${"e".repeat(64)}`,
      announcementId: `ann-${announcementCounter}`,
    },
  };
}

function digest(item: AnnouncedItem): string {
  return item.record.digest;
}

/** The withdrawal an index folds out of the feed when this item's announcement is retracted. */
function withdrawalOf(item: AnnouncedItem): WithdrawnAnnouncement {
  return {
    source: item.provenance.source,
    announcementId: item.provenance.announcementId,
  };
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

  it("misses a card whose digest is not the announcement's own", async () => {
    const item = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const card = item.facts as Record<string, unknown>;
    expect(readOfferCard({
      ...item,
      facts: { ...card, offerRecordDigest: `sha256:${"f".repeat(64)}` },
    })).toBeUndefined();
  });

  it("misses a card repeating or unsorting its rails, which would otherwise misprice it", async () => {
    const item = await announce({
      subject: SUBJECT,
      rails: [{ rail: OLAS, amount: "9000000" }, { rail: USDC, amount: "9000000" }],
    });
    const card = item.facts as Record<string, unknown>;
    // One rail at two prices: `amountOnRail` would rank the offer at whichever it met first.
    expect(readOfferCard({
      ...item,
      facts: { ...card, "rails.rail": [USDC, USDC], "rails.amount": ["1", "9000000"] },
    })).toBeUndefined();
    expect(readOfferCard({
      ...item,
      facts: { ...card, "rails.rail": [USDC, OLAS] },
    })).toBeUndefined();
  });

  it("misses a card whose digests are not digests, or whose rail renders as another", async () => {
    const item = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const card = item.facts as Record<string, unknown>;
    for (const broken of [
      { ...card, subject: "FREE — Ubuntu 24.04 base image" },
      { ...card, subject: "SHA256:" + "A".repeat(64) },
      { ...card, "rails.rail": [`https://rails.example/\u202egnitekcar`] },
      { ...card, "rails.rail": ["https://rails.example/a\u0000b"] },
      { ...card, "rails.rail": [""] },
    ]) {
      expect(readOfferCard({ ...item, facts: broken })).toBeUndefined();
    }
  });

  it("misses rather than throws on an item with no record reference", async () => {
    const item = await announce({ subject: SUBJECT, rails: [] });
    const { record: _record, ...rest } = item;
    expect(() => readOfferCard(rest as unknown as AnnouncedItem)).not.toThrow();
    expect(readOfferCard(rest as unknown as AnnouncedItem)).toBeUndefined();
  });

  // The exact analogue for `provenance`, which was the one required field of the item that
  // `readOfferCard` did not guard. A read card is destructured unconditionally in
  // `liveOfferCards` (`card.item.provenance`), so each shape below used to be READ and then
  // throw a `TypeError` out of the withdrawal filter -- one malformed feed item taking the
  // whole listing down, which is precisely the posture this function documents itself as not
  // having.
  it("misses rather than throws on an item whose provenance an index cannot read", async () => {
    const item = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    for (const broken of [
      undefined,
      null,
      "x",
      7,
      {},                          // no announcementId, no source
      { announcementId: "a" },     // announcementId alone: the source half still decides the key
    ]) {
      expect(() =>
        readOfferCard({ ...item, provenance: broken } as unknown as AnnouncedItem),
      ).not.toThrow();
      expect(readOfferCard({ ...item, provenance: broken } as unknown as AnnouncedItem)).toBeUndefined();
    }

    // The property a caller actually sees: a bad item is dropped from the listing instead of
    // destroying it.
    const bad = { ...item, provenance: { announcementId: "a" } } as unknown as AnnouncedItem;
    const good = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "20" }] });
    expect(liveOfferCards(offerCards([bad, good]), []).map((card) => card.offerRecordDigest)).toEqual([
      digest(good),
    ]);
  });

  // The other half of the same guard, and the half the throwing shapes above cannot reach.
  // Each shape here destructures cleanly in `liveOfferCards` and never throws -- the defect is
  // that `withdrawalKey` JSON-encodes whatever it is handed, so a non-string (or empty) value
  // keys the announcement at something no withdrawal of it can produce. Delete any one of the
  // `announcementId` / `source.agent` / `source.name` clauses and the shape it covers is READ,
  // which is why they are asserted one field at a time: the other three are held valid so the
  // miss is attributable.
  it("misses rather than mis-keying an item whose provenance carries the wrong value types", async () => {
    const item = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const ok = { agent: "did:key:zSomeone", name: "offers" };
    for (const broken of [
      { announcementId: 7, source: ok },
      { announcementId: "", source: ok },
      { announcementId: "a", source: "x" },
      { announcementId: "a", source: [] },
      { announcementId: "a", source: { agent: 7, name: "offers" } },
      { announcementId: "a", source: { agent: "", name: "offers" } },
      { announcementId: "a", source: { agent: "did:key:zSomeone", name: 7 } },
      { announcementId: "a", source: { agent: "did:key:zSomeone", name: "" } },
    ]) {
      const candidate = { ...item, provenance: broken } as unknown as AnnouncedItem;
      expect(() => readOfferCard(candidate)).not.toThrow();
      expect(readOfferCard(candidate), JSON.stringify(broken)).toBeUndefined();
    }

    // The property a caller actually sees, and the reason a mis-key is worse than a throw: the
    // announcing source withdrew this announcement, and an item read under a key its own
    // withdrawal cannot spell would keep showing a delisted offer as live.
    const misKeyed = {
      ...item,
      provenance: { ...item.provenance, announcementId: 7 },
    } as unknown as AnnouncedItem;
    const withdrawal: WithdrawnAnnouncement = { source: item.provenance.source, announcementId: "7" };
    expect(liveOfferCards(offerCards([misKeyed]), [withdrawal])).toEqual([]);
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
  it("cannot be evaded by a card that misstates its own digest", async () => {
    // Re-announce a delisted offer under a card claiming to be some other offer. The card is
    // refused outright, because a card that misstates its own digest is the one a catalog
    // would carry forward to fetch and verify the wrong record.
    const delisted = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "1" }] });
    const impostor: AnnouncedItem = {
      ...delisted,
      facts: {
        ...(delisted.facts as Record<string, unknown>),
        offerRecordDigest: `sha256:${"f".repeat(64)}`,
      },
    };
    expect(
      listOffersForSubject([impostor], {
        subject: SUBJECT,
        rail: USDC,
        withdrawnAnnouncements: [withdrawalOf(delisted)],
      }),
    ).toEqual([]);
  });

  it("lets no announcer withdraw another announcer's offer", async () => {
    // The censorship attack a digest-keyed withdrawn set would allow, and which the chain
    // rules forbid: hostile announcer M forges nothing and needs no key of the holder's. It
    // mirrors the holder's offer digest on its own chain -- an `available` announcement is a
    // bare `RecordRef` bound to no holder, so this is chain-valid -- and then withdraws its
    // own mirror, which is also chain-valid because it retracts M's own announcement. An index
    // that folded both feeds' withdrawals together by record digest would drop the holder's
    // live offer along with M's mirror, silently and indistinguishably from an honest delist.
    const honest = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "100" }] });
    const mirror: AnnouncedItem = {
      ...honest,
      provenance: { ...honest.provenance, source: HOSTILE_SOURCE, announcementId: "m-ann-2" },
    };
    const hostileOwnOffer = await announce({
      subject: SUBJECT,
      rails: [{ rail: USDC, amount: "900" }],
      source: HOSTILE_SOURCE,
    });

    const catalog = listOffersForSubject([honest, mirror, hostileOwnOffer], {
      subject: SUBJECT,
      rail: USDC,
      withdrawnAnnouncements: [withdrawalOf(mirror)],
    });

    // M's mirror is gone, because M withdrew it. The holder's own announcement of the same
    // digest is untouched and still the cheapest row.
    expect(catalog.map(digestOfCard)).toEqual([digest(honest), digest(hostileOwnOffer)]);
    expect(catalog[0]!.item.provenance.source).toEqual(SOURCE);
  });

  it("drops offers the holder delisted or superseded", async () => {
    const kept = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const delisted = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "1" }] });
    const superseded = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "2" }] });
    const withdrawn = [withdrawalOf(delisted), withdrawalOf(superseded)];
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

  it("drops rather than throws on a hand-built card whose amount is not an exact integer", async () => {
    const good = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const [card] = offerCards([good]);
    const handBuilt = { ...card!, rails: [{ rail: USDC, amount: "abc" }] };
    expect(() => cheapestFirstOnRail([handBuilt], USDC)).not.toThrow();
    expect(cheapestFirstOnRail([handBuilt], USDC)).toEqual([]);
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
        withdrawnAnnouncements: [withdrawalOf(cheapestButDelisted)],
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

// `listings.ts` carries its own copies of two grammars the sealed offer schema owns: the amount
// regex (schema: `RailAmount`) and the display-unsafe character class. They are byte-identical
// today and nothing ties them together -- neither constant is exported from either side, so a
// narrowing or widening edit to the schema's copy leaves the card reader silently accepting a
// different language than the record it claims to summarize. The consequence is asymmetric and
// worse than it looks: the reader accepting MORE than the record means an index ranks a card
// whose offer the record layer will refuse; accepting LESS means an honest offer never reaches
// the catalog at all.
//
// Pinned through `readOfferCard` rather than by re-declaring the constants. A re-declared copy
// pins nothing -- it drifts with neither side -- and exporting the constants would widen a
// sealed record package's API to serve a test, while moving the card reader onto a zod parse
// would put one on the per-amount hot path `amountOnRail` deliberately keeps clear.
//
// Two traps the probes must respect. Each holds the OTHER field valid, so a refusal is
// attributable to the field under test. And the card's rail-identifier rule is compared against
// the schema's `to`, never its `rail`: `rail` is a `NormalizedAbsoluteUri` and would refuse
// these probes for an unrelated reason -- the pairing the `DISPLAY_UNSAFE_CHARACTER` comment in
// `listings.ts` already documents.
//
// One narrower gap, recorded rather than fixed: `readOfferCard` does not check rail identifiers
// against `NormalizedAbsoluteUri` at all, so a card can carry two spellings of one rail and
// still pass the card-side uniqueness rule the record forbids. That is not exploitable for
// mispricing, because `amountOnRail` matches the caller's exact rail string, and narrowing what
// the reader accepts would be a behavior change rather than a drift pin.
describe("the card reader's grammars track the sealed offer schema", () => {
  const railOf = (to: string, amount: string) =>
    OfferRailSchema.safeParse({ rail: USDC, to, amount }).success;

  it("accepts exactly the amounts the schema's RailAmount accepts", async () => {
    const item = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const card = item.facts as Record<string, unknown>;
    for (const amount of ["1", "10", "0", "01", "", "-1", "1.0", " 1", "1e3", "+1"]) {
      const readable =
        readOfferCard({ ...item, facts: { ...card, "rails.amount": [amount] } }) !== undefined;
      expect(readable, `amount ${JSON.stringify(amount)}`).toBe(railOf("0xabc", amount));
    }
  });

  it("refuses exactly the display-unsafe and interior-format characters the schema refuses in a destination", async () => {
    const item = await announce({ subject: SUBJECT, rails: [{ rail: USDC, amount: "10" }] });
    const card = item.facts as Record<string, unknown>;
    // Each in-class codepoint is paired with an adjacent out-of-class one, so a narrowed class
    // and a widened one both show up rather than only one direction. The second class the
    // schema refuses — every format character except the joiners U+200C/U+200D — is probed in
    // both directions too: the two joiners as accepted, and U+2060 WORD JOINER, U+206A, U+FEFF
    // and U+E0041 (the tag block) as refused.
    for (const code of [
      0x00, 0x0a, 0x1f, 0x20, 0x7e, 0x7f, 0x9f, 0xa0, 0x061c, 0x061d, 0x200c, 0x200d, 0x200e,
      0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x202f, 0x2060, 0x2065, 0x2066, 0x2069, 0x206a,
      0xfeff, 0xe0041,
    ]) {
      const char = String.fromCodePoint(code);
      const readable =
        readOfferCard({ ...item, facts: { ...card, "rails.rail": [USDC + char] } }) !== undefined;
      expect(readable, `U+${code.toString(16).toUpperCase().padStart(4, "0")}`)
        .toBe(railOf(`addr${char}`, "10"));
    }
  });
});

function digestOfCard(card: { readonly offerRecordDigest: string }): string {
  return card.offerRecordDigest;
}
