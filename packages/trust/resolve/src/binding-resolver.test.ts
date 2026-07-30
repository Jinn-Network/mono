// SPDX-License-Identifier: Apache-2.0

import { TRUST_KEY_BINDING_FORMAT, deriveStrength } from "@jinn-network/trust-core";
import type { AnchorResolver, ChainFactResolver, KeyBinding, Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, it, vi } from "vitest";

import { createBindingResolver } from "./binding-resolver.js";
import type { BindingStore, SealedKeyBindingRecord } from "./binding-resolver.js";

const AGENT = "https://jinn.network/agent/1";
const KEY_A = "did:key:zKeyA";
const KEY_OWNER = "did:key:zKeyOwner";
const DIGEST_A = ("sha256:" + "a".repeat(64)) as Sha256Digest;
const DIGEST_B = ("sha256:" + "b".repeat(64)) as Sha256Digest;
const CEREMONY_DIGEST = ("sha256:" + "c".repeat(64)) as Sha256Digest;
const AGENT_ASSET = "eip155:84532/erc721:0x2222222222222222222222222222222222222222/7";

function accountBinding(overrides: Partial<KeyBinding> = {}): KeyBinding {
  return {
    protocol: TRUST_KEY_BINDING_FORMAT,
    agent: AGENT,
    key: { publicKey: "pk", keyid: KEY_A, algorithm: "secp256k1", didKey: KEY_A },
    voucher: {
      kind: "account",
      did: "did:pkh:eip155:84532:0x1111111111111111111111111111111111111111",
      contractAccount: false,
    },
    relationship: "controls",
    scope: ["bindings"],
    validFrom: "2026-01-01T00:00:00.000Z",
    ceremony: { type: "eoa", digest: CEREMONY_DIGEST },
    strength: deriveStrength("eoa"),
    anchors: [{ digest: DIGEST_A }],
    ...overrides,
  };
}

function record(binding: KeyBinding, digest: Sha256Digest): SealedKeyBindingRecord {
  return { binding, envelopeBytes: new Uint8Array(), bindingDigest: digest };
}

function fakeStore(records: readonly SealedKeyBindingRecord[]): BindingStore {
  return {
    async listBindingsForAgent(agent) {
      return records.filter((entry) => entry.binding.agent === agent);
    },
    async listRevocationsForTargets() {
      return [];
    },
  };
}

function fakeAnchors(observations: Record<string, string>): AnchorResolver {
  return {
    async lookupAnchor(digest) {
      const anchorTime = observations[digest];
      return anchorTime === undefined ? null : { digest, anchorTime };
    },
  };
}

function unusedChainFacts(): ChainFactResolver {
  return {
    ownerOf: vi.fn(async () => {
      throw new Error("ownerOf should not be called in this test");
    }),
    getAgentWalletAtBlock: vi.fn(async () => {
      throw new Error("getAgentWalletAtBlock should not be called in this test");
    }),
  };
}

