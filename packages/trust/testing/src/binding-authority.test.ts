// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  TRUST_KEY_BINDING_MEDIA_TYPE,
  sealDsseEnvelope,
  verifyEnvelopeBinding,
} from "@jinn-network/trust-core";
import type { Scope, Sha256Digest } from "@jinn-network/trust-core";
import { createAnchorResolver, createBindingResolver } from "@jinn-network/trust-resolve";
import type {
  BindingStore,
  SealedKeyBindingRecord,
  SealedRevocationRecord,
} from "@jinn-network/trust-resolve";

import { createEoaTestSigner } from "./crypto.js";
import type { EoaTestSigner } from "./crypto.js";
import { createFakeResolvers } from "./fakes.js";
import {
  accountVoucher,
  buildKeyBindingFixture,
  buildRevocationFixture,
  testAgentIri,
  testDidKey,
  testSha256Digest,
} from "./fixtures.js";

// ---------------------------------------------------------------------------
// §7.4a/§7.4b, end to end over the real resolver and the real procedure: a
// binding that gives authority (an incumbent, a consenter, a revoker) must
// itself stand, and the verdict is a function of the set of records, never
// of the order a store returns them in. Every verdict below is taken over
// every ordering of the records and must come out the same.
//
// Ceremonies are genuine EOA ceremonies. The DSSE leg is the kit's fake
// (`fakes.ts`), so these cases are about authority, not signature bytes.
// ---------------------------------------------------------------------------

const FAMILY = "verdicts";
const AGENT = testAgentIri("binding-authority");

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";
const T2 = "2026-03-01T00:00:00.000Z";
const T3 = "2026-04-01T00:00:00.000Z";
const T4 = "2026-05-01T00:00:00.000Z";
const NOW = "2026-06-01T00:00:00.000Z";

const OWNER = createEoaTestSigner("binding-authority-owner");
const SECOND_OWNER = createEoaTestSigner("binding-authority-second-owner");
const STRANGER = createEoaTestSigner("binding-authority-stranger");

const GENESIS_KEY = testDidKey("binding-authority-genesis-key");
const NEXT_KEY = testDidKey("binding-authority-next-key");
const THIRD_KEY = testDidKey("binding-authority-third-key");
const COLD_KEY = testDidKey("binding-authority-cold-key");
const STRANGER_KEY = testDidKey("binding-authority-stranger-key");
const STRANGER_SECOND_KEY = testDidKey("binding-authority-stranger-second-key");

interface BindOptions {
  readonly key: string;
  readonly signer: EoaTestSigner;
  readonly validFrom: string;
  /** When the anchor lands; defaults to `validFrom`, the §6 law 2 honest case. */
  readonly anchoredAt?: string;
  readonly expiresAt?: string;
  readonly scope?: readonly Scope[];
  readonly consentBy?: string;
  /** Drops the ceremony evidence from the record, so its ceremony cannot verify. */
  readonly withoutCeremonyEvidence?: boolean;
}

class World {
  readonly records: SealedKeyBindingRecord[] = [];
  readonly revocations: SealedRevocationRecord[] = [];
  readonly anchors = new Map<Sha256Digest, string>();
  lookups = 0;

  constructor(readonly requireAnchors: boolean) {}

  private anchor(label: string, at: string | undefined): Sha256Digest | undefined {
    if (!this.requireAnchors || at === undefined) return undefined;
    const digest = testSha256Digest(`binding-authority-anchor-${label}-${this.anchors.size}`);
    this.anchors.set(digest, at);
    return digest;
  }

