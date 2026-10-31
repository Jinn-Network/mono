// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign, verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { canonicalJsonBytes } from "./canonical-json.js";
import { ceremonyEvidenceDigest } from "./ceremony.js";
import type { EoaCeremonyEvidence } from "./ceremony.js";
import { dssePreAuthEncoding, parseDsseEnvelope, sealDsseEnvelope } from "./dsse.js";
import {
  TRUST_KEY_BINDING_FORMAT,
  TRUST_KEY_BINDING_MEDIA_TYPE,
  TRUST_REVOCATION_FORMAT,
  TRUST_REVOCATION_MEDIA_TYPE,
} from "./identifiers.js";
import type { BindingResolver, ResolvedBinding, ResolvedRevocation, WitnessVerifier } from "./interfaces.js";
import type { KeyBinding } from "./key-binding.js";
import { sealKeyBinding, validateKeyBinding } from "./key-binding.js";
import type { DsseChainVerifier } from "./policy.js";
import { didPkh } from "./spellings.js";
import {
  authenticateRequester,
  checkBindingRevocation,
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

/** A binding fit to give authority (§7.4a): sealed by the key it binds, and in place before the
 * default `resolvedBinding` candidate took effect. */
function authorityBinding(binding: KeyBinding, overrides: Partial<ResolvedBinding> = {}): ResolvedBinding {
  return resolvedBinding({
    binding,
    envelopeBytes: sealedEnvelope(binding, TRUST_KEY_BINDING_MEDIA_TYPE, binding.key.didKey),
    bindingDigest: `sha256:${"a".repeat(64)}`,
    effectiveStart: "2025-12-01T00:00:00Z",
    ...overrides,
  });
}

/**
 * Real Ed25519 signatures over the DSSE pre-authentication encoding. `trustingDsseVerifier` echoes
 * every declared keyid, so a signature check cannot fail under it: the cases that turn on who
 * actually signed use this instead.
 */
function signingKeys(...keyids: readonly string[]) {
  const pairs = new Map(keyids.map((keyid) => [keyid, generateKeyPairSync("ed25519")]));
  const signWith = (keyid: string, bytes: Uint8Array): Uint8Array =>
    new Uint8Array(sign(null, bytes, pairs.get(keyid)!.privateKey));
  const verifier: DsseChainVerifier = (envelopeBytes) => {
    const envelope = parseDsseEnvelope(envelopeBytes);
    const encoded = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
    return {
      validSignerKeyids: envelope.signatures.flatMap(({ keyid, sig }) => {
        const publicKey: KeyObject | undefined = keyid === undefined ? undefined : pairs.get(keyid)?.publicKey;
        return keyid !== undefined && publicKey !== undefined
          && verifySignature(null, encoded, publicKey, Buffer.from(sig, "base64")) ? [keyid] : [];
      }),
    };
  };
  /** Sealed declaring `keyid`, and actually signed by `signedBy`. */
  const seal = (payload: unknown, payloadType: string, keyid: string, signedBy: string = keyid): Uint8Array => {
    const payloadBytes = canonicalJsonBytes(payload);
    return sealDsseEnvelope({
      payloadBytes,
      payloadType,
      signatures: [{ keyid, signature: signWith(signedBy, dssePreAuthEncoding(payloadType, payloadBytes)) }],
    });
  };
  return { verifier, seal, signWith };
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
const OTHER_AGENT = "urn:uuid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("verifyEnvelopeBinding", () => {
  test("a real sealed KeyBinding can carry and verify the admission-receipt scope (§7.42/§7.45)", async () => {
    const admissionScope =
      "https://spec.jinn.network/trust-scopes/admission-receipts/v1";
    const key = "did:key:z6MkAdmissionScopeFixture1111111111111111111";
    const agent = "https://spec.jinn.network/agents/admission-scope-fixture";
    const binding = keyBinding({
      agent,
      key: {
        publicKey: "fixture-public-key",
        keyid: key,
        algorithm: "ed25519",
        didKey: key,
      },
      voucher: {
        kind: "account",
        did: didPkh(8453, "0x4444444444444444444444444444444444444444"),
        contractAccount: false,
      },
      scope: [admissionScope],
    });
    const sealedBinding = await sealKeyBinding(
      binding,
      async () => [{ signature: new Uint8Array([1, 2, 3]), keyid: key }],
    );
    const report = validateKeyBinding(sealedBinding.envelopeBytes);
    expect(report).toMatchObject({ conforms: true });
    expect(report.value?.scope).toEqual([admissionScope]);

    const resolver = new FakeBindingResolver().register({
      key,
      agent,
      resolved: resolvedBinding({
        binding: report.value!,
        envelopeBytes: sealedBinding.envelopeBytes,
        bindingDigest: sealedBinding.recordDigest,
      }),
    });
    const receiptEnvelope = sealedEnvelope(
      { admission: "accepted" },
      "application/vnd.in-toto+json",
      key,
    );
    const outcome = await verifyEnvelopeBinding(
      {
        envelopeBytes: receiptEnvelope,
        key,
        agent,
        family: admissionScope,
        atTime: "2026-03-01T00:00:00Z",
      },
      {
        bindingResolver: resolver,
        witnessVerifier: fakeWitnessVerifier,
        dsseVerifier: trustingDsseVerifier,
        policy: { accepted: [agent], requiredStrength: "strong" },
      },
    );
    expect(outcome).toMatchObject({ ok: true });
  });

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

  // A resolver contracted never to resolve by key alone (interfaces.ts) may still
  // do so through a buggy key-only cache. Step 2 asserts the resolved binding names
  // the claimed Agent IRI so no call site has to remember to (issue #3385).
  test("step 2 rejects a binding the resolver returned for a different Agent IRI", async () => {
    const otherAgent = "urn:uuid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const keyOnlyResolver: BindingResolver = {
      async resolveBinding() {
        return resolvedBinding({
          binding: keyBinding({
            agent: otherAgent,
            key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
            voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
          }),
        });
      },
    };
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: keyOnlyResolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
    expect(outcome.reason).toBe("binding-not-resolved");
    expect(outcome.resolvedBinding?.binding.agent).toBe(otherAgent);
  });

  // The assertion's placement is the point: it must precede steps 3-5, so a foreign
  // binding is refused as unresolved rather than reported as some later leg's failure.
  test("the step 2 agent assertion precedes the later legs", async () => {
    const otherAgent = "urn:uuid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const keyOnlyResolver: BindingResolver = {
      async resolveBinding() {
        return resolvedBinding({
          binding: keyBinding({
            agent: otherAgent,
            key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
            voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
            scope: ["verdicts"],
          }),
        });
      },
    };
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    // "deliveries" is not in the binding's scope either, so step 4 would also refuse it.
    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: keyOnlyResolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("binding-not-resolved");
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
      resolved: resolvedBinding({ binding, isGenesis: false }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("consent-chain-violation");
    expect(outcome.detail).toMatch(/no incumbent controls voucher/);
  });

  test("(c) a non-genesis binding whose incumbent controls voucher belongs to a different identity and that carries no consent countersignature is rejected (§7.4a)", async () => {
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
        incumbentControls: [
          { key: CONSENT_KEY, voucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false } },
        ],
      }),
    });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("consent-chain-violation");
    expect(outcome.detail).toContain(OTHER_VOUCHER_DID);
    expect(outcome.detail).toContain(VOUCHER_DID);
  });

  test("self-extension succeeds when the binding's own voucher already holds a standing incumbent controls binding (§7.4a option 1)", async () => {
    const voucher = { kind: "account" as const, did: VOUCHER_DID, contractAccount: false };
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher,
    });
    const incumbent = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
      voucher,
    });
    const resolver = new FakeBindingResolver()
      .register({
        key: KEY_2,
        agent: AGENT,
        resolved: resolvedBinding({
          binding,
          isGenesis: false,
          incumbentControls: [{ key: CONSENT_KEY, voucher }],
        }),
      })
      .register({ key: CONSENT_KEY, agent: AGENT, resolved: authorityBinding(incumbent) });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(true);
  });

  test("an incumbent whose record is not signed by the key it binds gives no authority (§7.1, §7.4a)", async () => {
    const voucher = { kind: "account" as const, did: VOUCHER_DID, contractAccount: false };
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher,
    });
    const incumbent = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
      voucher,
    });
    const resolver = new FakeBindingResolver()
      .register({
        key: KEY_2,
        agent: AGENT,
        resolved: resolvedBinding({
          binding,
          isGenesis: false,
          incumbentControls: [{ key: CONSENT_KEY, voucher }],
        }),
      })
      .register({
        key: CONSENT_KEY,
        agent: AGENT,
        resolved: authorityBinding(incumbent, {
          envelopeBytes: sealedEnvelope(incumbent, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
        }),
      });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome).toMatchObject({ ok: false, reason: "consent-chain-violation" });
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
          incumbentControls: [
            { key: CONSENT_KEY, voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false } },
          ],
        }),
      })
      .register({
        key: CONSENT_KEY,
        agent: AGENT,
        resolved: authorityBinding(consentingBinding),
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

  describe("who actually signed, under real signatures", () => {
    const voucher = { kind: "account" as const, did: VOUCHER_DID, contractAccount: false };
    const otherVoucher = { kind: "account" as const, did: OTHER_VOUCHER_DID, contractAccount: false };

    function consentCase(consentSignedBy: string) {
      const keys = signingKeys(KEY_2, CONSENT_KEY);
      const unsigned = keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
        voucher: otherVoucher,
      });
      const target = dssePreAuthEncoding(TRUST_KEY_BINDING_MEDIA_TYPE, canonicalJsonBytes(unsigned));
      const binding = keyBinding({
        ...unsigned,
        consent: { keyid: CONSENT_KEY, sig: Buffer.from(keys.signWith(consentSignedBy, target)).toString("base64") },
      });
      const consenter = keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
        voucher,
        scope: ["bindings"],
      });
      const resolver = new FakeBindingResolver()
        .register({ key: KEY_2, agent: AGENT, resolved: resolvedBinding({ binding, isGenesis: false }) })
        .register({
          key: CONSENT_KEY,
          agent: AGENT,
          resolved: authorityBinding(consenter, {
            envelopeBytes: keys.seal(consenter, TRUST_KEY_BINDING_MEDIA_TYPE, CONSENT_KEY),
          }),
        });
      return verifyEnvelopeBinding(
        {
          envelopeBytes: keys.seal({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: AGENT,
          family: "deliveries",
          atTime: "2026-03-01T00:00:00Z",
        },
        { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: keys.verifier },
      );
    }

    test("a countersignature made by the key it names gives consent", async () => {
      expect(await consentCase(CONSENT_KEY)).toMatchObject({ ok: true });
    });

    test("a countersignature naming a bindings-scoped key, made by another, gives none", async () => {
      expect(await consentCase(KEY_2)).toMatchObject({ ok: false, reason: "consent-chain-violation" });
    });

    function revocationCase(revocationSignedBy: string) {
      const keys = signingKeys(KEY_2, CONSENT_KEY);
      const binding = keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
        voucher,
      });
      const revoker = keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
        voucher: otherVoucher,
        scope: ["bindings"],
      });
      const entry = revocationEntry(CONSENT_KEY, "2026-02-01T00:00:00Z");
      const resolver = new FakeBindingResolver()
        .register({
          key: KEY_2,
          agent: AGENT,
          resolved: resolvedBinding({
            binding,
            revocations: [{
              ...entry,
              envelopeBytes: keys.seal(entry.revocation, TRUST_REVOCATION_MEDIA_TYPE, CONSENT_KEY, revocationSignedBy),
            }],
          }),
        })
        .register({
          key: CONSENT_KEY,
          agent: AGENT,
          resolved: authorityBinding(revoker, {
            envelopeBytes: keys.seal(revoker, TRUST_KEY_BINDING_MEDIA_TYPE, CONSENT_KEY),
          }),
        });
      return verifyEnvelopeBinding(
        {
          envelopeBytes: keys.seal({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: AGENT,
          family: "deliveries",
          atTime: "2026-03-01T00:00:00Z",
        },
        { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: keys.verifier },
      );
    }

    test("a revocation signed by the key it names takes effect", async () => {
      expect(await revocationCase(CONSENT_KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });

    test("a revocation naming a bindings-scoped key, signed by another, does not", async () => {
      expect(await revocationCase(KEY_2)).toMatchObject({ ok: true });
    });
  });

  describe("an authority outside its own window, under a resolver that does not window it", () => {
    const voucher = { kind: "account" as const, did: VOUCHER_DID, contractAccount: false };
    const unwindowed = (entries: Readonly<Record<string, ResolvedBinding>>): BindingResolver => ({
      async resolveBinding(query) {
        return entries[query.key] ?? null;
      },
    });

    test("an incumbent that expired before the new binding took effect gives nothing", async () => {
      const incumbent = keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
        voucher,
        expiresAt: "2025-12-15T00:00:00Z",
      });
      const binding = keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
        voucher,
      });
      const outcome = await verifyEnvelopeBinding(
        {
          envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: AGENT,
          family: "deliveries",
          atTime: "2026-03-01T00:00:00Z",
        },
        {
          bindingResolver: unwindowed({
            [KEY_2]: resolvedBinding({ binding, isGenesis: false, incumbentControls: [{ key: CONSENT_KEY, voucher }] }),
            [CONSENT_KEY]: authorityBinding(incumbent),
          }),
          witnessVerifier: fakeWitnessVerifier,
          dsseVerifier: trustingDsseVerifier,
        },
      );
      expect(outcome).toMatchObject({ ok: false, reason: "consent-chain-violation" });
    });

    test("a revoker that took effect after its own revocation revokes nothing", async () => {
      const revoker = keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
        voucher,
        scope: ["bindings"],
      });
      const binding = keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
        voucher,
      });
      const outcome = await verifyEnvelopeBinding(
        {
          envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: AGENT,
          family: "deliveries",
          atTime: "2026-03-01T00:00:00Z",
        },
        {
          bindingResolver: unwindowed({
            [KEY_2]: resolvedBinding({ binding, revocations: [revocationEntry(CONSENT_KEY, "2026-02-01T00:00:00Z")] }),
            [CONSENT_KEY]: authorityBinding(revoker, { effectiveStart: "2026-02-15T00:00:00Z" }),
          }),
          witnessVerifier: fakeWitnessVerifier,
          dsseVerifier: trustingDsseVerifier,
        },
      );
      expect(outcome).toMatchObject({ ok: true });
    });
  });

  describe("a countersignature that cannot be read is an invalid consent, not an exception", () => {
    const consentCase = async (sig: string, extra: Record<string, unknown> = {}) => {
      const binding = keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
        voucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false },
        consent: { keyid: CONSENT_KEY, sig },
        ...extra,
      });
      const consenter = keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
        voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
        scope: ["bindings"],
      });
      const resolver = new FakeBindingResolver()
        .register({ key: KEY_2, agent: AGENT, resolved: resolvedBinding({ binding, isGenesis: false }) })
        .register({ key: CONSENT_KEY, agent: AGENT, resolved: authorityBinding(consenter) });
      return verifyEnvelopeBinding(
        {
          envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: AGENT,
          family: "deliveries",
          atTime: "2026-03-01T00:00:00Z",
        },
        { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
      );
    };

    test("a signature that is not base64", async () => {
      expect(await consentCase("%")).toMatchObject({
        ok: false,
        reason: "consent-chain-violation",
        detail: expect.stringContaining("does not validate"),
      });
    });

    test("a record whose payload cannot be canonicalized", async () => {
      expect(await consentCase(btoa("signature"), { "x-example/fraction": 1.5 })).toMatchObject({
        ok: false,
        reason: "consent-chain-violation",
        detail: expect.stringContaining("does not validate"),
      });
    });
  });

  describe("what a store can hold ends in a verdict", () => {
    const voucher = { kind: "account" as const, did: VOUCHER_DID, contractAccount: false };
    const verifyKey2 = (resolver: BindingResolver) =>
      verifyEnvelopeBinding(
        {
          envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: AGENT,
          family: "deliveries",
          atTime: "2026-03-01T00:00:00Z",
        },
        { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
      );
    const own = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher,
    });
    const peer = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
      voucher,
      scope: ["bindings"],
    });

    test.each([
      ["a lone surrogate", (evidence: EoaCeremonyEvidence) => ({ ...evidence, message: { ...evidence.message, nonce: "a\ud800b" } })],
      ["an unsafe integer", (evidence: EoaCeremonyEvidence) => ({ ...evidence, message: { ...evidence.message, chainId: 1e21 } })],
      ["no message", (evidence: EoaCeremonyEvidence) => ({ ...evidence, message: undefined })],
      ["resources that are not a list", (evidence: EoaCeremonyEvidence) => ({ ...evidence, message: { ...evidence.message, resources: 7 } })],
      ["message bytes that are not bytes", (evidence: EoaCeremonyEvidence) => ({ ...evidence, messageBytes: "bytes" })],
      ["no signature", (evidence: EoaCeremonyEvidence) => ({ ...evidence, signature: undefined })],
      ["evidence that is not an object", () => null],
    ])("ceremony evidence with %s is a failed ceremony", async (_label, mangle) => {
      const resolver = new FakeBindingResolver().register({
        key: KEY_2,
        agent: AGENT,
        resolved: resolvedBinding({
          binding: keyBinding({ ...own, ceremony: { type: "eoa", digest: `sha256:${"a".repeat(64)}` } }),
          ceremonyEvidence: mangle(eoaCeremonyEvidence()) as never,
        }),
      });
      expect(await verifyKey2(resolver)).toMatchObject({ ok: false, reason: "ceremony-verification-failed" });
    });

    test("evidence the record commits to fails the same way when it cannot be read past its digest", async () => {
      const evidence = eoaCeremonyEvidence();
      const committed = { ...evidence, message: { ...evidence.message, resources: 7 } } as never;
      const resolver = new FakeBindingResolver().register({
        key: KEY_2,
        agent: AGENT,
        resolved: resolvedBinding({
          binding: keyBinding({
            ...own,
            voucher: { kind: "account", did: didPkh(1, evidence.message.address as `0x${string}`), contractAccount: false },
            ceremony: { type: "eoa", digest: ceremonyEvidenceDigest(committed) },
          }),
          ceremonyEvidence: committed,
        }),
      });
      expect(await verifyKey2(resolver)).toMatchObject({
        ok: false,
        reason: "ceremony-verification-failed",
        detail: "ceremony evidence cannot be read.",
      });
    });

    test("an authority whose envelope cannot be read gives nothing", async () => {
      const resolver = new FakeBindingResolver()
        .register({
          key: KEY_2,
          agent: AGENT,
          resolved: resolvedBinding({ binding: own, isGenesis: false, incumbentControls: [{ key: CONSENT_KEY, voucher }] }),
        })
        .register({
          key: CONSENT_KEY,
          agent: AGENT,
          resolved: authorityBinding(keyBinding({ ...peer, scope: ["deliveries"] }), {
            envelopeBytes: new TextEncoder().encode("not an envelope"),
          }),
        });
      expect(await verifyKey2(resolver)).toMatchObject({ ok: false, reason: "consent-chain-violation" });
    });

    test("a revocation whose envelope cannot be read has no effect", async () => {
      const resolver = new FakeBindingResolver()
        .register({
          key: KEY_2,
          agent: AGENT,
          resolved: resolvedBinding({
            binding: own,
            revocations: [{
              ...revocationEntry(CONSENT_KEY, "2026-02-01T00:00:00Z"),
              envelopeBytes: new TextEncoder().encode("not an envelope"),
            }],
          }),
        })
        .register({ key: CONSENT_KEY, agent: AGENT, resolved: authorityBinding(peer) });
      expect(await verifyKey2(resolver)).toMatchObject({ ok: true });
    });
  });

  describe("an agentId voucher (§7.2)", () => {
    const voucher = { kind: "agentId" as const, caip19: "eip155:84532/erc721:0x2222222222222222222222222222222222222222/7" };
    const peer = (keyid: string, scope: KeyBinding["scope"]) => keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid, algorithm: "ed25519", didKey: keyid },
      voucher,
      scope,
      ceremony: { type: "agentId", digest: `sha256:${"a".repeat(64)}` },
    });
    const verifyNew = (binding: KeyBinding, consenter: KeyBinding) => verifyEnvelopeBinding(
      {
        envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
        key: KEY_2,
        agent: AGENT,
        family: "deliveries",
        atTime: "2026-03-01T00:00:00Z",
      },
      {
        bindingResolver: new FakeBindingResolver()
          .register({
            key: KEY_2,
            agent: AGENT,
            resolved: resolvedBinding({ binding, isGenesis: false, incumbentControls: [{ key: CONSENT_KEY, voucher }] }),
          })
          .register({ key: CONSENT_KEY, agent: AGENT, resolved: authorityBinding(consenter) }),
        witnessVerifier: fakeWitnessVerifier,
        dsseVerifier: trustingDsseVerifier,
      },
    );

    test("does not extend from a standing binding of the same agentId: registry facts vouch nothing", async () => {
      const outcome = await verifyNew(peer(KEY_2, ["deliveries"]), peer(CONSENT_KEY, ["bindings"]));
      expect(outcome).toMatchObject({ ok: false, reason: "consent-chain-violation" });
    });

    test("still joins by consent", async () => {
      const consented = { ...peer(KEY_2, ["deliveries"]), consent: { keyid: CONSENT_KEY, sig: btoa("consent") } };
      expect(await verifyNew(consented, peer(CONSENT_KEY, ["bindings"]))).toMatchObject({ ok: true });
    });
  });

  test("a revocation whose time cannot be read has no effect unless its signer has authority (§7.4b)", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    });
    const verifyWith = (revokedBy: string) => {
      const resolver = new FakeBindingResolver().register({
        key: KEY_2,
        agent: AGENT,
        resolved: resolvedBinding({ binding, revocations: [revocationEntry(revokedBy, "2026-02-01T00:00Z")] }),
      });
      return verifyEnvelopeBinding(
        {
          envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: AGENT,
          family: "deliveries",
          atTime: "2026-03-01T00:00:00Z",
        },
        { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
      );
    };

    expect(await verifyWith(OTHER_VOUCHER_DID)).toMatchObject({ ok: true });
    expect(await verifyWith(VOUCHER_DID)).toMatchObject({ ok: false, reason: "revoked" });
  });

  test("a key revoking its own binding takes effect even when that record could not stand as an authority", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      scope: ["deliveries", "bindings"],
    });
    const resolved = resolvedBinding({
      binding,
      envelopeBytes: sealedEnvelope(binding, TRUST_KEY_BINDING_MEDIA_TYPE, CONSENT_KEY),
      revocations: [revocationEntry(KEY_2, "2026-02-01T00:00:00Z")],
    });
    const resolver = new FakeBindingResolver().register({ key: KEY_2, agent: AGENT, resolved });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
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

  // The three procedures below resolve bindings directly rather than through
  // `verifyEnvelopeBinding`, so each needs the same (key, agent) assertion the
  // step-2 tests above pin (issue #3572). A key-only resolver is the realistic bug.
  test("a consent countersignature by a key bound to a DIFFERENT Agent IRI does not consent (§7.4a option 2)", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false },
      consent: { keyid: CONSENT_KEY, sig: btoa("irrelevant-in-this-fake") },
    });
    // Bindings-scoped, so the scope guard alone would wave it through: the
    // agent assertion has to run first for this to be refused at all.
    const foreignConsentingBinding = keyBinding({
      agent: OTHER_AGENT,
      key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      scope: ["bindings"],
    });
    const keyOnlyResolver: BindingResolver = {
      async resolveBinding(query) {
        if (query.key === CONSENT_KEY) return resolvedBinding({ binding: foreignConsentingBinding });
        return resolvedBinding({
          binding,
          isGenesis: false,
          incumbentControls: [
            { key: CONSENT_KEY, voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false } },
          ],
        });
      },
    };
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: keyOnlyResolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
    expect(outcome.reason).toBe("consent-chain-violation");
  });

  test("a revocation signed by a bindings-scoped key of a DIFFERENT Agent IRI does not revoke (§7.4b)", async () => {
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    });
    const foreignRevokerBinding = keyBinding({
      agent: OTHER_AGENT,
      key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
      voucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false },
      scope: ["bindings"],
    });
    const keyOnlyResolver: BindingResolver = {
      async resolveBinding(query) {
        if (query.key === CONSENT_KEY) return resolvedBinding({ binding: foreignRevokerBinding });
        return resolvedBinding({
          binding,
          revocations: [revocationEntry(CONSENT_KEY, "2026-02-01T00:00:00Z")],
        });
      },
    };
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: keyOnlyResolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
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
  const sealedLeg = (overrides: Partial<ResolvedBinding> & Pick<ResolvedBinding, "binding">): ResolvedBinding =>
    resolvedBinding({ envelopeBytes: sealedEnvelope(overrides.binding, TRUST_KEY_BINDING_MEDIA_TYPE, overrides.binding.key.didKey), ...overrides });

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
      scope: ["settlements"],
    });
  }

  test("(e) both legs resolving to the same Agent IRI, valid at both the envelope and claim time, joins", async () => {
    const resolver = new FakeBindingResolver()
      .register({ key: VERDICT_KEY, agent: AGENT, resolved: resolvedBinding({ binding: verdictBinding() }) })
      .register({ key: SETTLEMENT_KEY, agent: AGENT, resolved: sealedLeg({ binding: settlementBinding() }) });

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
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
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(false);
  });

  test("(e) divergent times: the settlement leg is valid at the envelope's time but revoked by claim time fails the join", async () => {
    const resolver = new FakeBindingResolver()
      .register({ key: VERDICT_KEY, agent: AGENT, resolved: resolvedBinding({ binding: verdictBinding() }) })
      .register({
        key: SETTLEMENT_KEY,
        agent: AGENT,
        resolved: sealedLeg({ binding: settlementBinding() }),
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
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(false);
  });
  // §7.5a is the money-adjacent join: it ties a verdict's DSSE key to a
  // settling on-chain actor, so a key-only resolver must not let one agent's
  // key stand in for another's on any of the three legs (issue #3572). Each
  // foreign binding below carries the scope the leg wants, so the agent
  // assertion is the only thing that can refuse it.
  test("(e) a verdict leg the resolver returned for a different Agent IRI fails the join", async () => {
    const keyOnlyResolver: BindingResolver = {
      async resolveBinding(query) {
        if (query.key === VERDICT_KEY) {
          return resolvedBinding({ binding: { ...verdictBinding(), agent: OTHER_AGENT } });
        }
        return sealedLeg({ binding: settlementBinding() });
      },
    };

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: keyOnlyResolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
    expect(outcome.reason).toMatch(/verdict leg does not resolve/);
  });

  test("(e) a settlement leg the resolver returned for a different Agent IRI fails the join", async () => {
    const keyOnlyResolver: BindingResolver = {
      async resolveBinding(query) {
        if (query.key === VERDICT_KEY) return resolvedBinding({ binding: verdictBinding() });
        return resolvedBinding({ binding: { ...settlementBinding(), agent: OTHER_AGENT } });
      },
    };

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: keyOnlyResolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
    expect(outcome.reason).toMatch(/settlement leg does not resolve/);
  });

  test("(e) a settlement leg that no longer resolves at claim time fails as revoked or expired", async () => {
    const expiringResolver: BindingResolver = {
      async resolveBinding(query, atTime) {
        if (query.key === VERDICT_KEY) return resolvedBinding({ binding: verdictBinding() });
        if (atTime === "2026-03-01T00:00:00Z") return sealedLeg({ binding: settlementBinding() });
        return null;
      },
    };

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: expiringResolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
    expect(outcome.reason).toMatch(/not valid \(revoked or expired\) at claim time/);
  });

  test("(e) a settlement leg that drifts to a different Agent IRI by claim time fails the join", async () => {
    const keyOnlyResolver: BindingResolver = {
      async resolveBinding(query, atTime) {
        if (query.key === VERDICT_KEY) return resolvedBinding({ binding: verdictBinding() });
        if (atTime === "2026-03-01T00:00:00Z") return sealedLeg({ binding: settlementBinding() });
        return resolvedBinding({ binding: { ...settlementBinding(), agent: OTHER_AGENT } });
      },
    };

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: keyOnlyResolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
    // Agent drift is not revocation: the reason names the drifted IRI rather
    // than sending an operator looking for a revocation that does not exist.
    expect(outcome.reason).toMatch(/resolves to Agent IRI/);
    expect(outcome.reason).toContain(OTHER_AGENT);
    expect(outcome.reason).not.toMatch(/revoked or expired/);
  });

  // The two claim-time guards below are different failures of the same leg, and the order they run
  // in is the contract (#4853, issue #3572's rationale): a binding resolved for a foreign Agent IRI
  // is refused as that, never as some later guard's failure. A claim-time leg that drifts to
  // another Agent IRI AND has dropped scope:settlements is the only fixture that tells the two
  // orders apart -- with either guard alone, the outcome is the same under both.
  test("(e) a settlement leg that drifts to a different Agent IRI and drops scope:settlements by claim time reports the drift, not the lost scope", async () => {
    const keyOnlyResolver: BindingResolver = {
      async resolveBinding(query, atTime) {
        if (query.key === VERDICT_KEY) return resolvedBinding({ binding: verdictBinding() });
        if (atTime === "2026-03-01T00:00:00Z") return sealedLeg({ binding: settlementBinding() });
        return resolvedBinding({ binding: { ...settlementBinding(), agent: OTHER_AGENT, scope: ["deliveries"] } });
      },
    };

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: keyOnlyResolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
    expect(outcome.reason).toMatch(/resolves to Agent IRI/);
    expect(outcome.reason).toContain(OTHER_AGENT);
    expect(outcome.reason).not.toMatch(/lost scope/);
  });

  test("(e) a settlement leg that keeps its Agent IRI but drops scope:settlements by claim time fails the join as a lost scope", async () => {
    const timeVaryingResolver: BindingResolver = {
      async resolveBinding(query, atTime) {
        if (query.key === VERDICT_KEY) return resolvedBinding({ binding: verdictBinding() });
        if (atTime === "2026-03-01T00:00:00Z") return sealedLeg({ binding: settlementBinding() });
        return resolvedBinding({ binding: { ...settlementBinding(), scope: ["deliveries"] } });
      },
    };

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: timeVaryingResolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
    expect(outcome.reason).toBe("settlement leg lost scope:settlements at claim time.");
  });

  describe("a settlement leg with no standing of its own", () => {
    const joinWith = (settlement: ResolvedBinding, witnessVerifier: WitnessVerifier = fakeWitnessVerifier) => settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      {
        bindingResolver: new FakeBindingResolver()
          .register({ key: VERDICT_KEY, agent: AGENT, resolved: resolvedBinding({ binding: verdictBinding() }) })
          .register({ key: SETTLEMENT_KEY, agent: AGENT, resolved: settlement }),
        witnessVerifier,
        dsseVerifier: trustingDsseVerifier,
      },
    );

    test("(e) a leg with no chain to the genesis fails the join", async () => {
      expect(await joinWith(sealedLeg({ binding: settlementBinding(), isGenesis: false })))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/settlement leg does not stand/) });
    });

    test("(e) a leg its key never signed fails the join", async () => {
      expect(await joinWith(resolvedBinding({ binding: settlementBinding() })))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/settlement leg does not stand/) });
    });

    test("(e) a leg whose ceremony fails fails the join", async () => {
      const binding: KeyBinding = { ...settlementBinding(), ceremony: { type: "safe", digest: `sha256:${"e".repeat(64)}` } };
      const refusing: WitnessVerifier = { verify1271Witness: async () => ({ verified: false }) };
      const witness = {
        chainId: 8453,
        blockNumber: 1,
        blockHash: `0x${"c".repeat(64)}`,
        verifier: AGENT,
        envelopeBytes: Uint8Array.of(1),
      };
      expect(await joinWith(sealedLeg({ binding, witness }), refusing))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/settlement leg does not stand/) });
      expect(await joinWith(sealedLeg({ binding, witness }))).toMatchObject({ ok: true });
    });
  });

  describe("a revocation the resolver lists", () => {
    const CLAIM_TIME = "2026-03-05T00:00:00Z";
    const ENVELOPE_TIME = "2026-03-01T00:00:00Z";

    function joinOver(legs: { verdict?: ResolvedBinding; settlement?: ResolvedBinding; claimLeg?: ResolvedBinding }) {
      const verdict = legs.verdict ?? resolvedBinding({ binding: verdictBinding() });
      const settlement = legs.settlement ?? sealedLeg({ binding: settlementBinding() });
      const claimLeg = legs.claimLeg ?? settlement;
      return settlementJoinCheck(
        {
          verdictKey: VERDICT_KEY,
          settlementDeclarationKey: SETTLEMENT_KEY,
          claimedEvaluatorAgent: AGENT,
          family: "verdicts",
          envelopeEffectiveTime: ENVELOPE_TIME,
          claimTime: CLAIM_TIME,
        },
        {
          bindingResolver: {
            async resolveBinding(query, atTime) {
              if (query.key === VERDICT_KEY) return verdict;
              return atTime === CLAIM_TIME ? claimLeg : settlement;
            },
          },
          witnessVerifier: fakeWitnessVerifier,
          dsseVerifier: trustingDsseVerifier,
        },
      );
    }

    function settlementRevokedBy(revokedBy: string, effectiveTime: string): ResolvedBinding {
      return sealedLeg({ binding: settlementBinding(), revocations: [revocationEntry(revokedBy, effectiveTime)] });
    }

    test("(e) a settlement leg its voucher revoked by claim time fails the join", async () => {
      const outcome = await joinOver({ settlement: settlementRevokedBy(OTHER_VOUCHER_DID, "2026-03-02T00:00:00Z") });
      expect(outcome).toMatchObject({ ok: false, reason: expect.stringMatching(/settlement leg is revoked at claim time/) });
      expect(outcome.agent).toBeUndefined();
    });

    test("(e) a revocation effective after the claim leaves the join standing", async () => {
      expect(await joinOver({ settlement: settlementRevokedBy(OTHER_VOUCHER_DID, "2026-03-06T00:00:00Z") }))
        .toEqual({ ok: true, agent: AGENT });
    });

    test("(e) a revocation with no authority over the leg leaves the join standing", async () => {
      expect(await joinOver({ settlement: settlementRevokedBy(VOUCHER_DID, "2026-03-02T00:00:00Z") }))
        .toEqual({ ok: true, agent: AGENT });
    });

    test("(e) a leg revoked by the envelope's time is named as that", async () => {
      expect(await joinOver({
        settlement: settlementRevokedBy(OTHER_VOUCHER_DID, "2026-02-01T00:00:00Z"),
        claimLeg: sealedLeg({ binding: settlementBinding() }),
      })).toMatchObject({ ok: false, reason: expect.stringMatching(/settlement leg is revoked at the envelope's time/) });
    });

    test("(e) a revocation of the record resolved at claim time fails the join", async () => {
      expect(await joinOver({ claimLeg: settlementRevokedBy(OTHER_VOUCHER_DID, "2026-03-02T00:00:00Z") }))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/settlement leg is revoked at claim time/) });
    });

    test("(e) a verdict leg its voucher revoked by the envelope's time fails the join", async () => {
      const verdict = resolvedBinding({ binding: verdictBinding(), revocations: [revocationEntry(VOUCHER_DID, "2026-02-01T00:00:00Z")] });
      expect(await joinOver({ verdict }))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/verdict leg is revoked at the envelope's time/) });
    });

    test("(e) a verdict leg revoked after the envelope still joins: a revocation is never retroactive", async () => {
      const verdict = resolvedBinding({ binding: verdictBinding(), revocations: [revocationEntry(VOUCHER_DID, "2026-03-02T00:00:00Z")] });
      expect(await joinOver({ verdict })).toEqual({ ok: true, agent: AGENT });
    });
  });

  // The join's `ok: true` should carry the agent it PROVED, not the one it was
  // handed. With the assertion in place the two are equal by construction --
  // this pins that the successful outcome names the resolved binding's agent.
  test("(e) a successful join reports the resolved verdict leg's Agent IRI", async () => {
    const resolver = new FakeBindingResolver()
      .register({ key: VERDICT_KEY, agent: AGENT, resolved: resolvedBinding({ binding: verdictBinding() }) })
      .register({ key: SETTLEMENT_KEY, agent: AGENT, resolved: sealedLeg({ binding: settlementBinding() }) });

    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: "2026-03-01T00:00:00Z",
        claimTime: "2026-03-05T00:00:00Z",
      },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.agent).toBe(verdictBinding().agent);
  });
});

