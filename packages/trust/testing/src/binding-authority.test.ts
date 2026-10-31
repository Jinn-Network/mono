// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  TRUST_KEY_BINDING_MEDIA_TYPE,
  checkBindingRevocation,
  resolveBindingForAgent,
  sealDsseEnvelope,
  settlementJoinCheck,
  verifyEnvelopeBinding,
} from "@jinn-network/trust-core";
import type {
  BindingAuthorityDeps,
  CeremonyType,
  EoaCeremonyEvidence,
  Relationship,
  Scope,
  Sha256Digest,
} from "@jinn-network/trust-core";
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
  /** A countersignature that does not decode. */
  readonly consentSig?: string;
  readonly relationship?: Relationship;
  /** A ceremony other than a genuine EOA one, which this package cannot check by itself. */
  readonly ceremonyType?: Exclude<CeremonyType, "eoa">;
  /** Drops the ceremony evidence from the record, so its ceremony cannot verify. */
  readonly withoutCeremonyEvidence?: boolean;
  /** Replaces the genuine evidence the record would hold. */
  readonly evidence?: (genuine: EoaCeremonyEvidence) => unknown;
}

class World {
  readonly records: SealedKeyBindingRecord[] = [];
  readonly revocations: SealedRevocationRecord[] = [];
  readonly anchors = new Map<Sha256Digest, string>();
  lookups = 0;

  constructor(
    readonly requireAnchors: boolean,
    private readonly verifyHostedCeremony?: () => Promise<boolean>,
    private readonly recordSignedByItsKey?: (record: SealedKeyBindingRecord) => boolean,
  ) {}

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
      ceremonyType: options.ceremonyType ?? "eoa",
      voucher: accountVoucher(84532, options.signer.address),
      ...(options.ceremonyType === undefined ? { eoaCeremony: { signer: options.signer, chainId: 84532 } } : {}),
      ...(options.relationship === undefined ? {} : { relationship: options.relationship }),
      validFrom: options.validFrom,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      scope: options.scope ?? ["verdicts", "bindings"],
      ...(options.consentBy === undefined
        ? {}
        : { consent: { keyid: options.consentBy, sig: options.consentSig ?? btoa("kit-dsse-checks-the-declared-keyid") } }),
      ...(anchorDigest === undefined ? {} : { anchorDigest }),
    });
    const record: SealedKeyBindingRecord = {
      binding: fixture.binding,
      envelopeBytes: fixture.envelopeBytes,
      bindingDigest: fixture.bindingDigest,
      ...(options.withoutCeremonyEvidence === true || fixture.ceremonyEvidence === undefined
        ? {}
        : { ceremonyEvidence: fixture.ceremonyEvidence }),
      ...(options.evidence === undefined || fixture.ceremonyEvidence === undefined
        ? {}
        : { ceremonyEvidence: options.evidence(fixture.ceremonyEvidence) as EoaCeremonyEvidence }),
    };
    this.records.push(record);
    return record;
  }

  /** Revocations only ever take effect once anchored (§7.4b), so these always carry one. */
  async revoke(target: SealedKeyBindingRecord, revokedBy: string, at: string, effectiveFrom: string = at): Promise<void> {
    const anchorDigest = testSha256Digest(`binding-authority-revocation-${this.revocations.length}`);
    this.anchors.set(anchorDigest, at);
    const fixture = await buildRevocationFixture({ target: target.bindingDigest, revokedBy, effectiveFrom, anchorDigest });
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

  private authorityOver(records: readonly SealedKeyBindingRecord[]): BindingAuthorityDeps {
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
      ...(this.verifyHostedCeremony === undefined ? {} : { verifyHostedCeremony: this.verifyHostedCeremony }),
      recordSignedByItsKey: this.recordSignedByItsKey
        ?? ((record) => fakes.dsseVerifier(record.envelopeBytes).validSignerKeyids.includes(record.binding.key.didKey)),
    });
    return { bindingResolver, witnessVerifier: fakes.witnessVerifier, dsseVerifier: fakes.dsseVerifier };
  }

  private async verifyOver(records: readonly SealedKeyBindingRecord[], key: string, atTime: string) {
    const envelopeBytes = sealDsseEnvelope({
      payloadBytes: new TextEncoder().encode("{}"),
      payloadType: TRUST_KEY_BINDING_MEDIA_TYPE,
      signatures: [{ signature: Uint8Array.of(1), keyid: key }],
    });
    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key, agent: AGENT, family: FAMILY, atTime },
      this.authorityOver(records),
    );
    return { ok: outcome.ok, reason: outcome.reason, detail: outcome.detail };
  }

  /** Takes `read` over every stored order, and requires one answer. */
  private async inEveryOrder<Answer>(read: (records: readonly SealedKeyBindingRecord[]) => Promise<Answer>): Promise<Answer> {
    const [first, ...rest] = permutations(this.records).map(read);
    const reference = await first!;
    for (const pending of rest) {
      // eslint-disable-next-line no-await-in-loop -- comparing settled answers in turn.
      expect(await pending).toEqual(reference);
    }
    return reference;
  }

  /** §7.5a over the real resolver. */
  join(verdictKey: string, settlementKey: string, envelopeEffectiveTime: string, claimTime: string) {
    return this.inEveryOrder((records) => settlementJoinCheck(
      {
        verdictKey,
        settlementDeclarationKey: settlementKey,
        claimedEvaluatorAgent: AGENT,
        family: FAMILY,
        envelopeEffectiveTime,
        claimTime,
      },
      this.authorityOver(records),
    ));
  }

  /** §7.4b's rule on its own, over what the real resolver lists for `key` at `atTime`. */
  notRevoked(key: string, atTime: string) {
    return this.inEveryOrder(async (records) => {
      const deps = this.authorityOver(records);
      const resolved = await resolveBindingForAgent(deps.bindingResolver, { key, agent: AGENT }, atTime);
      return (await checkBindingRevocation(resolved!, atTime, deps)).ok;
    });
  }

  /** The verdict for evidence by `key`, required to be identical in every stored order. */
  verdict(key: string, atTime: string = NOW) {
    return this.inEveryOrder((records) => this.verifyOver(records, key, atTime));
  }

  /** One stored order only, for the cases too large to permute. */
  verdictInStoredOrder(key: string, atTime: string = NOW) {
    return this.verifyOver(this.records, key, atTime);
  }
}