  async bind(options: BindOptions): Promise<SealedKeyBindingRecord> {
    const anchorDigest = this.anchor(options.key, options.anchoredAt ?? options.validFrom);
    const fixture = await buildKeyBindingFixture({
      agent: AGENT,
      workingKeyDidKey: options.key,
      ceremonyType: "eoa",
      voucher: accountVoucher(84532, options.signer.address),
      eoaCeremony: { signer: options.signer, chainId: 84532 },
      validFrom: options.validFrom,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      scope: options.scope ?? ["verdicts", "bindings"],
      ...(options.consentBy === undefined
        ? {}
        : { consent: { keyid: options.consentBy, sig: btoa("kit-dsse-checks-the-declared-keyid") } }),
      ...(anchorDigest === undefined ? {} : { anchorDigest }),
    });
    const record: SealedKeyBindingRecord = {
      binding: fixture.binding,
      envelopeBytes: fixture.envelopeBytes,
      bindingDigest: fixture.bindingDigest,
      ...(options.withoutCeremonyEvidence === true || fixture.ceremonyEvidence === undefined
        ? {}
        : { ceremonyEvidence: fixture.ceremonyEvidence }),
    };
    this.records.push(record);
    return record;
  }

  /** Revocations only ever take effect once anchored (§7.4b), so these always carry one. */
  async revoke(target: SealedKeyBindingRecord, revokedBy: string, at: string): Promise<void> {
    const anchorDigest = testSha256Digest(`binding-authority-revocation-${this.revocations.length}`);
    this.anchors.set(anchorDigest, at);
    const fixture = await buildRevocationFixture({ target: target.bindingDigest, revokedBy, effectiveFrom: at, anchorDigest });
    this.revocations.push({ revocation: fixture.revocation, envelopeBytes: fixture.envelopeBytes });
  }

  private storeOver(records: readonly SealedKeyBindingRecord[]): BindingStore {
    const revocations = [...this.revocations].reverse();
    return {
      listBindingsForAgent: async (agent) => {
        this.lookups += 1;
        return records.filter(({ binding }) => binding.agent === agent);
      },
      listRevocationsForTargets: async (targets) =>
        revocations.filter(({ revocation }) => targets.includes(revocation.target as Sha256Digest)),
    };
  }

  private async verifyOver(records: readonly SealedKeyBindingRecord[], key: string, atTime: string) {
    const fakes = createFakeResolvers();
    const bindingResolver = createBindingResolver({
      bindings: this.storeOver(records),
      anchors: createAnchorResolver({
        client: {
          lookupAnchor: async (digest) => {
            const anchorTime = this.anchors.get(digest);
            return anchorTime === undefined ? null : { digest, anchorTime };
          },
        },
      }),
      requireAnchors: this.requireAnchors,
    });
    const envelopeBytes = sealDsseEnvelope({
      payloadBytes: new TextEncoder().encode("{}"),
      payloadType: TRUST_KEY_BINDING_MEDIA_TYPE,
      signatures: [{ signature: Uint8Array.of(1), keyid: key }],
    });
    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key, agent: AGENT, family: FAMILY, atTime },
      {
        bindingResolver,
        witnessVerifier: fakes.witnessVerifier,
        dsseVerifier: fakes.dsseVerifier,
      },
    );
    return { ok: outcome.ok, reason: outcome.reason, detail: outcome.detail };
  }

  /** The verdict for evidence by `key`, required to be identical in every stored order. */
  async verdict(key: string, atTime: string = NOW) {
    const [first, ...rest] = permutations(this.records).map((records) => this.verifyOver(records, key, atTime));
    const reference = await first!;
    for (const pending of rest) {
      // eslint-disable-next-line no-await-in-loop -- comparing settled verdicts in turn.
      expect(await pending).toEqual(reference);
    }
    return reference;
  }

  /** One stored order only, for the cases too large to permute. */
  verdictInStoredOrder(key: string, atTime: string = NOW) {
    return this.verifyOver(this.records, key, atTime);
  }
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

const stands = { ok: true };
const refusedChain = { ok: false, reason: "consent-chain-violation" };

async function bindGenesis(world: World, extra: Partial<BindOptions> = {}) {
  return world.bind({ key: GENESIS_KEY, signer: OWNER, validFrom: T0, ...extra });
}

