// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { canonicalJsonBytes } from "./canonical-json.js";
import { ceremonyEvidenceDigest } from "./ceremony.js";
import type { EoaCeremonyEvidence } from "./ceremony.js";
import { parseDsseEnvelope, sealDsseEnvelope } from "./dsse.js";
import {
  TRUST_KEY_BINDING_FORMAT,
  TRUST_KEY_BINDING_MEDIA_TYPE,
  TRUST_REVOCATION_FORMAT,
  TRUST_REVOCATION_MEDIA_TYPE,
} from "./identifiers.js";
import type { BindingResolver, ResolvedBinding, ResolvedRevocation, WitnessVerifier } from "./interfaces.js";
import type { KeyBinding } from "./key-binding.js";
import type { DsseChainVerifier } from "./policy.js";
import { didPkh } from "./spellings.js";
import {
  authenticateRequester,
  settlementJoinCheck,
  verifyEnvelopeBinding,
} from "./verify.js";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const eoaFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/ceremony-v1/eoa-siwe.json", import.meta.url)), "utf8"),
) as {
  message: EoaCeremonyEvidence["message"];
  messageBytesHex: string;
  signatureHex: string;
  voucherChainId: number;
  agentIri: string;
  didKey: string;
};

function eoaCeremonyEvidence(): EoaCeremonyEvidence {
  return {
    type: "eoa",
    message: eoaFixture.message,
    messageBytes: hexToBytes(eoaFixture.messageBytesHex),
    signature: hexToBytes(eoaFixture.signatureHex),
  };
}

// ---------------------------------------------------------------------------
// A pass-through DSSE verifier: trusts each envelope's declared `keyid`
// without cryptographic verification (that correctness is ceremony.ts's
// own concern, already covered by ceremony.test.ts). This isolates
// verify.ts's orchestration logic under test, as `describeError`-style unit
// tests do throughout this package.
// ---------------------------------------------------------------------------
const trustingDsseVerifier: DsseChainVerifier = (envelopeBytes) => {
  const parsed = parseDsseEnvelope(envelopeBytes);
  return {
    validSignerKeyids: parsed.signatures
      .map((signature) => signature.keyid)
      .filter((keyid): keyid is string => keyid !== undefined),
  };
};

function sealedEnvelope(payload: unknown, payloadType: string, keyid: string): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes: canonicalJsonBytes(payload),
    payloadType,
    signatures: [{ signature: new Uint8Array([1, 2, 3]), keyid }],
  });
}

const fakeWitnessVerifier: WitnessVerifier = {
  verify1271Witness: async () => ({ verified: true }),
};

interface FakeEntry {
  readonly key: string;
  readonly agent: string;
  readonly resolved: ResolvedBinding;
  readonly validUntil?: string;
}

class FakeBindingResolver implements BindingResolver {
  private readonly entries: FakeEntry[] = [];

  register(entry: FakeEntry): this {
    this.entries.push(entry);
    return this;
  }

  async resolveBinding(
    query: { key: string; agent: string },
    atTime: string,
  ): Promise<ResolvedBinding | null> {
    const entry = this.entries.find((candidate) => candidate.key === query.key && candidate.agent === query.agent);
    if (entry === undefined) return null;
    if (atTime < entry.resolved.effectiveStart) return null;
    if (entry.validUntil !== undefined && atTime > entry.validUntil) return null;
    return entry.resolved;
  }
}

function keyBinding(overrides: Partial<KeyBinding> & Pick<KeyBinding, "agent" | "key" | "voucher">): KeyBinding {
  return {
    protocol: TRUST_KEY_BINDING_FORMAT,
    relationship: "controls",
    scope: ["deliveries"],
    validFrom: "2026-01-01T00:00:00Z",
    ceremony: { type: "oidc-machine", digest: `sha256:${"a".repeat(64)}` },
    strength: "strong",
    anchors: [],
    ...overrides,
  };
}

function resolvedBinding(
  overrides: Partial<ResolvedBinding> & Pick<ResolvedBinding, "binding">,
): ResolvedBinding {
  return {
    envelopeBytes: new TextEncoder().encode("placeholder"),
    bindingDigest: `sha256:${"b".repeat(64)}`,
    effectiveStart: "2026-01-01T00:00:00Z",
    isGenesis: true,
    revocations: [],
    ...overrides,
  };
}

