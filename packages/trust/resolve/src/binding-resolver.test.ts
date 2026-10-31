// SPDX-License-Identifier: Apache-2.0

import {
  TRUST_KEY_BINDING_FORMAT,
  ceremonyEvidenceDigest,
  deriveStrength,
  didPkh,
  serializeCeremonyMessage,
} from "@jinn-network/trust-core";
import type {
  AnchorResolver,
  ChainFactResolver,
  EoaCeremonyEvidence,
  KeyBinding,
  Sha256Digest,
} from "@jinn-network/trust-core";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { createBindingResolver } from "./binding-resolver.js";
import type { BindingStore, CreateBindingResolverOptions, SealedKeyBindingRecord } from "./binding-resolver.js";

const AGENT = "https://spec.jinn.network/agents/1";
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

  it("settles a tie over one (key, agent) by digest, whichever record a store lists first", async () => {
    const first = accountBinding({ anchors: [{ digest: DIGEST_A }] });
    const second = accountBinding({ anchors: [{ digest: DIGEST_B }] });
    const anchors = fakeAnchors({
      [DIGEST_A]: "2026-01-01T00:00:00.000Z",
      [DIGEST_B]: "2026-01-01T00:00:00.000Z",
    });
    const forward = createBindingResolver({ bindings: fakeStore([record(first, DIGEST_A), record(second, DIGEST_B)]), anchors });
    const reversed = createBindingResolver({ bindings: fakeStore([record(second, DIGEST_B), record(first, DIGEST_A)]), anchors });

    const at = "2026-06-01T00:00:00.000Z";
    expect((await forward.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.bindingDigest).toBe(DIGEST_A);
    expect((await reversed.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.bindingDigest).toBe(DIGEST_A);
  });

  describe("a conflict over one key", () => {
    const owner = privateKeyToAccount(`0x${"6".repeat(64)}`);
    const voucher = { kind: "account" as const, did: didPkh(84532, owner.address), contractAccount: false };
    const anchors = fakeAnchors({
      [DIGEST_A]: "2026-01-01T00:00:00.000Z",
      [DIGEST_B]: "2026-02-01T00:00:00.000Z",
    });
    const at = "2026-06-01T00:00:00.000Z";

    async function signedByOwner(): Promise<SealedKeyBindingRecord> {
      const message = {
        domain: "trust.jinn.network",
        address: owner.address,
        uri: "https://trust.jinn.network/ceremony/key-binding",
        version: "1" as const,
        chainId: 84532,
        nonce: "conflict-nonce",
        issuedAt: "2026-02-01T00:00:00.000Z",
        resources: [AGENT, KEY_A],
      };
      const messageBytes = serializeCeremonyMessage("eoa", message);
      const signature = hexToBytes(await owner.signMessage({ message: { raw: messageBytes } }));
      const ceremonyEvidence: EoaCeremonyEvidence = { type: "eoa", message, messageBytes, signature };
      const binding = accountBinding({
        voucher,
        validFrom: "2026-02-01T00:00:00.000Z",
        ceremony: { type: "eoa", digest: ceremonyEvidenceDigest(ceremonyEvidence) },
        anchors: [{ digest: DIGEST_B }],
      });
      return { ...record(binding, DIGEST_B), ceremonyEvidence };
    }

    const unverified = record(accountBinding({ voucher, anchors: [{ digest: DIGEST_A }] }), DIGEST_A);

    it("goes to the record whose ceremony verifies, in any stored order, however early the other", async () => {
      const verified = await signedByOwner();
      for (const stored of [[unverified, verified], [verified, unverified]]) {
        const resolver = createBindingResolver({ bindings: fakeStore(stored), anchors });
        // eslint-disable-next-line no-await-in-loop -- one stored order, then the other.
        expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.bindingDigest).toBe(DIGEST_B);
      }
    });

    it("still resolves a lone record whose ceremony fails, so verification can name the failure", async () => {
      const resolver = createBindingResolver({ bindings: fakeStore([unverified]), anchors });
      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.bindingDigest).toBe(DIGEST_A);
    });

    it("does not resolve a record its key never signed, and gives the key to one it did", async () => {
      const verified = await signedByOwner();
      const earlier = { ...verified, bindingDigest: DIGEST_A, binding: { ...verified.binding, anchors: [{ digest: DIGEST_A }] } };
      const recordSignedByItsKey = vi.fn((candidate: SealedKeyBindingRecord) => candidate.bindingDigest !== DIGEST_A);
      const resolver = createBindingResolver({ bindings: fakeStore([earlier, verified]), anchors, recordSignedByItsKey });
      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.bindingDigest).toBe(DIGEST_B);

      const alone = createBindingResolver({ bindings: fakeStore([earlier]), anchors, recordSignedByItsKey });
      expect(await alone.resolveBinding({ key: KEY_A, agent: AGENT }, at)).toBeNull();
    });

    it("checks a record once however often it is resolved", async () => {
      const verified = await signedByOwner();
      const evidence = verified.ceremonyEvidence!;
      let ceremonyReads = 0;
      const counted: SealedKeyBindingRecord = {
        ...verified,
        ceremonyEvidence: {
          ...evidence,
          get signature() {
            ceremonyReads += 1;
            return evidence.signature;
          },
        },
      };
      const recordSignedByItsKey = vi.fn(() => true);
      const resolver = createBindingResolver({ bindings: fakeStore([counted]), anchors, recordSignedByItsKey });

      await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at);
      const afterFirst = ceremonyReads;
      await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at);
      await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-07-01T00:00:00.000Z");

      expect(afterFirst).toBeGreaterThan(0);
      expect(ceremonyReads).toBe(afterFirst);
      expect(recordSignedByItsKey).toHaveBeenCalledTimes(1);
    });
  });

  it("surfaces every in-window controls peer as an incumbent, in an order the store cannot change", async () => {
    const voucherOf = (address: string) => ({
      kind: "account" as const,
      did: `did:pkh:eip155:84532:${address}`,
      contractAccount: false,
    });
    const keyed = (didKey: string) => ({ publicKey: "pk", keyid: didKey, algorithm: "secp256k1", didKey });
    const genesisVoucher = voucherOf("0x1111111111111111111111111111111111111111");
    const laterVoucher = voucherOf("0x2222222222222222222222222222222222222222");
    const records = [
      record(accountBinding({ voucher: genesisVoucher }), DIGEST_A),
      record(accountBinding({
        key: keyed(KEY_OWNER),
        voucher: laterVoucher,
        validFrom: "2026-02-01T00:00:00.000Z",
      }), DIGEST_B),
      record(accountBinding({
        key: keyed("did:key:zOutOfWindow"),
        voucher: laterVoucher,
        validFrom: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-15T00:00:00.000Z",
      }), ("sha256:" + "d".repeat(64)) as Sha256Digest),
      record(accountBinding({
        key: keyed("did:key:zSignsFor"),
        voucher: laterVoucher,
        relationship: "signs-for",
      }), ("sha256:" + "e".repeat(64)) as Sha256Digest),
      record(accountBinding({
        key: keyed("did:key:zCandidate"),
        voucher: laterVoucher,
        validFrom: "2026-03-01T00:00:00.000Z",
      }), ("sha256:" + "f".repeat(64)) as Sha256Digest),
    ];
    const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00.000Z" });

    for (const stored of [records, [...records].reverse()]) {
      const resolver = createBindingResolver({ bindings: fakeStore(stored), anchors });
      // eslint-disable-next-line no-await-in-loop -- comparing one store order, then the other.
      const resolved = await resolver.resolveBinding({ key: "did:key:zCandidate", agent: AGENT }, "2026-06-01T00:00:00.000Z");
      expect(resolved?.incumbentControls).toEqual([
        { key: KEY_A, voucher: genesisVoucher },
        { key: KEY_OWNER, voucher: laterVoucher },
      ]);
    }
  });

  it("windows incumbents at the candidate's effective start, not the validFrom its minter chose", async () => {
    const incumbent = accountBinding({ expiresAt: "2026-02-01T00:00:00.000Z", anchors: [{ digest: DIGEST_A }] });
    const candidate = accountBinding({
      key: { publicKey: "pk2", keyid: KEY_OWNER, algorithm: "secp256k1", didKey: KEY_OWNER },
      validFrom: "2026-01-15T00:00:00.000Z",
      anchors: [{ digest: DIGEST_B }],
    });
    const store = fakeStore([record(incumbent, DIGEST_A), record(candidate, DIGEST_B)]);
    const anchors = fakeAnchors({
      [DIGEST_A]: "2026-01-01T00:00:00.000Z",
      [DIGEST_B]: "2026-03-01T00:00:00.000Z", // after the incumbent expired
    });
    const resolver = createBindingResolver({ bindings: store, anchors });

    const resolved = await resolver.resolveBinding({ key: KEY_OWNER, agent: AGENT }, "2026-06-01T00:00:00.000Z");
    expect(resolved?.effectiveStart).toBe("2026-03-01T00:00:00.000Z");
    expect(resolved?.incumbentControls).toBeUndefined();
  });

  describe("ceremonies nothing here can verify (§7.5 step 3)", () => {
    const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00.000Z" });
    const at = "2026-06-01T00:00:00.000Z";

    it.each(["safe", "oidc-machine", "github-human"] as const)("does not resolve a %s binding by default", async (type) => {
      const binding = accountBinding({ ceremony: { type, digest: CEREMONY_DIGEST }, strength: deriveStrength(type) });
      const resolver = createBindingResolver({ bindings: fakeStore([record(binding, DIGEST_A)]), anchors });

      expect(await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at)).toBeNull();
    });

    it.each(["safe", "oidc-machine", "github-human"] as const)("resolves a %s binding only on the host's say-so", async (type) => {
      const binding = accountBinding({ ceremony: { type, digest: CEREMONY_DIGEST }, strength: deriveStrength(type) });
      const sealed = record(binding, DIGEST_A);
      const verifyHostedCeremony = vi.fn(async () => true);
      const vouched = createBindingResolver({ bindings: fakeStore([sealed]), anchors, verifyHostedCeremony });
      const refused = createBindingResolver({
        bindings: fakeStore([sealed]),
        anchors,
        verifyHostedCeremony: async () => false,
      });

      expect((await vouched.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.bindingDigest).toBe(DIGEST_A);
      expect(verifyHostedCeremony).toHaveBeenCalledWith(sealed);
      expect(await refused.resolveBinding({ key: KEY_A, agent: AGENT }, at)).toBeNull();
    });

    it("never consults the host for an EOA ceremony, which trust-core verifies itself", async () => {
      const verifyHostedCeremony = vi.fn(async () => false);
      const resolver = createBindingResolver({
        bindings: fakeStore([record(accountBinding(), DIGEST_A)]),
        anchors,
        verifyHostedCeremony,
      });

      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.bindingDigest).toBe(DIGEST_A);
      expect(verifyHostedCeremony).not.toHaveBeenCalled();
    });

    it("does not resolve an agentId ceremony on a voucher its composition leg never examines", async () => {
      const binding = accountBinding({
        ceremony: { type: "agentId", digest: CEREMONY_DIGEST },
        strength: deriveStrength("agentId"),
      });
      const resolver = createBindingResolver({
        bindings: fakeStore([record(binding, DIGEST_A)]),
        anchors,
        chainFacts: unusedChainFacts(),
      });

      expect(await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at)).toBeNull();
    });

    // What this resolver cannot verify it cannot rule out either: the record may be the true
    // genesis, so leaving it out would make the next record the founder of the IRI.
    it.each([
      { ceremony: "safe" as const, label: "safe", options: {} },
      { ceremony: "oidc-machine" as const, label: "oidc-machine", options: {} },
      { ceremony: "github-human" as const, label: "github-human", options: {} },
      { ceremony: "agentId" as const, label: "an agentId ceremony on an account voucher", options: {} },
      {
        ceremony: "oidc-machine" as const,
        label: "a hosted ceremony the host refused",
        options: { verifyHostedCeremony: async () => false },
      },
    ])("counts $label when deciding what came first, and does not resolve it", async ({ ceremony, options }) => {
      const earlier = accountBinding({
        key: { publicKey: "pk2", keyid: KEY_OWNER, algorithm: "secp256k1", didKey: KEY_OWNER },
        ceremony: { type: ceremony, digest: CEREMONY_DIGEST },
        strength: deriveStrength(ceremony),
        anchors: [{ digest: DIGEST_B }],
      });
      const later = accountBinding({ validFrom: "2026-01-02T00:00:00.000Z" });
      const resolver = createBindingResolver({
        bindings: fakeStore([record(later, DIGEST_A), record(earlier, DIGEST_B)]),
        anchors: fakeAnchors({
          [DIGEST_A]: "2026-01-02T00:00:00.000Z",
          [DIGEST_B]: "2026-01-01T00:00:00.000Z",
        }),
        ...options,
      });

      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.isGenesis).toBe(false);
      expect(await resolver.resolveBinding({ key: KEY_OWNER, agent: AGENT }, at)).toBeNull();
    });
  });

  describe("time is compared by instant, not by spelling", () => {
    const at = "2026-06-01T00:00:00.000Z";
    const keyed = (didKey: string) => ({ publicKey: "pk", keyid: didKey, algorithm: "secp256k1", didKey });

    it("reads a fractional second after a whole one", async () => {
      const binding = accountBinding({ validFrom: "2026-01-01T00:00:00.500Z" });
      const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00Z" });
      const resolver = createBindingResolver({ bindings: fakeStore([record(binding, DIGEST_A)]), anchors });

      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.effectiveStart)
        .toBe("2026-01-01T00:00:00.500Z");
    });

    it("takes the earliest anchor of a binding by instant", async () => {
      const binding = accountBinding({
        validFrom: "2026-01-01T00:00:00Z",
        anchors: [{ digest: DIGEST_A }, { digest: DIGEST_B }],
      });
      const anchors = fakeAnchors({
        [DIGEST_A]: "2026-02-01T00:00:00.500Z",
        [DIGEST_B]: "2026-02-01T00:00:00Z",
      });
      const resolver = createBindingResolver({ bindings: fakeStore([record(binding, DIGEST_A)]), anchors });

      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.effectiveStart)
        .toBe("2026-02-01T00:00:00Z");
    });

    it("does not resolve past an expiry spelled without a fraction", async () => {
      const binding = accountBinding({ expiresAt: "2026-02-01T00:00:00Z" });
      const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00.000Z" });
      const resolver = createBindingResolver({ bindings: fakeStore([record(binding, DIGEST_A)]), anchors });

      expect(await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-02-01T00:00:00.500Z")).toBeNull();
    });

    it("opens an effective start spelled with an offset at its instant", async () => {
      const binding = accountBinding({ validFrom: "2026-02-01T00:00:00+01:00" });
      const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00.000Z" });
      const resolver = createBindingResolver({ bindings: fakeStore([record(binding, DIGEST_A)]), anchors });

      expect(await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-01-31T22:30:00Z")).toBeNull();
      expect(await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, "2026-01-31T23:30:00Z")).not.toBeNull();
    });

    it("gives a conflict over one key to the earlier instant", async () => {
      const earlier = accountBinding({ validFrom: "2026-01-01T00:00:00Z", anchors: [{ digest: DIGEST_B }] });
      const later = accountBinding({ validFrom: "2026-01-01T00:00:00.500Z", anchors: [{ digest: DIGEST_A }] });
      const anchors = fakeAnchors({
        [DIGEST_A]: "2026-01-01T00:00:00.500Z",
        [DIGEST_B]: "2026-01-01T00:00:00Z",
      });
      const resolver = createBindingResolver({
        bindings: fakeStore([record(later, DIGEST_A), record(earlier, DIGEST_B)]),
        anchors,
      });

      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.bindingDigest).toBe(DIGEST_B);
    });

    it("founds the IRI on the earlier instant", async () => {
      const founder = accountBinding({
        key: keyed(KEY_OWNER),
        validFrom: "2026-01-01T00:00:00Z",
        anchors: [{ digest: DIGEST_B }],
      });
      const later = accountBinding({ validFrom: "2026-01-01T00:00:00.500Z", anchors: [{ digest: DIGEST_A }] });
      const anchors = fakeAnchors({
        [DIGEST_A]: "2026-01-01T00:00:00.500Z",
        [DIGEST_B]: "2026-01-01T00:00:00Z",
      });
      const resolver = createBindingResolver({
        bindings: fakeStore([record(later, DIGEST_A), record(founder, DIGEST_B)]),
        anchors,
      });

      expect((await resolver.resolveBinding({ key: KEY_OWNER, agent: AGENT }, at))?.isGenesis).toBe(true);
      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.isGenesis).toBe(false);
    });

    it("treats one instant spelled two ways as a tie", async () => {
      const first = accountBinding({ validFrom: "2026-01-01T00:00:00.000Z", anchors: [{ digest: DIGEST_A }] });
      const second = accountBinding({
        key: keyed(KEY_OWNER),
        validFrom: "2026-01-01T01:00:00+01:00",
        anchors: [{ digest: DIGEST_B }],
      });
      const anchors = fakeAnchors({
        [DIGEST_A]: "2026-01-01T00:00:00.000Z",
        [DIGEST_B]: "2026-01-01T00:00:00Z",
      });
      const resolver = createBindingResolver({
        bindings: fakeStore([record(second, DIGEST_B), record(first, DIGEST_A)]),
        anchors,
      });

      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.isGenesis).toBe(true);
      expect((await resolver.resolveBinding({ key: KEY_OWNER, agent: AGENT }, at))?.isGenesis).toBe(false);
    });

    it("orders revocations by instant", async () => {
      const binding = accountBinding();
      const revocation = (effectiveFrom: string, digest: Sha256Digest, marker: number) => ({
        revocation: {
          protocol: "https://spec.jinn.network/trust/revocation/v1",
          target: DIGEST_A,
          revokedBy: KEY_OWNER,
          anchors: [{ digest }],
          effectiveFrom,
        },
        envelopeBytes: Uint8Array.of(marker),
      });
      const store: BindingStore = {
        ...fakeStore([record(binding, DIGEST_A)]),
        async listRevocationsForTargets() {
          return [
            revocation("2026-03-01T00:00:00.500Z", DIGEST_B, 1),
            revocation("2026-03-01T00:00:00Z", CEREMONY_DIGEST, 2),
          ] as never;
        },
      };
      const anchors = fakeAnchors({
        [DIGEST_A]: "2026-01-01T00:00:00.000Z",
        [DIGEST_B]: "2026-02-01T00:00:00.000Z",
        [CEREMONY_DIGEST]: "2026-02-01T00:00:00.000Z",
      });
      const resolver = createBindingResolver({ bindings: store, anchors });

      const resolved = await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at);
      expect(resolved?.revocations.map(({ effectiveTime }) => effectiveTime)).toEqual([
        "2026-03-01T00:00:00Z",
        "2026-03-01T00:00:00.500Z",
      ]);
    });

    it("takes the anchor alone when a stated time cannot be read", async () => {
      const binding = accountBinding({ validFrom: "2026-03-01T00:00Z" });
      const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00.000Z" });
      const resolver = createBindingResolver({ bindings: fakeStore([record(binding, DIGEST_A)]), anchors });

      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.effectiveStart)
        .toBe("2026-01-01T00:00:00.000Z");
    });

    it("places a time it cannot read after every time it can, in any stored order", async () => {
      const unreadable = accountBinding({ key: keyed(KEY_OWNER), validFrom: "2026-01-01T00:00Z", anchors: [] });
      const genuine = accountBinding({ validFrom: "2026-03-01T00:00:00Z", anchors: [] });
      const anchors = fakeAnchors({});
      for (const stored of [
        [record(unreadable, DIGEST_B), record(genuine, DIGEST_A)],
        [record(genuine, DIGEST_A), record(unreadable, DIGEST_B)],
      ]) {
        const resolver = createBindingResolver({ bindings: fakeStore(stored), anchors, requireAnchors: false });
        // eslint-disable-next-line no-await-in-loop -- one stored order, then the other.
        expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.isGenesis).toBe(true);
      }
    });
  });

  describe("a tie at the founding instant", () => {
    const at = "2026-06-01T00:00:00.000Z";
    const keyed = (didKey: string) => ({ publicKey: "pk", keyid: didKey, algorithm: "secp256k1", didKey });
    const anchors = fakeAnchors({ [DIGEST_A]: "2026-01-01T00:00:00.000Z", [DIGEST_B]: "2026-01-01T00:00:00.000Z" });

    it.each([
      { digests: "sorting first", own: DIGEST_A, other: DIGEST_B },
      { digests: "sorting second", own: DIGEST_B, other: DIGEST_A },
    ])("does not go to a record that does not claim control, its digest $digests", async ({ own, other }) => {
      const delegate = accountBinding({ relationship: "signs-for", anchors: [{ digest: own }] });
      const controller = accountBinding({ key: keyed(KEY_OWNER), anchors: [{ digest: other }] });
      const resolver = createBindingResolver({ bindings: fakeStore([record(delegate, own), record(controller, other)]), anchors });

      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.isGenesis).toBe(false);
      expect((await resolver.resolveBinding({ key: KEY_OWNER, agent: AGENT }, at))?.isGenesis).toBe(true);
    });

    it.each([
      { digests: "sorting first", own: DIGEST_A, other: DIGEST_B },
      { digests: "sorting second", own: DIGEST_B, other: DIGEST_A },
    ])("does not go to a record that names its own authority, its digest $digests", async ({ own, other }) => {
      const consented = accountBinding({ consent: { keyid: KEY_OWNER, sig: "c2ln" }, anchors: [{ digest: own }] });
      const founder = accountBinding({ key: keyed(KEY_OWNER), anchors: [{ digest: other }] });
      const resolver = createBindingResolver({ bindings: fakeStore([record(consented, own), record(founder, other)]), anchors });

      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.isGenesis).toBe(false);
      expect((await resolver.resolveBinding({ key: KEY_OWNER, agent: AGENT }, at))?.isGenesis).toBe(true);
    });

    it("goes by digest between records that make the same claim", async () => {
      const first = accountBinding({ anchors: [{ digest: DIGEST_A }] });
      const second = accountBinding({ key: keyed(KEY_OWNER), anchors: [{ digest: DIGEST_B }] });
      const resolver = createBindingResolver({ bindings: fakeStore([record(second, DIGEST_B), record(first, DIGEST_A)]), anchors });

      expect((await resolver.resolveBinding({ key: KEY_A, agent: AGENT }, at))?.isGenesis).toBe(true);
      expect((await resolver.resolveBinding({ key: KEY_OWNER, agent: AGENT }, at))?.isGenesis).toBe(false);
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

  describe("the agentId composition leg's account record (§7.2)", () => {
    const owner = privateKeyToAccount(`0x${"4".repeat(64)}`);
    const stranger = privateKeyToAccount(`0x${"5".repeat(64)}`);
    const ownerVoucher = { kind: "account" as const, did: didPkh(84532, owner.address), contractAccount: false };
    const ownerKey = { publicKey: "pk2", keyid: KEY_OWNER, algorithm: "secp256k1", didKey: KEY_OWNER };
    const anchors = fakeAnchors({
      [DIGEST_A]: "2026-01-01T00:00:00.000Z",
      [DIGEST_B]: "2026-01-01T00:00:00.000Z",
    });
    const chainFacts: ChainFactResolver = {
      ownerOf: vi.fn(async () => owner.address),
      getAgentWalletAtBlock: vi.fn(async () => {
        throw new Error("not used in this test");
      }),
    };
    const agentIdRecord = record(accountBinding({
      voucher: { kind: "agentId", caip19: AGENT_ASSET },
      ceremony: { type: "agentId", digest: CEREMONY_DIGEST },
      strength: deriveStrength("agentId"),
      anchors: [{ digest: DIGEST_A }],
    }), DIGEST_A);

    /** A genuine EIP-191 ceremony over `[AGENT, KEY_OWNER]`, signed by `signer`. */
    async function ceremonyBy(signer: typeof owner): Promise<EoaCeremonyEvidence> {
      const message = {
        domain: "trust.jinn.network",
        address: signer.address,
        uri: "https://trust.jinn.network/ceremony/key-binding",
        version: "1" as const,
        chainId: 84532,
        nonce: "composition-nonce",
        issuedAt: "2026-01-01T00:00:00.000Z",
        resources: [AGENT, KEY_OWNER],
      };
      const messageBytes = serializeCeremonyMessage("eoa", message);
      const signature = hexToBytes(await signer.signMessage({ message: { raw: messageBytes } }));
      return { type: "eoa", message, messageBytes, signature };
    }

    async function accountLeg(overrides: Partial<KeyBinding> = {}, evidenceBy: typeof owner = owner) {
      const ceremonyEvidence = await ceremonyBy(evidenceBy);
      const binding = accountBinding({
        key: ownerKey,
        voucher: ownerVoucher,
        ceremony: { type: "eoa", digest: ceremonyEvidenceDigest(ceremonyEvidence) },
        anchors: [{ digest: DIGEST_B }],
        ...overrides,
      });
      return { ...record(binding, DIGEST_B), ceremonyEvidence };
    }

    const composed = async (leg: SealedKeyBindingRecord, options: Pick<CreateBindingResolverOptions, "verifyHostedCeremony"> = {}) =>
      createBindingResolver({ bindings: fakeStore([agentIdRecord, leg]), anchors, chainFacts, ...options })
        .resolveBinding({ key: KEY_A, agent: AGENT }, "2026-06-01T00:00:00.000Z");

    it("composes with a genuine ceremony of the registry owner", async () => {
      expect((await composed(await accountLeg()))?.bindingDigest).toBe(DIGEST_A);
    });

    it("does not compose with a record that only names the owner", async () => {
      const { ceremonyEvidence: _ceremonyEvidence, ...unsigned } = await accountLeg();
      expect(await composed(unsigned)).toBeNull();
    });

    it("does not compose with evidence the record did not commit to", async () => {
      expect(await composed(await accountLeg({ ceremony: { type: "eoa", digest: CEREMONY_DIGEST } }))).toBeNull();
    });

    it("does not compose with a ceremony someone else signed", async () => {
      expect(await composed(await accountLeg({}, stranger))).toBeNull();
    });

    it("does not compose with a record whose ceremony nothing here verified", async () => {
      const type = "oidc-machine";
      const { ceremonyEvidence: _ceremonyEvidence, ...unverified } = await accountLeg({
        ceremony: { type, digest: CEREMONY_DIGEST },
        strength: deriveStrength(type),
      });
      expect(await composed(unverified, { verifyHostedCeremony: async () => true })).toBeNull();
    });

    it("composes with a Safe's account ceremony only on the host's say-so", async () => {
      const { ceremonyEvidence: _ceremonyEvidence, ...safe } = await accountLeg({
        voucher: { ...ownerVoucher, contractAccount: true },
        ceremony: { type: "safe", digest: CEREMONY_DIGEST },
        strength: deriveStrength("safe"),
      });
      expect(await composed(safe)).toBeNull();
      expect(await composed(safe, { verifyHostedCeremony: async () => false })).toBeNull();
      expect((await composed(safe, { verifyHostedCeremony: async () => true }))?.bindingDigest).toBe(DIGEST_A);
    });
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