describe("checkBindingRevocation (§7.5 step 4, §7.4b)", () => {
  const binding = keyBinding({
    agent: AGENT,
    key: { publicKey: "0x00", keyid: "did:key:z6MkfONLY11111111111111111111111111111111", algorithm: "ed25519", didKey: "did:key:z6MkfONLY11111111111111111111111111111111" },
    voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    scope: ["verdicts"],
  });
  const deps = {
    bindingResolver: new FakeBindingResolver(),
    witnessVerifier: fakeWitnessVerifier,
    dsseVerifier: trustingDsseVerifier,
  };

  test("a binding with no revocation passes", async () => {
    expect(await checkBindingRevocation(resolvedBinding({ binding }), "2026-03-01T00:00:00Z", deps)).toEqual({ ok: true });
  });

  test("an authorized revocation counts from its effective time, that instant included", async () => {
    const resolved = resolvedBinding({ binding, revocations: [revocationEntry(VOUCHER_DID, "2026-02-01T00:00:00Z")] });
    expect(await checkBindingRevocation(resolved, "2026-01-31T23:59:59Z", deps)).toEqual({ ok: true });
    expect(await checkBindingRevocation(resolved, "2026-02-01T00:00:00Z", deps)).toMatchObject({ ok: false, detail: expect.stringContaining(VOUCHER_DID) });
  });

  test("a revocation with no authority has no effect", async () => {
    const resolved = resolvedBinding({ binding, revocations: [revocationEntry(OTHER_VOUCHER_DID, "2026-02-01T00:00:00Z")] });
    expect(await checkBindingRevocation(resolved, "2026-03-01T00:00:00Z", deps)).toEqual({ ok: true });
  });

  describe("by a revoker whose ceremony only the witness leg can verify", () => {
    const COLD_KEY = "did:key:z6MkfCOLD1111111111111111111111111111111";
    const coldBinding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: COLD_KEY, algorithm: "ed25519", didKey: COLD_KEY },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: true },
      scope: ["bindings"],
      ceremony: { type: "safe", digest: `sha256:${"e".repeat(64)}` },
    });
    const coldResolver = new FakeBindingResolver().register({
      key: COLD_KEY,
      agent: AGENT,
      resolved: authorityBinding(coldBinding, {
        witness: {
          chainId: 8453,
          blockNumber: 1,
          blockHash: `0x${"c".repeat(64)}`,
          verifier: AGENT,
          envelopeBytes: Uint8Array.of(1),
        },
      }),
    });
    const revoked = resolvedBinding({ binding, revocations: [revocationEntry(COLD_KEY, "2026-02-01T00:00:00Z")] });
    const witnessSays = (verified: boolean): WitnessVerifier => ({ verify1271Witness: async () => ({ verified }) });
    const over = (verified: boolean) => ({
      bindingResolver: coldResolver,
      witnessVerifier: witnessSays(verified),
      dsseVerifier: trustingDsseVerifier,
    });

    test("counts when the injected witness verifier passes that ceremony", async () => {
      expect(await checkBindingRevocation(revoked, "2026-03-01T00:00:00Z", over(true))).toMatchObject({ ok: false });
    });

    test("does not count when it fails that ceremony", async () => {
      expect(await checkBindingRevocation(revoked, "2026-03-01T00:00:00Z", over(false))).toEqual({ ok: true });
    });
  });
});