function revocationEntry(revokedBy: string, effectiveTime: string): ResolvedRevocation {
  return {
    revocation: {
      protocol: TRUST_REVOCATION_FORMAT,
      target: `sha256:${"c".repeat(64)}`,
      revokedBy,
      anchors: [],
      effectiveFrom: effectiveTime,
    },
    envelopeBytes: sealedEnvelope(
      {
        protocol: TRUST_REVOCATION_FORMAT,
        target: `sha256:${"c".repeat(64)}`,
        revokedBy,
        anchors: [],
        effectiveFrom: effectiveTime,
      },
      TRUST_REVOCATION_MEDIA_TYPE,
      revokedBy,
    ),
    effectiveTime,
  };
}

const AGENT = "urn:uuid:dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VOUCHER_DID = didPkh(8453, "0x2222222222222222222222222222222222222222");
const OTHER_VOUCHER_DID = didPkh(8453, "0x3333333333333333333333333333333333333333");
const KEY_2 = "did:key:z6MkfKEY22222222222222222222222222222222222";
const CONSENT_KEY = "did:key:z6MkfCONSENT11111111111111111111111111111";

describe("verifyEnvelopeBinding", () => {
  test("(a) a valid envelope with a genuine EOA ceremony, resolved genesis binding, matching scope, and no revocation verifies", async () => {
    const binding = keyBinding({
      agent: eoaFixture.agentIri,
      key: {
        publicKey: "0x04",
        keyid: eoaFixture.didKey,
        algorithm: "secp256k1",
        didKey: eoaFixture.didKey,
      },
      voucher: { kind: "account", did: didPkh(eoaFixture.voucherChainId, eoaFixture.message.address), contractAccount: false },
      ceremony: { type: "eoa", digest: ceremonyEvidenceDigest(eoaCeremonyEvidence()) },
      scope: ["deliveries", "verdicts"],
    });
    const resolver = new FakeBindingResolver().register({
      key: eoaFixture.didKey,
      agent: eoaFixture.agentIri,
      resolved: resolvedBinding({ binding, ceremonyEvidence: eoaCeremonyEvidence() }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, eoaFixture.didKey);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: eoaFixture.didKey, agent: eoaFixture.agentIri, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.resolvedBinding?.binding.agent).toBe(eoaFixture.agentIri);
  });

  test("(major finding) a resolved binding whose committed ceremony.digest does not match the supplied ceremony evidence's digest fails ceremony verification, even though the evidence is genuine and content-matching", async () => {
    const binding = keyBinding({
      agent: eoaFixture.agentIri,
      key: {
        publicKey: "0x04",
        keyid: eoaFixture.didKey,
        algorithm: "secp256k1",
        didKey: eoaFixture.didKey,
      },
      voucher: { kind: "account", did: didPkh(eoaFixture.voucherChainId, eoaFixture.message.address), contractAccount: false },
      // A digest that does NOT correspond to `eoaCeremonyEvidence()` -- the
      // record commits to a DIFFERENT piece of ceremony evidence than what
      // the resolver is about to supply.
      ceremony: { type: "eoa", digest: `sha256:${"f".repeat(64)}` },
      scope: ["deliveries", "verdicts"],
    });
    const resolver = new FakeBindingResolver().register({
      key: eoaFixture.didKey,
      agent: eoaFixture.agentIri,
      resolved: resolvedBinding({ binding, ceremonyEvidence: eoaCeremonyEvidence() }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, eoaFixture.didKey);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: eoaFixture.didKey, agent: eoaFixture.agentIri, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("ceremony-verification-failed");
    expect(outcome.detail).toMatch(/ceremony evidence digest/);
  });

  test("step 1 rejects an envelope with no valid signature from the claimed key", async () => {
    const resolver = new FakeBindingResolver();
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, "did:key:zSomeoneElse");

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("envelope-signature-invalid");
  });

  test("(b) an envelope whose family is not in the binding's scope fails at step 4", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      scope: ["deliveries"],
    });
    const resolver = new FakeBindingResolver().register({
      key: KEY_2,
      agent: AGENT,
      resolved: resolvedBinding({ binding }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "verdicts", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("scope-violation");
  });

  test("(c) a non-genesis binding with neither an incumbent controls voucher nor a bindings-scoped consent countersignature is rejected (§7.4a)", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    });
    const resolver = new FakeBindingResolver().register({
      key: KEY_2,
      agent: AGENT,
      resolved: resolvedBinding({
        binding,
        isGenesis: false,
        incumbentControlVoucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false },
      }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("consent-chain-violation");
  });

  test("self-extension succeeds when the binding's own voucher already holds the incumbent controls binding (§7.4a option 1)", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    });
    const resolver = new FakeBindingResolver().register({
      key: KEY_2,
      agent: AGENT,
      resolved: resolvedBinding({
        binding,
        isGenesis: false,
        incumbentControlVoucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(true);
  });

  test("cross-account consent succeeds when the consenting key currently holds scope:bindings (§7.4a option 2)", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false },
      consent: { keyid: CONSENT_KEY, sig: btoa("irrelevant-in-this-fake") },
    });
    const consentingBinding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      scope: ["bindings"],
    });
    const resolver = new FakeBindingResolver()
      .register({
        key: KEY_2,
        agent: AGENT,
        resolved: resolvedBinding({
          binding,
          isGenesis: false,
          incumbentControlVoucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
        }),
      })
      .register({
        key: CONSENT_KEY,
        agent: AGENT,
        resolved: resolvedBinding({ binding: consentingBinding }),
      });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(true);
  });

  test("(d) an anchored revocation before the evidence time fails; the identical revocation anchored after the evidence time still attributes (§7.4b non-retroactivity)", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    });
    const revokedBefore = new FakeBindingResolver().register({
      key: KEY_2,
      agent: AGENT,
      resolved: resolvedBinding({ binding, revocations: [revocationEntry(VOUCHER_DID, "2026-02-01T00:00:00Z")] }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const beforeOutcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: revokedBefore, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(beforeOutcome.ok).toBe(false);
    expect(beforeOutcome.reason).toBe("revoked");

    const revokedAfter = new FakeBindingResolver().register({
      key: KEY_2,
      agent: AGENT,
      resolved: resolvedBinding({ binding, revocations: [revocationEntry(VOUCHER_DID, "2026-04-01T00:00:00Z")] }),
    });
    const afterOutcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: revokedAfter, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(afterOutcome.ok).toBe(true);
  });

  test("rejects a lexically later offset-spelled revocation that is instant-earlier than the evidence", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    });
    const resolver = new FakeBindingResolver().register({
      key: KEY_2,
      agent: AGENT,
      resolved: resolvedBinding({ binding, revocations: [revocationEntry(VOUCHER_DID, "2026-07-29T01:00:00+02:00")] }),
    });
    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2), key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-07-29T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome).toMatchObject({ ok: false, reason: "revoked" });
  });

  test("a revocation signed by a key with no authority over the binding does not revoke", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    });
    const resolver = new FakeBindingResolver().register({
      key: KEY_2,
      agent: AGENT,
      resolved: resolvedBinding({
        binding,
        revocations: [revocationEntry(OTHER_VOUCHER_DID, "2026-02-01T00:00:00Z")],
      }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(true);
  });

  test("policy rejection at step 5 when applyPolicy is not disabled", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    });
    const resolver = new FakeBindingResolver().register({
      key: KEY_2,
      agent: AGENT,
      resolved: resolvedBinding({ binding }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      {
        bindingResolver: resolver,
        witnessVerifier: fakeWitnessVerifier,
        dsseVerifier: trustingDsseVerifier,
        policy: { accepted: ["urn:uuid:not-this-agent"], requiredStrength: "weak" },
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("policy-rejected");
  });

  test("{ applyPolicy: false } skips step 5 even when a rejecting policy is supplied", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    });
    const resolver = new FakeBindingResolver().register({
      key: KEY_2,
      agent: AGENT,
      resolved: resolvedBinding({ binding }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      {
        bindingResolver: resolver,
        witnessVerifier: fakeWitnessVerifier,
        dsseVerifier: trustingDsseVerifier,
        policy: { accepted: ["urn:uuid:not-this-agent"], requiredStrength: "weak" },
        applyPolicy: false,
      },
    );
    expect(outcome.ok).toBe(true);
  });
});

