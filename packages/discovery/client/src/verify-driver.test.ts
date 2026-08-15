import { describe, expect, it } from "vitest";
import type { BindingResolver, BindingResolverQuery, ResolvedBinding } from "@jinn-network/trust-core";
import type { AnnouncedItem, AnnouncementEntry, SourceHead } from "@jinn-network/record-discovery-protocol";
import {
  DISCOVERY_SIGNING_SCOPE,
  parseAnnouncementEntry,
  parseSourceHead,
  sealJson,
  sha256Hex,
} from "@jinn-network/record-discovery-protocol";
import { loadVectorsByKind } from "@jinn-network/record-discovery-testing";

import { createInMemoryHighWaterMarkStore } from "./high-water-mark.js";
import { createTrustAdapter } from "./trust-adapter.js";
import type { AgentKeyCatalogEntry, RawSignatureVerifier } from "./trust-adapter.js";
import { createVerifyDriver } from "./verify-driver.js";

interface FakeBindingSeed {
  agent: string;
  keyid: string;
  validFrom: string;
  validTo: string | null;
  scope: string;
}

function makeFakeBindingResolver(seeds: FakeBindingSeed[]): BindingResolver {
  return {
    async resolveBinding(query: BindingResolverQuery, atTime: string): Promise<ResolvedBinding | null> {
      const seed = seeds.find((s) => s.agent === query.agent && s.keyid === query.key);
      if (seed === undefined) return null;
      const at = new Date(atTime).getTime();
      const from = new Date(seed.validFrom).getTime();
      const to = seed.validTo === null ? Number.POSITIVE_INFINITY : new Date(seed.validTo).getTime();
      if (at < from || at >= to) return null;
      return {
        binding: {
          protocol: "https://spec.jinn.network/trust/key-binding/v1",
          agent: seed.agent,
          key: { publicKey: `pubkey-${seed.keyid}`, keyid: seed.keyid, algorithm: "ed25519", didKey: seed.keyid },
          voucher: { kind: "account", did: "did:pkh:eip155:1:0x0", contractAccount: false },
          relationship: "controls",
          scope: [seed.scope],
          validFrom: seed.validFrom,
          ...(seed.validTo === null ? {} : { expiresAt: seed.validTo }),
          ceremony: { type: "eoa", digest: `sha256:${"0".repeat(64)}` },
          strength: "strong",
          anchors: [],
        } as never,
        envelopeBytes: new Uint8Array(),
        bindingDigest: `sha256:${"0".repeat(64)}`,
        effectiveStart: seed.validFrom,
        isGenesis: true,
        revocations: [],
      };
    },
  };
}

/** Matches the M3 kit's own fake-signing scheme (`sha256Hex(pae) + ":" + keyid`), which the §18 vector fixtures were generated against. */
const vectorCompatibleVerifier: RawSignatureVerifier = {
  async verify(pae, sig, key) {
    return new TextDecoder().decode(sig) === `${sha256Hex(pae)}:${key.keyid}`;
  },
};

/** Accepts any signature -- used only where this test constructs its own entries/heads and the point under test is driver wiring, not cryptography (already covered by trust-adapter.test.ts). */
const acceptAllVerifier: RawSignatureVerifier = {
  async verify() {
    return true;
  },
};

