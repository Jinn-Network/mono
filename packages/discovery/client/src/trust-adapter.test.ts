import { describe, expect, it } from "vitest";
import type { BindingResolver, BindingResolverQuery, ResolvedBinding } from "@jinn-network/trust-core";
import { DISCOVERY_SIGNING_SCOPE, dssePreAuthEncoding, sha256Hex } from "@jinn-network/record-discovery-protocol";

import { createTrustAdapter } from "./trust-adapter.js";
import type { AgentKeyCatalog, AgentKeyCatalogEntry, RawSignatureVerifier } from "./trust-adapter.js";

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

function makeAgentKeyCatalog(byAgent: Record<string, AgentKeyCatalogEntry[]>): AgentKeyCatalog {
  return {
    async candidateKeys(agent: string) {
      return byAgent[agent] ?? [];
    },
  };
}

const fakeVerifier: RawSignatureVerifier = {
  async verify(pae, sig, key) {
    const expected = `${sha256Hex(pae)}:${key.keyid}`;
    return new TextDecoder().decode(sig) === expected;
  },
};

describe("createTrustAdapter (§10.1: wraps trust-core key-binding resolution)", () => {
  it("resolve() returns only keys currently valid at `at`, scoped to DISCOVERY_SIGNING_SCOPE", async () => {
    const resolver = makeFakeBindingResolver([
      { agent: "did:key:zAgentSourceOne", keyid: "key-old", validFrom: "2025-01-01T00:00:00.000Z", validTo: "2026-06-01T00:00:00.000Z", scope: DISCOVERY_SIGNING_SCOPE },
      { agent: "did:key:zAgentSourceOne", keyid: "key-1", validFrom: "2026-06-01T00:00:00.000Z", validTo: null, scope: DISCOVERY_SIGNING_SCOPE },
    ]);
    const catalog = makeAgentKeyCatalog({
      "did:key:zAgentSourceOne": [
        { keyid: "key-old", probeAt: "2025-06-01T00:00:00.000Z" },
        { keyid: "key-1", probeAt: "2026-06-01T00:00:00.000Z" },
      ],
    });
    const adapter = createTrustAdapter({ bindingResolver: resolver, keyCatalog: catalog, verifier: fakeVerifier });

    const resolved = await adapter.keys.resolve("did:key:zAgentSourceOne", new Date("2026-07-28T12:00:00.000Z"));

    expect(resolved.map((k) => k.keyid)).toEqual(["key-1"]);
  });

  it("resolve() excludes a key bound under a foreign scope", async () => {
    const resolver = makeFakeBindingResolver([
      { agent: "did:key:zAgentSourceOne", keyid: "key-1", validFrom: "2026-01-01T00:00:00.000Z", validTo: null, scope: "verdicts" },
    ]);
    const catalog = makeAgentKeyCatalog({ "did:key:zAgentSourceOne": [{ keyid: "key-1", probeAt: "2026-01-01T00:00:00.000Z" }] });
    const adapter = createTrustAdapter({ bindingResolver: resolver, keyCatalog: catalog, verifier: fakeVerifier });

    const resolved = await adapter.keys.resolve("did:key:zAgentSourceOne", new Date("2026-07-28T12:00:00.000Z"));

    expect(resolved).toEqual([]);
  });

  it("everBound() reports true for a key that held the scope, regardless of current validity (its window has since fully elapsed)", async () => {
    const resolver = makeFakeBindingResolver([
      { agent: "did:key:zAgentSourceOne", keyid: "key-old", validFrom: "2025-01-01T00:00:00.000Z", validTo: "2026-06-01T00:00:00.000Z", scope: DISCOVERY_SIGNING_SCOPE },
    ]);
    const catalog = makeAgentKeyCatalog({
      "did:key:zAgentSourceOne": [{ keyid: "key-old", probeAt: "2025-06-01T00:00:00.000Z" }],
    });
    const adapter = createTrustAdapter({ bindingResolver: resolver, keyCatalog: catalog, verifier: fakeVerifier });

    expect(await adapter.keys.everBound("did:key:zAgentSourceOne", "key-old")).toBe(true);
  });

  it("everBound() reports false for a key never bound to the agent under the scope", async () => {
    const resolver = makeFakeBindingResolver([]);
    const catalog = makeAgentKeyCatalog({});
    const adapter = createTrustAdapter({ bindingResolver: resolver, keyCatalog: catalog, verifier: fakeVerifier });

    expect(await adapter.keys.everBound("did:key:zAgentSourceOne", "key-unknown")).toBe(false);
  });

  it("sigs.verify() delegates to the injected raw verifier", async () => {
    const adapter = createTrustAdapter({ bindingResolver: makeFakeBindingResolver([]), keyCatalog: makeAgentKeyCatalog({}), verifier: fakeVerifier });
    const pae = dssePreAuthEncoding("application/vnd.jinn.record-discovery.head.v1+json", new TextEncoder().encode("{}"));
    const key = { keyid: "key-1", publicKey: "pubkey-key-1", algorithm: "ed25519" };
    const sig = new TextEncoder().encode(`${sha256Hex(pae)}:key-1`);

    expect(await adapter.sigs.verify(pae, sig, key)).toBe(true);
    expect(await adapter.sigs.verify(pae, new TextEncoder().encode("wrong"), key)).toBe(false);
  });

  it("fresh.isFresh() reuses the trust layer's freshness semantics: refreshBy strictly after now", () => {
    const adapter = createTrustAdapter({ bindingResolver: makeFakeBindingResolver([]), keyCatalog: makeAgentKeyCatalog({}), verifier: fakeVerifier });

    expect(adapter.fresh.isFresh("2026-07-29T00:00:00.000Z", new Date("2026-07-28T12:00:00.000Z"))).toBe(true);
    expect(adapter.fresh.isFresh("2026-07-28T00:00:00.000Z", new Date("2026-07-28T12:00:00.000Z"))).toBe(false);
  });
});