describe("authenticateRequester (§7.5b)", () => {
  const REQUESTER_KEY = "did:key:z6MkfREQUESTER11111111111111111111111111111";

  function requesterBinding(revocations: readonly ResolvedRevocation[] = []): ResolvedBinding {
    return resolvedBinding({
      binding: keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: REQUESTER_KEY, algorithm: "ed25519", didKey: REQUESTER_KEY },
        voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
        scope: ["authorizations"],
      }),
      revocations,
    });
  }

  test("(f) a valid Submission whose key resolves to the claimed requester IRI with scope:authorizations authenticates", async () => {
    const resolver = new FakeBindingResolver().register({
      key: REQUESTER_KEY,
      agent: AGENT,
      resolved: requesterBinding(),
    });
    const envelopeBytes = sealedEnvelope({ submission: true }, TRUST_KEY_BINDING_MEDIA_TYPE, REQUESTER_KEY);

    const outcome = await authenticateRequester(
      { envelopeBytes, key: REQUESTER_KEY, requesterAgent: AGENT, sealingTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(true);
  });

  test("rejects a requester binding revoked before the Submission sealing time", async () => {
    const resolver = new FakeBindingResolver().register({
      key: REQUESTER_KEY,
      agent: AGENT,
      resolved: requesterBinding([
        revocationEntry(VOUCHER_DID, "2026-02-01T00:00:00Z"),
      ]),
    });
    const envelopeBytes = sealedEnvelope(
      { submission: true },
      TRUST_KEY_BINDING_MEDIA_TYPE,
      REQUESTER_KEY,
    );

    const outcome = await authenticateRequester(
      {
        envelopeBytes,
        key: REQUESTER_KEY,
        requesterAgent: AGENT,
        sealingTime: "2026-03-01T00:00:00Z",
      },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );

    expect(outcome).toEqual({
      ok: false,
      reason: `requester binding ceremony failed: revoked: revoked effective "2026-02-01T00:00:00Z" by "${VOUCHER_DID}".`,
    });
  });

  test("rejects a requester binding revoked exactly at the Submission sealing time", async () => {
    const sealingTime = "2026-03-01T00:00:00Z";
    const resolver = new FakeBindingResolver().register({
      key: REQUESTER_KEY,
      agent: AGENT,
      resolved: requesterBinding([
        revocationEntry(VOUCHER_DID, sealingTime),
      ]),
    });
    const envelopeBytes = sealedEnvelope(
      { submission: true },
      TRUST_KEY_BINDING_MEDIA_TYPE,
      REQUESTER_KEY,
    );

    const outcome = await authenticateRequester(
      {
        envelopeBytes,
        key: REQUESTER_KEY,
        requesterAgent: AGENT,
        sealingTime,
      },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );

    expect(outcome).toEqual({
      ok: false,
      reason: `requester binding ceremony failed: revoked: revoked effective "${sealingTime}" by "${VOUCHER_DID}".`,
    });
  });

  test("accepts a requester binding revoked after the Submission sealing time", async () => {
    const resolver = new FakeBindingResolver().register({
      key: REQUESTER_KEY,
      agent: AGENT,
      resolved: requesterBinding([
        revocationEntry(VOUCHER_DID, "2026-04-01T00:00:00Z"),
      ]),
    });
    const envelopeBytes = sealedEnvelope(
      { submission: true },
      TRUST_KEY_BINDING_MEDIA_TYPE,
      REQUESTER_KEY,
    );

    const outcome = await authenticateRequester(
      {
        envelopeBytes,
        key: REQUESTER_KEY,
        requesterAgent: AGENT,
        sealingTime: "2026-03-01T00:00:00Z",
      },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );

    expect(outcome).toEqual({ ok: true });
  });

  test("ignores a requester revocation issued by an unauthorized revoker", async () => {
    const resolver = new FakeBindingResolver().register({
      key: REQUESTER_KEY,
      agent: AGENT,
      resolved: requesterBinding([
        revocationEntry(OTHER_VOUCHER_DID, "2026-02-01T00:00:00Z"),
      ]),
    });
    const envelopeBytes = sealedEnvelope(
      { submission: true },
      TRUST_KEY_BINDING_MEDIA_TYPE,
      REQUESTER_KEY,
    );

    const outcome = await authenticateRequester(
      {
        envelopeBytes,
        key: REQUESTER_KEY,
        requesterAgent: AGENT,
        sealingTime: "2026-03-01T00:00:00Z",
      },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );

    expect(outcome).toEqual({ ok: true });
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
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
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
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome.ok).toBe(true);
  });
});