/** Mints with a fresh key until the record's digest sorts the wanted side of `than`'s. */
async function bindSorted(
  world: World,
  options: Omit<BindOptions, "key">,
  sortsBefore: boolean,
  than: SealedKeyBindingRecord,
): Promise<{ readonly key: string; readonly record: SealedKeyBindingRecord }> {
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    const key = testDidKey(`binding-authority-sorted-${attempt}`);
    // eslint-disable-next-line no-await-in-loop -- minting until the digest lands.
    const record = await world.bind({ ...options, key });
    if ((record.bindingDigest < than.bindingDigest) === sortsBefore) return { key, record };
    world.records.pop();
  }
  throw new Error("no digest landed on the wanted side");
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

/** A time the record schema admits and the calendar-strict comparison cannot read: no seconds. */
const UNREADABLE_TIME = "2026-02-01T00:00Z";

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

    test.each([
      { order: "before", sortsBefore: true },
      { order: "after", sortsBefore: false },
    ])("a binding consented by a key sealed at the same instant stands, its digest sorting $order the consenter's", async ({ sortsBefore }) => {
      const w = world();
      await bindGenesis(w);
      const consenter = await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      const { key } = await bindSorted(w, { signer: SECOND_OWNER, validFrom: T1, consentBy: COLD_KEY }, sortsBefore, consenter);
      expect(await w.verdict(key)).toMatchObject(stands);
    });

    test("authority can run through several bindings sealed at one instant", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: COLD_KEY });
      await w.bind({ key: THIRD_KEY, signer: STRANGER, validFrom: T1, consentBy: NEXT_KEY });
      expect(await w.verdict(THIRD_KEY)).toMatchObject(stands);
    });

    test("a one-account batch at the founding instant stands, a delegate's digest sorting first", async () => {
      const w = world();
      const one = await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T0 });
      const other = await w.bind({ key: THIRD_KEY, signer: OWNER, validFrom: T0 });
      const first = one.bindingDigest < other.bindingDigest ? one : other;
      const { key } = await bindSorted(w, { signer: OWNER, validFrom: T0, relationship: "signs-for" }, true, first);
      expect(await w.verdict(key)).toMatchObject(stands);
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
      expect(await w.verdict(THIRD_KEY)).toMatchObject(stands);
    });

    test.each([
      { order: "before", sortsBefore: true },
      { order: "after", sortsBefore: false },
    ])("a binding consented by the genesis key at the founding instant stands, its digest sorting $order the genesis", async ({ sortsBefore }) => {
      const w = world();
      const genesis = await bindGenesis(w);
      const { key } = await bindSorted(w, { signer: SECOND_OWNER, validFrom: T0, consentBy: GENESIS_KEY }, sortsBefore, genesis);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject(stands);
      expect(await w.verdict(key)).toMatchObject(stands);
    });

    test("an incumbent that expires at the instant the new binding takes effect still authorizes it", async () => {
      const w = world();
      await bindGenesis(w, { expiresAt: T1 });
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
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

    test("a countersignature that does not decode, and an honest key's verification still ends in a verdict", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1, consentBy: GENESIS_KEY, consentSig: "%" });
      await w.revoke(genesis, STRANGER_KEY, T2);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject(stands);
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
    });

    test("a binding read in another's batch keeps its own verdict", async () => {
      const w = world();
      await bindGenesis(w);
      const OTHER = createEoaTestSigner("binding-authority-other");
      await w.bind({ key: COLD_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: GENESIS_KEY });
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1 });
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: STRANGER_KEY });
      const earlier = await w.bind({ key: THIRD_KEY, signer: OTHER, validFrom: T2, consentBy: GENESIS_KEY });
      await w.revoke(earlier, NEXT_KEY, T3);
      await w.bind({ key: STRANGER_SECOND_KEY, signer: OTHER, validFrom: T4, consentBy: STRANGER_KEY });
      expect(await w.verdictInStoredOrder(NEXT_KEY)).toMatchObject(stands);
      expect(await w.verdictInStoredOrder(STRANGER_SECOND_KEY)).toMatchObject(refusedChain);
    });

    test("a consenter sealed at the same instant whose own ceremony cannot be verified", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1, withoutCeremonyEvidence: true });
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: COLD_KEY });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(refusedChain);
    });

    test("a consenter sealed at the same instant and already revoked", async () => {
      const w = world();
      await bindGenesis(w);
      const cold = await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(cold, GENESIS_KEY, "2026-01-15T00:00:00.000Z");
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: COLD_KEY });
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

    test("an incumbent revoked before the new binding, once it is not the founding one", async () => {
      const w = world();
      await bindGenesis(w);
      const consented = await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: GENESIS_KEY });
      await w.revoke(consented, GENESIS_KEY, T2);
      await w.bind({ key: THIRD_KEY, signer: SECOND_OWNER, validFrom: T3 });
      expect(await w.verdict(THIRD_KEY)).toMatchObject(refusedChain);
    });

    test("a founding key revoked before the binding it consents", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.revoke(genesis, GENESIS_KEY, T1);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T2, consentBy: GENESIS_KEY });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
    });

    test("a founding binding the founding account itself revoked", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.revoke(genesis, accountVoucher(84532, OWNER.address).did, T1);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(refusedChain);
    });

    test("an incumbent that had expired before the new binding", async () => {
      const w = world();
      await bindGenesis(w, { expiresAt: T1 });
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(refusedChain);
    });

    test("a consenter whose scope does not cover bindings", async () => {
      const w = world();
      await bindGenesis(w, { scope: ["verdicts"] });
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: GENESIS_KEY });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(refusedChain);
    });

    test("a key held only as operates, whatever else a store says of it", async () => {
      const w = world();
      await bindGenesis(w, { expiresAt: T2 });
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1, relationship: "operates" });
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: new Date(Date.parse(T1) + 1000).toISOString() });
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T3 });
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

  describe("the founding account after a working key's revocation (§7.4b)", () => {
    test("an owner who revokes their only key can recover by minting a new one", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.revoke(genesis, GENESIS_KEY, T1);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      await w.bind({ key: THIRD_KEY, signer: OWNER, validFrom: T3 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
      expect(await w.verdict(THIRD_KEY)).toMatchObject(stands);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });

    test("it recovers after a bindings key has revoked every binding it holds, including that key's own", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      const cold = await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(genesis, COLD_KEY, T2);
      await w.revoke(cold, COLD_KEY, T2);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T3 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
      expect(await w.verdict(COLD_KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });

    test("recovery needs that account: another voucher gains nothing from the revoked binding", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.revoke(genesis, GENESIS_KEY, T1);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T2 });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
    });
  });

  describe("evidence that cannot be read is a failed ceremony (§7.5 step 3)", () => {
    const mangled = [
      { unreadable: "a lone surrogate", evidence: (e: EoaCeremonyEvidence) => ({ ...e, message: { ...e.message, nonce: "a\ud800b" } }) },
      { unreadable: "an unsafe integer", evidence: (e: EoaCeremonyEvidence) => ({ ...e, message: { ...e.message, chainId: 1e21 } }) },
      { unreadable: "no message", evidence: (e: EoaCeremonyEvidence) => ({ ...e, message: undefined }) },
      { unreadable: "resources that are not a list", evidence: (e: EoaCeremonyEvidence) => ({ ...e, message: { ...e.message, resources: 7 } }) },
      { unreadable: "message bytes that are not bytes", evidence: (e: EoaCeremonyEvidence) => ({ ...e, messageBytes: "bytes" }) },
      { unreadable: "no signature", evidence: (e: EoaCeremonyEvidence) => ({ ...e, signature: undefined }) },
      { unreadable: "evidence that is not an object", evidence: () => null },
    ];

    test.each(mangled)("a stranger's record holding $unreadable, and its revocation, change nothing for an honest key", async ({ evidence }) => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, consentBy: GENESIS_KEY });
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T2, evidence });
      await w.revoke(genesis, STRANGER_KEY, T3);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject(stands);
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
      expect(await w.verdict(STRANGER_KEY)).toMatchObject({ ok: false, reason: "ceremony-verification-failed" });
    });

    test.each(mangled)("a record holding $unreadable cannot win a key from one that verifies", async ({ evidence }) => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: STRANGER, validFrom: T1, evidence });
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
    });
  });

  describe("a conflict over one key (§7.1, §7.3)", () => {
    test("a record whose own ceremony fails does not win the key from one whose ceremony verifies", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: STRANGER, validFrom: T1, withoutCeremonyEvidence: true });
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
    });

    test("a record its key never signed does not resolve when the host can tell", async () => {
      const w = new World(requireAnchors, undefined, (record) => record.binding.validFrom !== T1);
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: STRANGER, validFrom: T1 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject({ ok: false, reason: "binding-not-resolved" });
    });

    test("and it does not win the key from one its key signed", async () => {
      const w = new World(requireAnchors, undefined, (record) => record.binding.validFrom !== T1);
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: STRANGER, validFrom: T1 });
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
    });

    test("but it still counts when deciding what came first", async () => {
      const w = new World(requireAnchors, undefined, (record) => record.binding.validFrom !== T0);
      await bindGenesis(w);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1 });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
    });
  });

  describe("a record nothing here can verify (§7.5 step 3)", () => {
    const refused = [
      { ceremony: "safe", ceremonyType: "safe" as const },
      { ceremony: "oidc-machine", ceremonyType: "oidc-machine" as const },
      { ceremony: "github-human", ceremonyType: "github-human" as const },
      { ceremony: "agentId, on an account voucher", ceremonyType: "agentId" as const },
    ];

    test.each(refused)("a later binding cannot found the IRI over an earlier $ceremony record", async ({ ceremonyType }) => {
      const w = world();
      await bindGenesis(w, { ceremonyType });
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1 });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject({ ok: false, reason: "binding-not-resolved" });
    });

    test("nor over one the host's own leg refused", async () => {
      const w = new World(requireAnchors, async () => false);
      await bindGenesis(w, { ceremonyType: "oidc-machine" });
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1 });
      expect(await w.verdict(STRANGER_KEY)).toMatchObject(refusedChain);
    });

    test("and it gives no incumbency to a later binding of its own voucher", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1, ceremonyType: "oidc-machine" });
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1, ceremonyType: "oidc-machine" });
      await w.bind({ key: STRANGER_SECOND_KEY, signer: STRANGER, validFrom: T2 });
      expect(await w.verdict(STRANGER_SECOND_KEY)).toMatchObject(refusedChain);
    });
  });

  describe("revocation (§7.4b)", () => {
    test("a revocation by a key with no binding has no effect, however its time is spelled", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.revoke(genesis, STRANGER_KEY, T1, UNREADABLE_TIME);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      expect(await w.verdict(GENESIS_KEY)).toMatchObject(stands);
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
    });

    test("a revocation by a key that may make one takes effect at its anchor when its stated time cannot be read", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.revoke(genesis, GENESIS_KEY, T1, UNREADABLE_TIME);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject({ ok: false, reason: "revoked" });
      expect(await w.verdict(GENESIS_KEY, T0)).toMatchObject(stands);
    });

    test("a key whose scope does not cover bindings cannot revoke even its own binding", async () => {
      const w = world();
      await bindGenesis(w);
      const own = await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1, scope: ["verdicts"] });
      await w.revoke(own, NEXT_KEY, T2);
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
    });

    test("a standing key whose scope does not cover bindings does not revoke", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1, scope: ["verdicts"] });
      await w.revoke(genesis, COLD_KEY, T2);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject(stands);
    });

    test("an unauthorized revocation does not stop an authorized one being read", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.revoke(genesis, STRANGER_KEY, T1);
      await w.revoke(genesis, GENESIS_KEY, T2);
      expect(await w.verdict(GENESIS_KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });

    test("the order a store lists revocations of one instant in does not change which one is reported", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(genesis, COLD_KEY, T2);
      await w.revoke(genesis, NEXT_KEY, T2);
      const forward = await w.verdictInStoredOrder(GENESIS_KEY);
      w.revocations.reverse();
      expect(await w.verdictInStoredOrder(GENESIS_KEY)).toEqual(forward);
    });

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

  describe("a revocation read outside the §7.5 procedure", () => {
    const BEFORE_ENVELOPE = "2026-02-15T00:00:00.000Z";
    const ENVELOPE = T2;
    const BEFORE_CLAIM = T3;
    const LEG_EXPIRY = "2026-04-15T00:00:00.000Z";
    const REPLACED_AT = "2026-04-10T00:00:00.000Z";
    const CLAIM = T4;
    const AFTER_CLAIM = NOW;
    const joined = { ok: true, agent: AGENT };
    const VOUCHER_ACCOUNT = accountVoucher(84532, OWNER.address).did;

    /** One account's settlement key, bound before the envelope, beside a genesis key that signs verdicts. */
    async function settlementLeg(w: World, extra: Partial<BindOptions> = {}) {
      await bindGenesis(w);
      return w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1, scope: ["settlements"], ...extra });
    }

    function joinOf(w: World) {
      return w.join(GENESIS_KEY, NEXT_KEY, ENVELOPE, CLAIM);
    }

    test("§7.5a joins a settlement leg nothing has revoked", async () => {
      const w = world();
      await settlementLeg(w);
      expect(await joinOf(w)).toEqual(joined);
    });

    test.each([
      { signer: "a standing bindings key", revokedBy: GENESIS_KEY },
      { signer: "its voucher account", revokedBy: VOUCHER_ACCOUNT },
    ])("§7.5a refuses a settlement leg $signer revoked before the claim", async ({ revokedBy }) => {
      const w = world();
      const leg = await settlementLeg(w);
      await w.revoke(leg, revokedBy, BEFORE_CLAIM);
      expect(await joinOf(w)).toMatchObject({ ok: false, reason: expect.stringMatching(/settlement leg is revoked at claim time/) });
    });

    test("§7.5a refuses a settlement leg revoked at the instant of the claim", async () => {
      const w = world();
      const leg = await settlementLeg(w);
      await w.revoke(leg, GENESIS_KEY, CLAIM);
      expect(await joinOf(w)).toMatchObject({ ok: false });
    });

    test("§7.5a refuses a settlement leg revoked before the envelope", async () => {
      const w = world();
      const leg = await settlementLeg(w);
      await w.revoke(leg, GENESIS_KEY, BEFORE_ENVELOPE);
      expect(await joinOf(w)).toMatchObject({ ok: false });
    });

    test("§7.5a takes nothing from a revocation that comes after the claim", async () => {
      const w = world();
      const leg = await settlementLeg(w);
      await w.revoke(leg, GENESIS_KEY, AFTER_CLAIM);
      expect(await joinOf(w)).toEqual(joined);
    });

    test("§7.5a ignores a revocation by a key with no binding, however its time is spelled", async () => {
      const w = world();
      const leg = await settlementLeg(w);
      await w.revoke(leg, STRANGER_KEY, BEFORE_CLAIM);
      await w.revoke(leg, STRANGER_SECOND_KEY, BEFORE_CLAIM, UNREADABLE_TIME);
      expect(await joinOf(w)).toEqual(joined);
    });

    test("§7.5a ignores a revocation by a bindings key that does not stand", async () => {
      const w = world();
      const leg = await settlementLeg(w);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1, scope: ["bindings"] });
      await w.revoke(leg, STRANGER_KEY, BEFORE_CLAIM);
      expect(await joinOf(w)).toEqual(joined);
    });

    test("§7.5a is not escaped by a later binding of the key when the one in force at the envelope was already revoked", async () => {
      const w = world();
      const leg = await settlementLeg(w, { expiresAt: LEG_EXPIRY });
      await w.revoke(leg, GENESIS_KEY, BEFORE_ENVELOPE);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: REPLACED_AT, scope: ["settlements"] });
      expect(await joinOf(w)).toMatchObject({ ok: false, reason: expect.stringMatching(/revoked at the envelope's time/) });
    });

    test("§7.5a is not escaped by a later binding of the key when the one in force at the envelope is revoked by the claim", async () => {
      const w = world();
      const leg = await settlementLeg(w, { expiresAt: LEG_EXPIRY });
      await w.revoke(leg, GENESIS_KEY, BEFORE_CLAIM);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: REPLACED_AT, scope: ["settlements"] });
      expect(await joinOf(w)).toMatchObject({ ok: false, reason: expect.stringMatching(/revoked at claim time/) });
    });

    test("§7.5a joins a later binding of the key when the one before it was not revoked", async () => {
      const w = world();
      await settlementLeg(w, { expiresAt: LEG_EXPIRY });
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: REPLACED_AT, scope: ["settlements"] });
      expect(await joinOf(w)).toEqual(joined);
    });

    test("§7.5a refuses a verdict leg revoked by the envelope's time", async () => {
      const w = world();
      await settlementLeg(w);
      const verdictLeg = await w.bind({ key: THIRD_KEY, signer: OWNER, validFrom: T1, scope: ["verdicts"] });
      await w.revoke(verdictLeg, GENESIS_KEY, BEFORE_ENVELOPE);
      expect(await w.join(THIRD_KEY, NEXT_KEY, ENVELOPE, CLAIM))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/verdict leg is revoked/) });
    });

    test("§7.5a keeps a verdict leg revoked after the envelope: a revocation is never retroactive", async () => {
      const w = world();
      await settlementLeg(w);
      const verdictLeg = await w.bind({ key: THIRD_KEY, signer: OWNER, validFrom: T1, scope: ["verdicts"] });
      await w.revoke(verdictLeg, GENESIS_KEY, BEFORE_CLAIM);
      expect(await w.join(THIRD_KEY, NEXT_KEY, ENVELOPE, CLAIM)).toEqual(joined);
    });

    test("§7.5a refuses a settlement leg with no chain to the genesis", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: STRANGER_KEY, signer: STRANGER, validFrom: T1, scope: ["settlements"] });
      expect(await w.join(GENESIS_KEY, STRANGER_KEY, ENVELOPE, CLAIM))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/settlement leg does not stand/) });
    });

    test("§7.5a refuses a settlement leg whose ceremony does not verify", async () => {
      const w = world();
      await settlementLeg(w, { withoutCeremonyEvidence: true });
      expect(await joinOf(w)).toMatchObject({ ok: false, reason: expect.stringMatching(/settlement leg does not stand/) });
    });

    test("§7.5a joins a settlement leg a standing key consented to another account", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T1, scope: ["settlements"], consentBy: GENESIS_KEY });
      expect(await joinOf(w)).toEqual(joined);
    });

    test("§7.5a joins a settlement leg the founding account bound after a working key revoked its genesis binding", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      await w.bind({ key: COLD_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(genesis, COLD_KEY, BEFORE_ENVELOPE);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: BEFORE_ENVELOPE, anchoredAt: "2026-02-20T00:00:00.000Z", scope: ["settlements"] });
      expect(await w.join(COLD_KEY, NEXT_KEY, ENVELOPE, CLAIM)).toEqual(joined);
    });

    test("checkBindingRevocation counts a revocation from its effective time, and only one with authority", async () => {
      const w = world();
      const genesis = await bindGenesis(w);
      const target = await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(target, STRANGER_KEY, T2);
      await w.revoke(genesis, STRANGER_KEY, T2);
      expect(await w.notRevoked(NEXT_KEY, T3)).toBe(true);
      expect(await w.notRevoked(GENESIS_KEY, T3)).toBe(true);

      await w.revoke(target, GENESIS_KEY, T3);
      expect(await w.notRevoked(NEXT_KEY, T2)).toBe(true);
      expect(await w.notRevoked(NEXT_KEY, T3)).toBe(false);
    });
  });

  describe("a key's standing under a voucher (§7.4b)", () => {
    /** Binds `key` again at `validFrom` until the record's digest sorts before `than`'s, as a tie goes to the lower. */
    async function bindAgainSortingBefore(w: World, key: string, signer: EoaTestSigner, validFrom: string, than: SealedKeyBindingRecord) {
      for (let attempt = 0; attempt < 4096; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- minting until the digest lands.
        const record = await w.bind({ key, signer, validFrom, expiresAt: new Date(Date.parse(NOW) + attempt * 1000).toISOString() });
        if (record.bindingDigest < than.bindingDigest) return record;
        w.records.pop();
      }
      throw new Error("no digest landed on the wanted side");
    }

    test("a replacement that takes the key's tie does not leave a revocation of the original behind", async () => {
      const w = world();
      await bindGenesis(w);
      const original = await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1 });
      await w.revoke(original, GENESIS_KEY, T2);
      await bindAgainSortingBefore(w, NEXT_KEY, OWNER, T1, original);
      expect(await w.verdict(NEXT_KEY)).toMatchObject({ ok: false, reason: "revoked" });
      expect(await w.verdict(NEXT_KEY, T1)).toMatchObject(stands);
    });

    test("revoking the later of two records for a key ends the earlier one too", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1 });
      const later = await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      await w.revoke(later, GENESIS_KEY, T3);
      expect(await w.verdict(NEXT_KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });

    test("a key can give up its standing through any record of it, whichever answered for the key at that instant", async () => {
      const w = world();
      await bindGenesis(w);
      const first = await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1, expiresAt: T3 });
      const second = await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2 });
      await w.revoke(first, GENESIS_KEY, "2026-02-15T00:00:00.000Z");
      await w.revoke(second, NEXT_KEY, "2026-03-15T00:00:00.000Z");
      expect(await w.verdict(NEXT_KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });

    test("a key's record under another voucher, with no standing, does not give up this voucher's", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: STRANGER, validFrom: T1, expiresAt: T4, scope: ["bindings"] });
      const own = await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T2, scope: ["verdicts"] });
      await w.revoke(own, NEXT_KEY, T3);
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
    });

    test("a revocation stays with a voucher: another account's record for the key is not ended by it", async () => {
      const w = world();
      await bindGenesis(w);
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1 });
      const other = await w.bind({ key: NEXT_KEY, signer: SECOND_OWNER, validFrom: T2, consentBy: GENESIS_KEY });
      await w.revoke(other, GENESIS_KEY, T3);
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
    });

    test("a revocation stays with what is in window: the voucher can bind the key again once that record has ended", async () => {
      const w = world();
      await bindGenesis(w);
      const ended = await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T1, expiresAt: T2 });
      await w.revoke(ended, GENESIS_KEY, "2026-02-15T00:00:00.000Z");
      await w.bind({ key: NEXT_KEY, signer: OWNER, validFrom: T3 });
      expect(await w.verdict(NEXT_KEY)).toMatchObject(stands);
    });
  });

  test.each([
    { spread: "one after another", stepMs: 1000 },
    { spread: "all at one instant", stepMs: 0 },
  ])("the work of walking authority stays polynomial in the records of a hostile store, $spread", async ({ stepMs }) => {
    const w = world();
    await bindGenesis(w);
    const keys = Array.from({ length: 24 }, (_, index) => testDidKey(`binding-authority-fan-${index}`));
    for (const [index, key] of keys.entries()) {
      // eslint-disable-next-line no-await-in-loop -- fixtures build in order.
      await w.bind({ key, signer: STRANGER, validFrom: new Date(Date.parse(T1) + index * stepMs).toISOString() });
    }
    expect(await w.verdictInStoredOrder(keys.at(-1)!)).toMatchObject(refusedChain);
    expect(w.lookups).toBeLessThan(2 * keys.length * keys.length);
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