describe("createBindingResolver", () => {
  it("computes effective start as max(validFrom, anchorTime)", async () => {
    const binding = accountBinding({ validFrom: "2026-03-01T00:00:00.000Z", anchors: [{ digest: DIGEST_A }] });
    const store = fakeStore([record(binding, DIGEST_A)]);
    const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00.000Z" }); // anchored before validFrom
    const resolver = createBindingResolver({ bindings: store, anchors });

    const resolved = await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-06-01T00:00:00.000Z");
    expect(resolved?.effectiveStart).toBe("2026-03-01T00:00:00.000Z"); // validFrom is later, so it wins

    const beforeEffective = await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-02-01T00:00:00.000Z");
    expect(beforeEffective).toBeNull();
  });

  it("does not resolve an unanchored binding under an anchor-requiring profile", async () => {
    const binding = accountBinding({ anchors: [{ digest: DIGEST_A }] });
    const store = fakeStore([record(binding, DIGEST_A)]);
    const anchors = fakeAnchors({}); // never anchored
    const resolver = createBindingResolver({ bindings: store, anchors, requireAnchors: true });

    const resolved = await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-06-01T00:00:00.000Z");
    expect(resolved).toBeNull();
  });

  it("resolves an unanchored binding when the profile does not require anchors", async () => {
    const binding = accountBinding({ anchors: [{ digest: DIGEST_A }] });
    const store = fakeStore([record(binding, DIGEST_A)]);
    const anchors = fakeAnchors({});
    const resolver = createBindingResolver({ bindings: store, anchors, requireAnchors: false });

    const resolved = await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-06-01T00:00:00.000Z");
    expect(resolved?.effectiveStart).toBe(binding.validFrom);
  });

  it("resolves conflicting bindings to the earlier-anchored one and surfaces the conflict", async () => {
    const earlier = accountBinding({ validFrom: "2026-01-01T00:00:00.000Z", anchors: [{ digest: DIGEST_A }] });
    const later = accountBinding({ validFrom: "2026-01-01T00:00:00.000Z", anchors: [{ digest: DIGEST_B }] });
    const store = fakeStore([record(earlier, DIGEST_A), record(later, DIGEST_B)]);
    const anchors = fakeAnchors({
      [DIGEST_A]: "2026-01-02T00:00:00.000Z",
      [DIGEST_B]: "2026-01-05T00:00:00.000Z",
    });
    const onConflict = vi.fn();
    const resolver = createBindingResolver({ bindings: store, anchors, onConflict });

    const resolved = await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-06-01T00:00:00.000Z");
    expect(resolved?.bindingDigest).toBe(DIGEST_A); // earlier-anchored wins
    expect(onConflict).toHaveBeenCalledWith({
      key: KEY_A,
      agent: AGENT,
      atTime: "2026-06-01T00:00:00.000Z",
      digests: [DIGEST_A, DIGEST_B],
      resolvedDigest: DIGEST_A,
    });
  });

  it("does not resolve an agentId binding without a valid account-ceremony composition leg", async () => {
    const agentIdBinding = accountBinding({
      voucher: { kind: "agentId", caip19: AGENT_ASSET },
      anchors: [{ digest: DIGEST_A }],
    });
    const store = fakeStore([record(agentIdBinding, DIGEST_A)]);
    const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00.000Z" });
    const chainFacts: ChainFactResolver = {
      ownerOf: vi.fn(async () => "0x3333333333333333333333333333333333333333"),
      getAgentWalletAtBlock: vi.fn(async () => {
        throw new Error("not used in this test");
      }),
    };
    const resolver = createBindingResolver({ bindings: store, anchors, chainFacts });

    const resolved = await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-06-01T00:00:00.000Z");
    expect(resolved).toBeNull();
  });

  it("does not resolve an agentId binding when no chainFacts resolver is configured", async () => {
    const agentIdBinding = accountBinding({
      voucher: { kind: "agentId", caip19: AGENT_ASSET },
      anchors: [{ digest: DIGEST_A }],
    });
    const store = fakeStore([record(agentIdBinding, DIGEST_A)]);
    const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00.000Z" });
    const resolver = createBindingResolver({ bindings: store, anchors });

    const resolved = await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-06-01T00:00:00.000Z");
    expect(resolved).toBeNull();
  });

  it("resolves an agentId binding when the registry owner holds a valid account-ceremony binding to the same IRI", async () => {
    const ownerAddress = "0x3333333333333333333333333333333333333333";
    const ownerDid = "did:pkh:eip155:84532:0x3333333333333333333333333333333333333333";
    const accountLeg = accountBinding({
      key: { publicKey: "pk2", keyid: KEY_OWNER, algorithm: "secp256k1", didKey: KEY_OWNER },
      voucher: { kind: "account", did: ownerDid, contractAccount: false },
      anchors: [{ digest: DIGEST_B }],
    });
    const agentIdBinding = accountBinding({
      voucher: { kind: "agentId", caip19: AGENT_ASSET },
      anchors: [{ digest: DIGEST_A }],
    });
    const store = fakeStore([record(agentIdBinding, DIGEST_A), record(accountLeg, DIGEST_B)]);
    const anchors = fakeAnchors({
      [DIGEST_A]: "2026-01-01T00:00:00.000Z",
      [DIGEST_B]: "2026-01-01T00:00:00.000Z",
    });
    const chainFacts: ChainFactResolver = {
      ownerOf: vi.fn(async () => ownerAddress),
      getAgentWalletAtBlock: vi.fn(async () => {
        throw new Error("not used in this test");
      }),
    };
    const resolver = createBindingResolver({ bindings: store, anchors, chainFacts });

    const resolved = await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-06-01T00:00:00.000Z");
    expect(resolved?.bindingDigest).toBe(DIGEST_A);
  });

  it("reports isGenesis for the sole binding of an Agent IRI", async () => {
    const binding = accountBinding({ anchors: [{ digest: DIGEST_A }] });
    const store = fakeStore([record(binding, DIGEST_A)]);
    const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00.000Z" });
    const resolver = createBindingResolver({ bindings: store, anchors, chainFacts: unusedChainFacts() });

    const resolved = await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-06-01T00:00:00.000Z");
    expect(resolved?.isGenesis).toBe(true);
  });
});
