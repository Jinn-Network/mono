// Leaf facts-conformance at the public verifyItem / facts-consistency boundary, mirroring
// `packages/discovery/facts/environments/src/facts-conformance.test.ts`: kit `digestOf` +
// `makeInMemoryPorts` supply the AnnouncementEntry chain and the unused keys/sigs stubs,
// while this leaf's own recompute and a byte-exact RecordFetcher are injected at verifyItem.
import { createHash } from "node:crypto";

import { OFFER_RECORD_KIND, sealOffer } from "@jinn-network/evidence-offer";
import {
  GENESIS_SEQUENCE,
  RECORD_DISCOVERY_VERSION,
  recordDigest,
  verifyItem,
} from "@jinn-network/record-discovery-protocol";
import type {
  AnnouncedItem,
  AnnouncementEntry,
  ItemOutcome,
  RecordFetcher,
} from "@jinn-network/record-discovery-protocol";
import { digestOf, makeInMemoryPorts } from "@jinn-network/record-discovery-testing";
import { describe, expect, it } from "vitest";

import { offerFactsProfile } from "./profiles.js";
import { OFFERS_FACTS_RECOMPUTE } from "./recompute.js";

const SOURCE = { agent: "did:key:zOfferFactsConformance", name: "offers" };
const SUBJECT = `sha256:${"a".repeat(64)}` as const;
const OLAS = "https://spec.jinn.network/rails/eip155-8453-erc20-olas/v1";
const USDC = "https://spec.jinn.network/rails/eip155-8453-erc20-usdc/v1";

const signer = async (request: { readonly preAuthEncoding: Uint8Array }) =>
  [{
    signature: new Uint8Array(createHash("sha256").update(request.preAuthEncoding).digest()),
    keyid: "did:key:zOfferFactsTestSigner",
  }] as const;

const document = {
  kind: OFFER_RECORD_KIND,
  subject: SUBJECT,
  rails: [
    { rail: OLAS, to: "0x1111111111111111111111111111111111111111", amount: "2500000000000000000" },
    { rail: USDC, to: "0x2222222222222222222222222222222222222222", amount: "1500000" },
  ],
  gate: { uri: "https://gate.example/offers" },
};

async function verify(
  facts: Record<string, unknown>,
  offer: unknown = document,
): Promise<ItemOutcome> {
  const sealed = await sealOffer({ offer, signer });
  const digest = recordDigest(sealed.envelopeBytes);
  const entry: AnnouncementEntry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: SOURCE,
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-08-31T12:00:00Z",
    announcements: [
      { announcementId: "ann-offer", action: "available", record: { kind: OFFER_RECORD_KIND, digest } },
    ],
  };
  const entryDigest = digestOf(entry);
  const kitPorts = makeInMemoryPorts({ entries: { [entryDigest]: entry } });

  const records: RecordFetcher = {
    async "fetch"(requested) {
      if (requested === digest) return sealed.envelopeBytes;
      throw new Error(`no record seeded for ${requested}`);
    },
  };

  const item: AnnouncedItem = {
    record: { kind: OFFER_RECORD_KIND, digest },
    facts,
    provenance: { source: SOURCE, entry: entryDigest, announcementId: "ann-offer" },
  };

  return verifyItem({
    item,
    profile: offerFactsProfile,
    decisionGrade: false,
    ports: {
      records,
      entries: kitPorts.entries,
      keys: kitPorts.keys,
      sigs: kitPorts.sigs,
      factsRecompute: OFFERS_FACTS_RECOMPUTE,
      verifiedChain: async () => true,
    },
  });
}

async function truthfulCard(offer: unknown = document): Promise<Record<string, unknown>> {
  const sealed = await sealOffer({ offer, signer });
  const terms = offer as {
    subject: string;
    rails: readonly { rail: string; amount: string }[];
    supersedes?: string;
  };
  return {
    offerRecordDigest: recordDigest(sealed.envelopeBytes),
    subject: terms.subject,
    priced: terms.rails.length > 0,
    "rails.rail": terms.rails.map((rail) => rail.rail),
    "rails.amount": terms.rails.map((rail) => rail.amount),
    ...(terms.supersedes === undefined ? {} : { supersedes: terms.supersedes }),
  };
}

describe("facts/offers leaf conformance via verifyItem", () => {
  it("consistent: a truthful card matches the recomputed facts", async () => {
    expect(await verify(await truthfulCard())).toEqual({ status: "verified", facts: "consistent" });
  });

  it("inconsistent: a card naming a subject the offer does not price", async () => {
    expect(
      await verify({ ...(await truthfulCard()), subject: `sha256:${"b".repeat(64)}` }),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card advertising a priced offer as free", async () => {
    expect(
      await verify({ ...(await truthfulCard()), priced: false, "rails.rail": [], "rails.amount": [] }),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card undercutting the sealed amount", async () => {
    expect(
      await verify({ ...(await truthfulCard()), "rails.amount": ["1", "1500000"] }),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card renaming a rail while keeping its amount", async () => {
    expect(
      await verify({
        ...(await truthfulCard()),
        "rails.rail": ["https://rails.example/impostor", USDC],
      }),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card adding a rail the offer never carried", async () => {
    expect(
      await verify({
        ...(await truthfulCard()),
        "rails.rail": [OLAS, USDC, "https://rails.example/extra"],
        "rails.amount": ["2500000000000000000", "1500000", "1"],
      }),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card claiming the offer's digest is some other record's", async () => {
    expect(
      await verify({ ...(await truthfulCard()), offerRecordDigest: `sha256:${"c".repeat(64)}` }),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("consistent: a free offer announced as free", async () => {
    const gratis = { ...document, rails: [] };
    expect(await verify(await truthfulCard(gratis), gratis))
      .toEqual({ status: "verified", facts: "consistent" });
  });

  it("inconsistent: a free offer announced as priced", async () => {
    const gratis = { ...document, rails: [] };
    expect(
      await verify(
        { ...(await truthfulCard(gratis)), priced: true, "rails.rail": [USDC], "rails.amount": ["1"] },
        gratis,
      ),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("consistent: a truthful supersession edge matches the sealed predecessor digest", async () => {
    const predecessor = await sealOffer({ offer: document, signer });
    const superseding = { ...document, supersedes: predecessor.digest };
    expect(await verify(await truthfulCard(superseding), superseding))
      .toEqual({ status: "verified", facts: "consistent" });
  });

  it("inconsistent: a card naming a predecessor the offer never superseded", async () => {
    const predecessor = await sealOffer({ offer: document, signer });
    const superseding = { ...document, supersedes: predecessor.digest };
    expect(
      await verify(
        { ...(await truthfulCard(superseding)), supersedes: `sha256:${"d".repeat(64)}` },
        superseding,
      ),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("consistent: a partial card is checked only on what it announces", async () => {
    const { offerRecordDigest, subject } = await truthfulCard();
    expect(await verify({ offerRecordDigest, subject }))
      .toEqual({ status: "verified", facts: "consistent" });
  });
});
