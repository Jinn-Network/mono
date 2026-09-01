// SPDX-License-Identifier: MIT

// The shipped fixture catalog is a MIRROR of the offer record package's own goldens, and a
// copy that nobody checks is a fork waiting to happen. Every file is pinned here
// byte-for-byte against its source, and the cards they recompute to are pinned too, because
// a consumer across the evidence/discovery boundary builds its catalog from exactly these
// bytes and this leaf is the only sanctioned edge it can reach them through.
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { offerRecompute } from "./recompute.js";

const CATALOG = ["free", "priced", "superseding"] as const;

const SUBJECT = `sha256:${"a".repeat(64)}`;
const OLAS = "https://spec.jinn.network/rails/eip155-8453-erc20-olas/v1";
const USDC = "https://spec.jinn.network/rails/eip155-8453-erc20-usdc/v1";

const noReferencedBytes = { async fetch() { return undefined; } };

async function mirrored(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`../fixtures/catalog/${name}.json`, import.meta.url)));
}

async function golden(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(
    new URL(`../../../../evidence/offer/fixtures/offer/${name}.json`, import.meta.url),
  ));
}

describe("the shipped offer catalog fixtures", () => {
  it.each(CATALOG)("mirrors the record package's golden %s envelope byte for byte", async (name) => {
    expect(await mirrored(name)).toEqual(await golden(name));
  });

  it("recomputes to the catalog the listing queries are demonstrated on", async () => {
    const cards = await Promise.all(
      CATALOG.map(async (name) => offerRecompute(await mirrored(name), noReferencedBytes)),
    );
    const [free, priced, superseding] = cards;
    expect(free).toMatchObject({ subject: SUBJECT, priced: false, "rails.rail": [], "rails.amount": [] });
    expect(priced).toMatchObject({
      subject: SUBJECT,
      priced: true,
      "rails.rail": [OLAS, USDC],
      "rails.amount": ["2500000000000000000", "1500000"],
    });
    expect(superseding).toMatchObject({
      subject: SUBJECT,
      priced: true,
      "rails.rail": [USDC],
      "rails.amount": ["900000"],
      supersedes: priced!["offerRecordDigest"],
    });
  });
});