async function* toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe("createVerifyDriver (§10.1/§10.3/§10.4: wires the trust adapter into the named verification procedures)", () => {
  it("verifySource rejects a head signed by a rotated-out key (unauthorized-signer)", async () => {
    const vector = loadVectorsByKind("source-chain").find((v) => v.name === "competing-head-rotated-out-key");
    expect(vector).toBeDefined();
    const input = vector!.input as {
      seed: { now: string; keys: FakeBindingSeed[] };
      firstAdoption: boolean;
      head: unknown;
      headSignature: unknown;
      entries: Array<{ entry: unknown; signature: unknown }>;
    };

    const trust = createTrustAdapter({
      bindingResolver: makeFakeBindingResolver(input.seed.keys),
      keyCatalog: {
        async candidateKeys(agent: string): Promise<AgentKeyCatalogEntry[]> {
          return input.seed.keys.filter((k) => k.agent === agent).map((k) => ({ keyid: k.keyid, probeAt: k.validFrom }));
        },
      },
      verifier: vectorCompatibleVerifier,
    });
    const driver = createVerifyDriver({
      trust,
      hwm: createInMemoryHighWaterMarkStore(),
      factsProfiles: { get: () => undefined },
      factsRecompute: { get: () => undefined },
      records: { "fetch": async () => new Uint8Array() },
      entries: { "fetch": async () => new Uint8Array() },
      now: () => new Date(input.seed.now),
    });

    const outcome = await driver.verifySource({
      source: { agent: "did:key:zAgentSourceOne", name: "feed" },
      head: parseSourceHead(input.head),
      headSignature: input.headSignature as never,
      entries: toAsyncIterable(
        input.entries.map((e) => ({ entry: parseAnnouncementEntry(e.entry), signature: e.signature as never })),
      ),
      firstAdoption: input.firstAdoption,
    });

    expect(outcome.status).toBe("unauthorized-signer");
  });

  it("verifyForDecision rejects an item citing an entry that was never verified onto the source's chain (unauthorized-provenance)", async () => {
    const vector = loadVectorsByKind("item").find((v) => v.name === "item-unauthorized-provenance");
    expect(vector).toBeDefined();
    const input = vector!.input as { item: AnnouncedItem; fetchedBytes: unknown; citedEntry: unknown };

    const trust = createTrustAdapter({
      bindingResolver: makeFakeBindingResolver([]),
      keyCatalog: { async candidateKeys() { return []; } },
      verifier: acceptAllVerifier,
    });
    const driver = createVerifyDriver({
      trust,
      hwm: createInMemoryHighWaterMarkStore(),
      factsProfiles: { get: () => undefined },
      factsRecompute: { get: () => undefined },
      records: { "fetch": async () => sealJson(input.fetchedBytes).bytes },
      // The cited entry is REAL and genuinely announces this item (§10.4
      // step 3's membership check passes) -- it is simply never run through
      // `verifySource`, so the driver's own verified-chain set never
      // records it. The rejection below is for the chain-membership
      // reason the vector is named for, not a fetch/digest mismatch.
      entries: {
        "fetch": async (digest) => {
          if (digest !== input.item.provenance.entry) throw new Error(`unexpected entry fetch: ${digest}`);
          return sealJson(input.citedEntry).bytes;
        },
      },
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    });
    // No verifySource call for this item's source -- its cited entry is
    // therefore never on the driver's verified-chain set, exactly the
    // fabricated-provenance case (a query service citing a source it never
    // actually synced).

    const outcome = await driver.verifyForDecision(input.item);

    expect(outcome.status).toBe("unauthorized-provenance");
  });

  it("verifyForDecision mandates derivation-consistency for a projected item; verifyForFilter skips it (shallow, §13.1)", async () => {
    const entry: AnnouncementEntry = parseAnnouncementEntry({
      protocol: "https://spec.jinn.network/record-discovery/v1",
      source: { agent: "did:key:zProjector", name: "marketplace" },
      sequence: "0000000000000001",
      previous: null,
      timestamp: "2026-07-28T12:00:00.000Z",
      announcements: [
        {
          announcementId: "ann-1",
          action: "available",
          record: { kind: "https://spec.jinn.network/records/delivery/v1", digest: sealJson({ kind: "delivery" }).digest },
        },
      ],
    });
    const entryDigest = sealJson(entry).digest;
    const now = new Date("2026-07-28T12:00:00.000Z");

    const trust = createTrustAdapter({
      bindingResolver: {
        async resolveBinding(): Promise<ResolvedBinding | null> {
          return {
            binding: { scope: [DISCOVERY_SIGNING_SCOPE], key: { keyid: "key-1", publicKey: "pubkey-key-1", algorithm: "ed25519" } } as never,
            envelopeBytes: new Uint8Array(),
            bindingDigest: `sha256:${"0".repeat(64)}`,
            effectiveStart: "2026-01-01T00:00:00.000Z",
            isGenesis: true,
            revocations: [],
          };
        },
      },
      keyCatalog: { async candidateKeys() { return [{ keyid: "key-1", probeAt: "2026-01-01T00:00:00.000Z" }]; } },
      verifier: acceptAllVerifier,
    });

    const driver = createVerifyDriver({
      trust,
      hwm: createInMemoryHighWaterMarkStore(),
      factsProfiles: { get: () => undefined },
      factsRecompute: { get: () => undefined },
      records: { "fetch": async () => sealJson({ kind: "delivery" }).bytes },
      entries: { "fetch": async () => sealJson(entry).bytes },
      substrate: { async check() { return "present" as const; } },
      now: () => now,
    });

    const head: SourceHead = {
      protocol: "https://spec.jinn.network/record-discovery/v1",
      origin: "did:key:zProjector/marketplace",
      sequence: "0000000000000001",
      entry: entryDigest,
      issuedAt: "2026-07-28T12:00:00.000Z",
      refreshBy: "2026-07-29T12:00:00.000Z",
    };
    const fakeEnvelope = (payloadType: string, bytes: Uint8Array) => ({
      payloadType,
      payload: Buffer.from(bytes).toString("base64"),
      signatures: [{ keyid: "key-1", sig: Buffer.from("any").toString("base64") }],
    });

    const chainOutcome = await driver.verifySource({
      source: { agent: "did:key:zProjector", name: "marketplace" },
      head,
      headSignature: fakeEnvelope("application/vnd.jinn.record-discovery.head.v1+json", sealJson(head).bytes) as never,
      entries: toAsyncIterable([
        { entry, signature: fakeEnvelope("application/vnd.jinn.record-discovery.entry.v1+json", sealJson(entry).bytes) as never },
      ]),
      firstAdoption: true,
    });
    expect(chainOutcome.status).toBe("ok");

    const item: AnnouncedItem = {
      record: { kind: "https://spec.jinn.network/records/delivery/v1", digest: sealJson({ kind: "delivery" }).digest },
      provenance: {
        source: { agent: "did:key:zProjector", name: "marketplace" },
        entry: entryDigest,
        announcementId: "ann-1",
        derivation: { substrateRef: "sha256:cafe" },
      },
    };

    const decisionOutcome = await driver.verifyForDecision(item);
    expect(decisionOutcome.status).toBe("verified");
    if (decisionOutcome.status === "verified") expect(decisionOutcome.derivation).toBe("present");

    const filterOutcome = await driver.verifyForFilter(item);
    expect(filterOutcome.status).toBe("verified");
    if (filterOutcome.status === "verified") expect(filterOutcome.derivation).toBeUndefined();
  });
});