describe.each([
  { profile: "anchor-requiring", requireAnchors: true },
  { profile: "anchors not required", requireAnchors: false },
])("§7.4a binding authority ($profile)", ({ requireAnchors }) => {
  function world() {
    return new World(requireAnchors);
  }

  describe("what stands", () => {
    test("the genesis binding stands alone", async () => {
      const w = world();
      await bindGenesis(w);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject(stands);
    });

    test("the voucher of a standing controls binding extends it to a new key", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
    });

    test("a standing bindings-scoped key consents a new account", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: GENESIS_KEY });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
    });

    test("a consented account extends its own binding, whichever voucher a store lists first", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: GENESIS_KEY });
      await w.bind({ key: THIRD_KEY, signer: SECOND_OWNER, validFrom: T2 });
      expect(await w.verdict(THIRD_KEY)).toMatchObject(stands);
    });

    test("a batch sealed at one instant by one account stands (the same-session ceremony)", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T0 });
      await w.bind({ key: THIRD_KEY, signer: OWNER, validFrom: T0 });
      expect(await w.verdict(GENESIS_KEY)).toMatchObject(stands);
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
      expect(await w.verdict(THIRD_KEY)).toMatchObject(stands);
    });

    test("authority is judged when it was exercised: a consenter that expires later takes nothing with it", async () => {
      const w = world();
      await bindGenesis(w, { expiresAt: T2 });
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: GENESIS_KEY });
      expect(await w.verdict(NEXT_KEY, NOW)).toMatchObject(stands);
    });

    test("revocation is not retroactive: a later revocation of the authority leaves its successors standing", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1 });
      await w.bind({ key: THIRD_KEY, signer: SECOND_OWNER, validFrom: T2, consentBy: GENESIS_KEY });
      await w.revoke(genesis, GENESIS_KEY, T3);
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
      expect(await w.verdict(THIRD_KEY)).toMatchObject(stands);
    });
  });

  describe("an authority that does not stand gives nothing", () => {
    test("a consenter with no chain of its own", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1, scope: ["bindings"] });
      await w.bind({ key: STRANGER_SECOND_KEY, signer: STRANGER, validFrom: T2, consentBy: STRANGER_KEY });
      expect(await w.verdict(STRANGER_SECOND_KEY)).toMatchObject(refusedChain);
    });

    test("a binding countersigning itself", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1, consentBy: STRANGER_KEY });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
    });

    test("two bindings countersigning each other", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1, consentBy: STRANGER_SECOND_KEY });
      await w.bind({ key: STRANGER_SECOND_KEY, signer: STRANGER, validFrom: T1, consentBy: STRANGER_KEY });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
      expect(await w.verdict(STRANGER_SECOND_KEY)).toMatchObject(refusedChain);
    });

    test("a consenter whose own ceremony cannot be verified", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1, withoutCeremonyEvidence: true });
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T2, consentBy: COLD_KEY });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(refusedChain);
    });

    test("a consenter revoked before the binding it consents", async () => {
      const w = world();
      await bindGenesis(w);
      const cold = await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(cold, GENESIS_KEY, T2);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T3, consentBy: COLD_KEY });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
    });

    test("a consenter that had expired before the binding it consents", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1, expiresAt: T2 });
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T3, consentBy: COLD_KEY });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
    });

    test("an incumbent with no chain of its own, whichever record a store lists first", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1 });
      await w.bind({ key: STRANGER_SECOND_KEY, signer: STRANGER, validFrom: T2 });
      expect(await w.verdict(STRANGER_SECOND_KEY)).toMatchObject(refusedChain);
    });

    test("an incumbent sealed at the same instant, whichever record a store lists first", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1 });
      await w.bind({ key: STRANGER_SECOND_KEY, signer: STRANGER, validFrom: T1 });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
      expect(await w.verdict(STRANGER_SECOND_KEY)).toMatchObject(refusedChain);
    });

    test("an incumbent revoked before the new binding", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.revoke(genesis, GENESIS_KEY, T1);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(refusedChain);
    });

    test("an incumbent that had expired before the new binding", async () => {
      const w = world();
      await bindGenesis(w, { expiresAt: T1 });
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(refusedChain);
    });

    test("a peer that lost the conflict over its key is not an incumbent for its voucher", async () => {
      const w = world();
      await bindGenesis(w);
      // Claims the genesis key for another voucher. The earlier binding wins the key, so this
      // record never holds it, and what resolves for that key is not this voucher's.
      await w.bind({ key: GENESIS_KEY, signer: STRANGER, validFrom: T1 });
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T2 });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
    });
  });

  describe("revocation (§7.4b)", () => {
    test("a revocation by a key that does not itself stand does not take effect", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1, scope: ["bindings"] });
      await w.revoke(genesis, STRANGER_KEY, T2);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject(stands);
    });

    test("a revocation by a key that was itself revoked first does not take effect", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      const cold = await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(cold, GENESIS_KEY, T2);
      await w.revoke(genesis, COLD_KEY, T3);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject(stands);
      expect(await w.verdict(COLD_KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });

    test("a key may revoke its own binding", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.revoke(genesis, GENESIS_KEY, T1);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject({ ok: false, reason: "revoked" });
      expect(await w.verdict(GENESIS_KEY, T0)).toMatchObject(stands);
    });

    test("a successor may revoke the binding whose authority it descends from", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(genesis, COLD_KEY, T2);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject({ ok: false, reason: "revoked" });
      expect(await w.verdict(COLD_KEY)).toMatchObject(stands);
    });

    test("a revocation signed at the same instant as the revoker's own takes effect both ways", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      const cold = await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(genesis, COLD_KEY, T2);
      await w.revoke(cold, GENESIS_KEY, T2);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject({ ok: false, reason: "revoked" });
      expect(await w.verdict(COLD_KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });

    test("the order a store lists revocations in does not change which one is reported", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(genesis, COLD_KEY, T3);
      await w.revoke(genesis, NEXT_KEY, T2);
      const forward = await w.verdictInStoredOrder(GENESIS_KEY);
      w.revocations.reverse();
      expect(await w.verdictInStoredOrder(GENESIS_KEY)).toEqual(forward);
      expect(forward.detail).toContain(NEXT_KEY);
    });
  });

  test("the work of walking authority stays polynomial in the records of a hostile store", async () => {
    const w = world();
    await bindGenesis(w);
    const keys = Array.from({ length: 24 }, (_, index) => testDidKey(`binding-authority-fan-${index}`));
    for (const [index, key] of keys.entries()) {
      // eslint-disable-next-line no-await-in-loop -- fixtures build in order.
      await w.bind({ key, signer: STRANGER, validFrom: new Date(Date.parse(T1) + index * 1000).toISOString() });
    }
    expect(await w.verdictInStoredOrder(keys.at(-1)!)).toMatchObject(refusedChain);
    expect(w.lookups).toBeLessThan(keys.length * keys.length);
  });
});

describe("§7.4a binding authority, anchored time (§7.3)", () => {
  test("a back-dated validFrom does not reach back to an authority that had ended by its anchor", async () => {
    const w = new World(true);
    await bindGenesis(w, { expiresAt: T1 });
    await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T0, anchoredAt: T2 });
    expect(await w.verdict(NEXT_KEY)).toMatchObject(refusedChain);
  });

  test("a back-dated validFrom does not outrun the revocation of the key that consents it", async () => {
    const w = new World(true);
    await bindGenesis(w);
    const cold = await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
    await w.revoke(cold, GENESIS_KEY, T3);
    await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T2, anchoredAt: T4, consentBy: COLD_KEY });
    expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
  });
});
