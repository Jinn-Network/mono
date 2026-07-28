import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { recordDigest } from "../hashing.js";
import type { AnnouncedItem } from "../item.js";
import { verifyItem } from "./item.js";
import type {
  EntryFetcher,
  FactsRecompute,
  KeyResolver,
  RecordFetcher,
  SignatureVerifier,
  SubstrateChecker,
} from "./ports.js";

// Ruling §7.21 / plan Addendum 2026-07-28-c: the derivation annotation
// ({chainId, contract, event, blockNumber, txHash, logIndex}, design
// §6.2/§6.3) is unknown-field-tolerant, and blockHash/finalityTier/
// contractGeneration are ratified as registered standard additions. This
// suite verifies the IMPLEMENTED state of the annotation "schema" in this
// package: `AnnouncedItem.provenance.derivation` is typed `unknown` (see
// item.ts) and carries no zod schema anywhere in this package -- nothing
// parses, re-serializes, strips, or rejects it. `verifyItem`'s step 4
// (§10.4) hands the announced `derivation` value straight to the injected
// `SubstrateChecker` port by reference, unexamined. Tolerance therefore
// follows structurally from the absence of any validating schema; this test
// makes that assertion executable rather than merely narrated by proving
// the three registered additions survive the trip to the substrate-checking
// port byte-for-byte (field-for-field) alongside the base fields, using the
// fixture pinned at `fixtures/derivation-annotation-tolerance/`.
//
// Per the assignment's explicit instruction, if this test had found the
// annotation stripped or rejected, the correct response was to STOP and
// report blocked rather than silently widening anything -- it did not: the
// implemented state already tolerates every field named by the ruling.

const fixtureUrl = new URL(
  "../../fixtures/derivation-annotation-tolerance/annotation-with-registered-additions.json",
  import.meta.url,
);

function loadAnnotation(): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as Record<string, unknown>;
}

const unusedEntryFetcher: EntryFetcher = {
  async "fetch"(): Promise<Uint8Array> {
    throw new Error("entries port must not be called for this item verification");
  },
};
const unusedKeyResolver: KeyResolver = {
  async resolve() {
    throw new Error("keys port must not be called for this item verification");
  },
  async everBound() {
    throw new Error("keys port must not be called for this item verification");
  },
};
const unusedSignatureVerifier: SignatureVerifier = {
  async verify() {
    throw new Error("sigs port must not be called for this item verification");
  },
};
const noFactsRecompute: FactsRecompute = { get: () => undefined };

describe("derivation annotation extensibility (ruling §7.21, Addendum 2026-07-28-c)", () => {
  it("passes blockHash/finalityTier/contractGeneration through to SubstrateChecker unstripped, alongside the base fields", async () => {
    const annotation = loadAnnotation();
    // Sanity: the fixture actually names every base field plus the three
    // ratified additions -- guards against a future fixture edit silently
    // dropping the fields this test exists to cover.
    const description = annotation["description"];
    const { description: _description, ...derivation } = annotation;
    expect(typeof description).toBe("string");
    for (const field of [
      "chainId", "contract", "event", "blockNumber", "txHash", "logIndex",
      "blockHash", "finalityTier", "contractGeneration",
    ]) {
      expect(Object.hasOwn(derivation, field)).toBe(true);
    }

    const bytes = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
    const digest = recordDigest(bytes);
    const recordFetcher: RecordFetcher = { async "fetch"() { return bytes; } };

    const item: AnnouncedItem = {
      record: { kind: "https://jinn.network/records/delivery/1.0", digest },
      provenance: {
        source: { agent: "did:key:zProjector", name: "marketplace" },
        entry: digest,
        announcementId: "a1",
        derivation,
      },
    };

    let received: unknown;
    const capturingSubstrateChecker: SubstrateChecker = {
      async check(derivationArg) {
        received = derivationArg;
        return "present";
      },
    };

    const outcome = await verifyItem({
      item,
      decisionGrade: true,
      ports: {
        records: recordFetcher,
        entries: unusedEntryFetcher,
        keys: unusedKeyResolver,
        sigs: unusedSignatureVerifier,
        factsRecompute: noFactsRecompute,
        substrate: capturingSubstrateChecker,
        verifiedChain: async () => true,
      },
    });

    // Not stripped: every field the fixture declared, including the three
    // registered additions, is present on what the SubstrateChecker
    // actually received -- byte-for-byte the same object `verifyItem` was
    // given, never rejected or re-shaped in transit.
    expect(received).toEqual(derivation);
    expect(outcome).toEqual({ status: "verified", facts: "consistent", derivation: "present" });
  });
});