describe("settlementJoinCheck (§7.5a)", () => {
  const VERDICT_KEY = "did:key:z6MkfVERDICT111111111111111111111111111111";
  const SETTLEMENT_KEY = "did:key:z6MkfSETTLE1111111111111111111111111111111";

  function verdictBinding(): KeyBinding {
    return keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: VERDICT_KEY, algorithm: "ed25519", didKey: VERDICT_KEY },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      scope: ["verdicts"],
      relationship: "controls",
    });
  }

  function settlementBinding(): KeyBinding {
    return keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: SETTLEMENT_KEY, algorithm: "ed25519", didKey: SETTLEMENT_KEY },
      voucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false },
    });
  }

  test("(e) both legs resolving to the same Agent IRI, valid at both the envelope and claim time, joins", async () => {
    const resolver = new FakeBindingResolver()
      .register({ key: VERDICT_KEY, agent: AGENT, resolved: resolvedBinding({ binding: verdictBinding() }) })
      .register({ key: SETTLEMENT_KEY, agent: AGENT, resolved: resolvedBinding({ binding: settlementBinding() }) });

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: resolver },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.agent).toBe(AGENT);
  });

  test("(e) a missing settlement leg fails the join -- no partial credit", async () => {
    const resolver = new FakeBindingResolver()
      .register({ key: VERDICT_KEY, agent: AGENT, resolved: resolvedBinding({ binding: verdictBinding() }) });

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: resolver },
    );
    expect(outcome.ok).toBe(false);
  });

  test("(e) divergent times: the settlement leg is valid at the envelope's time but revoked by claim time fails the join", async () => {
    const resolver = new FakeBindingResolver()
      .register({ key: VERDICT_KEY, agent: AGENT, resolved: resolvedBinding({ binding: verdictBinding() }) })
      .register({
        key: SETTLEMENT_KEY,
        agent: AGENT,
        resolved: resolvedBinding({ binding: settlementBinding() }),
        validUntil: "2026-03-02T00:00:00Z",
      });

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: resolver },
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("authenticateRequester (§7.5b)", () => {
  const REQUESTER_KEY = "did:key:z6MkfREQUESTER11111111111111111111111111111";

  test("(f) a valid Submission whose key resolves to the claimed requester IRI with scope:authorizations authenticates", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: REQUESTER_KEY, algorithm: "ed25519", didKey: REQUESTER_KEY },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      scope: ["authorizations"],
    });
    const resolver = new FakeBindingResolver().register({
      key: REQUESTER_KEY,
      agent: AGENT,
      resolved: resolvedBinding({ binding }),
    });
    const envelopeBytes = sealedEnvelope({ submission: true }, TRUST_KEY_BINDING_MEDIA_TYPE, REQUESTER_KEY);

    const outcome = await authenticateRequester(
      { envelopeBytes, key: REQUESTER_KEY, requesterAgent: AGENT, sealingTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(true);
  });

  test("(f) a Submission whose key resolves to a different requester IRI fails", async () => {
    const binding = keyBinding({
      agent: "urn:uuid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      key: { publicKey: "0x00", keyid: REQUESTER_KEY, algorithm: "ed25519", didKey: REQUESTER_KEY },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      scope: ["authorizations"],
    });
    const resolver = new FakeBindingResolver().register({
      key: REQUESTER_KEY,
      agent: "urn:uuid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      resolved: resolvedBinding({ binding }),
    });
    const envelopeBytes = sealedEnvelope({ submission: true }, TRUST_KEY_BINDING_MEDIA_TYPE, REQUESTER_KEY);

    const outcome = await authenticateRequester(
      { envelopeBytes, key: REQUESTER_KEY, requesterAgent: AGENT, sealingTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(false);
  });

  test("a key bound with relationship:signs-for (but no scope:authorizations) also authenticates", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: REQUESTER_KEY, algorithm: "ed25519", didKey: REQUESTER_KEY },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      relationship: "signs-for",
      scope: ["deliveries"],
    });
    const resolver = new FakeBindingResolver().register({
      key: REQUESTER_KEY,
      agent: AGENT,
      resolved: resolvedBinding({ binding }),
    });
    const envelopeBytes = sealedEnvelope({ submission: true }, TRUST_KEY_BINDING_MEDIA_TYPE, REQUESTER_KEY);

    const outcome = await authenticateRequester(
      { envelopeBytes, key: REQUESTER_KEY, requesterAgent: AGENT, sealingTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(true);
  });
});
