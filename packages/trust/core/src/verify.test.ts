// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign, verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, test } from "vitest";

import { canonicalJsonBytes } from "./canonical-json.js";
import { bindingTermsCommitment, ceremonyEvidenceDigest, serializeCeremonyMessage } from "./ceremony.js";
import type { EoaCeremonyEvidence, SafeCeremonyEvidence, SiweCeremonyMessage } from "./ceremony.js";
import { dssePreAuthEncoding, parseDsseEnvelope, sealDsseEnvelope } from "./dsse.js";
import {
  TRUST_KEY_BINDING_FORMAT,
  TRUST_KEY_BINDING_MEDIA_TYPE,
  TRUST_REVOCATION_FORMAT,
  TRUST_REVOCATION_MEDIA_TYPE,
} from "./identifiers.js";
import type {
  BindingResolver,
  Eip1271Witness,
  ResolvedBinding,
  ResolvedRevocation,
  WitnessVerifier,
} from "./interfaces.js";
import type { KeyBinding } from "./key-binding.js";
import { sealKeyBinding, validateKeyBinding } from "./key-binding.js";
import type { DsseChainVerifier } from "./policy.js";
import { didPkh, toChecksumAddress } from "./spellings.js";
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
// A Safe ceremony (§7.2): the same profiled SIWE message an EOA signs, signed under EIP-1271,
// and a 1271 witness statement (§7.2a) saying which Safe, on which chain, accepted which hash.
// Nothing checks the Safe's own signature offline, so its bytes here are a placeholder.
// ---------------------------------------------------------------------------

const SAFE_ADDRESS = "0x5555555555555555555555555555555555555555";
const SAFE_VOUCHER_DID = didPkh(8453, SAFE_ADDRESS);
const WITNESS_IRI = "https://spec.jinn.network/agents/witness-fixture";

function safeCeremonyMessage(
  agent: string,
  didKey: string,
  overrides: Partial<SiweCeremonyMessage> = {},
): SiweCeremonyMessage {
  return {
    domain: "trust.jinn.network",
    address: toChecksumAddress(SAFE_ADDRESS),
    uri: "https://trust.jinn.network/ceremony/key-binding",
    version: "1",
    chainId: 8453,
    nonce: "n-safe-1",
    issuedAt: "2026-01-01T00:00:00Z",
    resources: [agent, didKey],
    ...overrides,
  };
}

function safeCeremonyEvidence(
  message: SiweCeremonyMessage,
  signedBytes: Uint8Array = serializeCeremonyMessage("safe", message),
): SafeCeremonyEvidence {
  return { type: "safe", message, messageBytes: signedBytes, signature: Uint8Array.of(0x5a) };
}

/** The hash a Safe's `isValidSignature` is asked about for a signed message: its EIP-191 digest. */
function personalSignHash(messageBytes: Uint8Array): string {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  return `0x${Buffer.from(keccak_256(new Uint8Array([...prefix, ...messageBytes]))).toString("hex")}`;
}

/** A 1271 witness statement that the voucher's Safe accepted `messageBytes`, unless `says` claims otherwise. */
function safeWitness(messageBytes: Uint8Array, says: Record<string, unknown> = {}): Eip1271Witness {
  const statement: Record<string, unknown> = {
    chainId: 8453,
    blockNumber: 1,
    blockHash: `0x${"c".repeat(64)}`,
    verifier: WITNESS_IRI,
    safe: SAFE_ADDRESS,
    hash: personalSignHash(messageBytes),
    signature: "0x5a",
    result: "0x1626ba7e",
    ...says,
  };
  return {
    chainId: statement["chainId"] as number,
    blockNumber: 1,
    blockHash: `0x${"c".repeat(64)}`,
    verifier: WITNESS_IRI,
    envelopeBytes: sealDsseEnvelope({
      payloadBytes: canonicalJsonBytes(statement),
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ signature: Uint8Array.of(1), keyid: "did:key:zWitnessFixture" }],
    }),
  };
}

/** `base`, vouched by the Safe instead, through a genuine ceremony and witness. */
function safeVouched(
  base: KeyBinding,
): { binding: KeyBinding; ceremonyEvidence: SafeCeremonyEvidence; witness: Eip1271Witness } {
  const ceremonyEvidence = safeCeremonyEvidence(safeCeremonyMessage(base.agent, base.key.didKey));
  const binding: KeyBinding = {
    ...base,
    voucher: { kind: "account", did: SAFE_VOUCHER_DID, contractAccount: true },
    ceremony: { type: "safe", digest: ceremonyEvidenceDigest(ceremonyEvidence) },
  };
  return { binding, ceremonyEvidence, witness: safeWitness(ceremonyEvidence.messageBytes) };
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

  test.each([
    ["the profile's domain and URI", {}, undefined],
    ["another domain", { domain: "login.example" }, /ceremony domain "login\.example"/],
    ["another URI", { uri: "https://trust.jinn.network/login" }, /ceremony URI "https:\/\/trust\.jinn\.network\/login"/],
  ])("a genuine EOA ceremony with %s, committed by its record (§7.2)", async (_label, overrides, refusal) => {
    // The secp256k1 secret key 1, a test value with no other use, signs the ceremony for real.
    const secretKey = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0));
    const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as const;
    const message: EoaCeremonyEvidence["message"] = { ...eoaFixture.message, address, ...overrides };
    const messageBytes = serializeCeremonyMessage("eoa", message);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
    const recovered = secp256k1.sign(keccak_256(Uint8Array.of(...prefix, ...messageBytes)), secretKey, {
      prehash: false,
      format: "recovered",
    });
    const evidence: EoaCeremonyEvidence = {
      type: "eoa",
      message,
      messageBytes,
      signature: Uint8Array.of(...recovered.slice(1), recovered[0]! + 27),
    };
    const binding = keyBinding({
      agent: eoaFixture.agentIri,
      key: { publicKey: "0x04", keyid: eoaFixture.didKey, algorithm: "secp256k1", didKey: eoaFixture.didKey },
      voucher: { kind: "account", did: didPkh(eoaFixture.voucherChainId, address), contractAccount: false },
      ceremony: { type: "eoa", digest: ceremonyEvidenceDigest(evidence) },
      scope: ["deliveries", "verdicts"],
    });
    const resolver = new FakeBindingResolver().register({
      key: eoaFixture.didKey,
      agent: eoaFixture.agentIri,
      resolved: resolvedBinding({ binding, ceremonyEvidence: evidence }),
    });

    const outcome = await verifyEnvelopeBinding(
      {
        envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, eoaFixture.didKey),
        key: eoaFixture.didKey,
        agent: eoaFixture.agentIri,
        family: "deliveries",
        atTime: "2026-03-01T00:00:00Z",
      },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    if (refusal === undefined) {
      expect(outcome).toMatchObject({ ok: true });
    } else {
      expect(outcome).toMatchObject({ ok: false, reason: "ceremony-verification-failed", detail: expect.stringMatching(refusal) });
    }
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

    // A row is told from another row filed under its digest by what it holds. One whose
    // contents cannot be written out cannot be told apart, so it stands for nothing.
    test("a genesis binding whose stored row cannot be written out has no chain", async () => {
      const resolver = new FakeBindingResolver().register({
        key: KEY_2,
        agent: AGENT,
        resolved: resolvedBinding({ binding: own, ceremonyEvidence: { written: 1n } as never }),
      });
      expect(await verifyKey2(resolver)).toMatchObject({
        ok: false,
        reason: "consent-chain-violation",
        detail: "the binding's stored row cannot be written out, so it cannot be told from another row.",
      });
    });

    test.each([
      { held: "can be written out", evidence: { written: "1" }, verdict: { ok: true } },
      { held: "cannot be written out", evidence: { written: 1n }, verdict: { ok: false, reason: "consent-chain-violation" } },
    ])("an incumbent whose stored row $held gives authority accordingly", async ({ evidence, verdict }) => {
      const resolver = new FakeBindingResolver()
        .register({
          key: KEY_2,
          agent: AGENT,
          resolved: resolvedBinding({ binding: own, isGenesis: false, incumbentControls: [{ key: CONSENT_KEY, voucher }] }),
        })
        .register({
          key: CONSENT_KEY,
          agent: AGENT,
          resolved: authorityBinding(peer, { ceremonyEvidence: evidence as never }),
        });
      expect(await verifyKey2(resolver)).toMatchObject(verdict);
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
    const entry = revocationEntry(KEY_2, "2026-02-01T00:00:00Z");
    const resolved = resolvedBinding({
      binding,
      envelopeBytes: sealedEnvelope(binding, TRUST_KEY_BINDING_MEDIA_TYPE, CONSENT_KEY),
      revocations: [{ ...entry, revocation: { ...entry.revocation, target: `sha256:${"b".repeat(64)}` } }],
    });
    const resolver = new FakeBindingResolver().register({ key: KEY_2, agent: AGENT, resolved });
    const envelopeBytes = sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2);

    const outcome = await verifyEnvelopeBinding(
      { envelopeBytes, key: KEY_2, agent: AGENT, family: "deliveries", atTime: "2026-03-01T00:00:00Z" },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
    expect(outcome).toMatchObject({ ok: false, reason: "revoked" });
  });

  describe("a key's own revocation draws on the record it names", () => {
    const named = (key: string, scope: KeyBinding["scope"]) => keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: key, algorithm: "ed25519", didKey: key },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      scope,
    });
    const verdictFor = (revocation: ResolvedRevocation) => {
      const resolved = resolvedBinding({ binding: named(KEY_2, ["deliveries"]), revocations: [revocation] });
      return verifyEnvelopeBinding(
        {
          envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: AGENT,
          family: "deliveries",
          atTime: "2026-03-01T00:00:00Z",
        },
        {
          bindingResolver: new FakeBindingResolver().register({ key: KEY_2, agent: AGENT, resolved }),
          witnessVerifier: fakeWitnessVerifier,
          dsseVerifier: trustingDsseVerifier,
        },
      );
    };
    const ownRevocation = revocationEntry(KEY_2, "2026-02-01T00:00:00Z");

    test("a named record that held bindings scope is enough, whatever answers for the key now", async () => {
      expect(await verdictFor({ ...ownRevocation, targetScope: ["deliveries", "bindings"] }))
        .toMatchObject({ ok: false, reason: "revoked" });
    });

    test("a named record that held no bindings scope gives the key nothing", async () => {
      expect(await verdictFor({ ...ownRevocation, targetScope: ["deliveries"] })).toMatchObject({ ok: true });
    });

    test("another key's revocation gets nothing from the named record's scope", async () => {
      expect(await verdictFor({ ...revocationEntry(CONSENT_KEY, "2026-02-01T00:00:00Z"), targetScope: ["bindings"] }))
        .toMatchObject({ ok: true });
    });

    test("a revocation naming another record does not count as the answering key giving up its own", async () => {
      const entry = revocationEntry(KEY_2, "2026-02-01T00:00:00Z");
      const resolved = resolvedBinding({
        binding: named(KEY_2, ["deliveries", "bindings"]),
        isGenesis: false,
        revocations: [entry],
      });
      const outcome = await checkBindingRevocation(resolved, "2026-03-01T00:00:00Z", {
        bindingResolver: new FakeBindingResolver().register({ key: KEY_2, agent: AGENT, resolved }),
        witnessVerifier: fakeWitnessVerifier,
        dsseVerifier: trustingDsseVerifier,
      });
      expect(outcome).toEqual({ ok: true });
    });
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
      const safeLeg = safeVouched(settlementBinding());
      const refusing: WitnessVerifier = { verify1271Witness: async () => ({ verified: false }) };
      expect(await joinWith(sealedLeg(safeLeg), refusing))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/settlement leg does not stand/) });
      expect(await joinWith(sealedLeg(safeLeg))).toMatchObject({ ok: true });
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
    const { binding: coldBinding, ceremonyEvidence, witness } = safeVouched(keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: COLD_KEY, algorithm: "ed25519", didKey: COLD_KEY },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: true },
      scope: ["bindings"],
    }));
    const coldResolver = new FakeBindingResolver().register({
      key: COLD_KEY,
      agent: AGENT,
      resolved: authorityBinding(coldBinding, { ceremonyEvidence, witness }),
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

  // A row that cannot be written out cannot be told from another row, so nothing shows it
  // unrevoked: not even the absence of a revocation, and not a revocation by its own key that
  // only the same-act path could read, as when the resolver reports no `targetScope`.
  describe("a row that cannot be written out", () => {
    const OWN_KEY = "did:key:z6MkfUNWRITTEN1111111111111111111111111111";
    const SETTLEMENT_KEY = "did:key:z6MkfUNWRITTENSETTLE11111111111111111111";
    const ownRevocation = revocationEntry(OWN_KEY, "2026-02-01T00:00:00Z");
    const unwritten = (revocations: readonly ResolvedRevocation[]) => resolvedBinding({
      binding: keyBinding({
        agent: AGENT,
        key: { publicKey: "0x00", keyid: OWN_KEY, algorithm: "ed25519", didKey: OWN_KEY },
        voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
        scope: ["verdicts", "bindings"],
      }),
      ceremonyEvidence: { written: 1n } as never,
      revocations,
    });
    const revokedByItsOwnKey = unwritten([
      { ...ownRevocation, revocation: { ...ownRevocation.revocation, target: `sha256:${"b".repeat(64)}` } },
    ]);
    const settlementLeg = authorityBinding(keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: SETTLEMENT_KEY, algorithm: "ed25519", didKey: SETTLEMENT_KEY },
      voucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false },
      scope: ["settlements"],
    }));
    const deps = {
      bindingResolver: new FakeBindingResolver()
        .register({ key: OWN_KEY, agent: AGENT, resolved: revokedByItsOwnKey })
        .register({ key: SETTLEMENT_KEY, agent: AGENT, resolved: settlementLeg }),
      witnessVerifier: fakeWitnessVerifier,
      dsseVerifier: trustingDsseVerifier,
    };

    test("is refused by checkBindingRevocation and as a verdict leg when its own key revoked it", async () => {
      expect(await checkBindingRevocation(revokedByItsOwnKey, "2026-03-01T00:00:00Z", deps)).toMatchObject({ ok: false });
      expect(await settlementJoinCheck(
        {
          verdictKey: OWN_KEY,
          settlementDeclarationKey: SETTLEMENT_KEY,
          claimedEvaluatorAgent: AGENT,
          family: "verdicts",
          envelopeEffectiveTime: "2026-03-01T00:00:00Z",
          claimTime: "2026-03-05T00:00:00Z",
        },
        deps,
      )).toMatchObject({ ok: false });
    });

    test("is refused by checkBindingRevocation with no revocation at all", async () => {
      expect(await checkBindingRevocation(unwritten([]), "2026-03-01T00:00:00Z", deps)).toMatchObject({ ok: false });
    });
  });

  // Each listed entry is judged on its own, whichever entries sit beside it. The answers below are
  // read through all three entry points, with the entry that carries the authority listed first
  // and last, so an answer kept for one entry and reused for another shows in one of the orders.
  describe("revocation entries listed together", () => {
    const VERDICT = "did:key:z6MkfMEMOVERDICT1111111111111111111111111";
    const SETTLEMENT = "did:key:z6MkfMEMOSETTLE11111111111111111111111111";
    const STRANGER = "did:key:z6MkfMEMOSTRANGER111111111111111111111111";
    const keys = signingKeys(VERDICT, SETTLEMENT, VOUCHER_DID, OTHER_VOUCHER_DID, STRANGER);
    const verdict = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: VERDICT, algorithm: "ed25519", didKey: VERDICT },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
      scope: ["verdicts"],
    });
    const settlement = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: SETTLEMENT, algorithm: "ed25519", didKey: SETTLEMENT },
      voucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false },
      scope: ["settlements"],
    });
    const base = revocationEntry(VOUCHER_DID, "2026-02-01T00:00:00Z");
    const sealedBy = (signedBy: string): Uint8Array =>
      keys.seal(base.revocation, TRUST_REVOCATION_MEDIA_TYPE, VOUCHER_DID, signedBy);

    async function verdicts(revocations: readonly ResolvedRevocation[]) {
      const resolved = resolvedBinding({
        binding: verdict,
        envelopeBytes: keys.seal(verdict, TRUST_KEY_BINDING_MEDIA_TYPE, VERDICT),
        revocations,
      });
      const deps = {
        bindingResolver: new FakeBindingResolver()
          .register({ key: VERDICT, agent: AGENT, resolved })
          .register({
            key: SETTLEMENT,
            agent: AGENT,
            resolved: authorityBinding(settlement, { envelopeBytes: keys.seal(settlement, TRUST_KEY_BINDING_MEDIA_TYPE, SETTLEMENT) }),
          }),
        witnessVerifier: fakeWitnessVerifier,
        dsseVerifier: keys.verifier,
      };
      return {
        revocation: await checkBindingRevocation(resolved, "2026-03-01T00:00:00Z", deps),
        envelope: await verifyEnvelopeBinding(
          {
            envelopeBytes: keys.seal({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, VERDICT),
            key: VERDICT,
            agent: AGENT,
            family: "verdicts",
            atTime: "2026-03-01T00:00:00Z",
          },
          deps,
        ),
        join: await settlementJoinCheck(
          {
            verdictKey: VERDICT,
            settlementDeclarationKey: SETTLEMENT,
            claimedEvaluatorAgent: AGENT,
            family: "verdicts",
            envelopeEffectiveTime: "2026-03-01T00:00:00Z",
            claimTime: "2026-03-05T00:00:00Z",
          },
          deps,
        ),
      };
    }

    const revokedBoth = async (listed: readonly ResolvedRevocation[]) => {
      const outcome = await verdicts(listed);
      expect(outcome.revocation).toMatchObject({ ok: false });
      expect(outcome.envelope).toMatchObject({ ok: false, reason: "revoked" });
      expect(outcome.join).toMatchObject({ ok: false, reason: expect.stringMatching(/verdict leg is revoked/) });
    };

    test("alike in all but the envelope, the one the voucher signed revokes whichever is listed first", async () => {
      const forged = { ...base, envelopeBytes: sealedBy(STRANGER) };
      const genuine = { ...base, envelopeBytes: sealedBy(VOUCHER_DID) };
      await revokedBoth([forged, genuine]);
      await revokedBoth([genuine, forged]);
    });

    test("unwritable entries, one with authority and one without, revoke whichever is listed first", async () => {
      // A bigint cannot be written out, so neither entry has a row of its own.
      const unwritable = (envelopeBytes: Uint8Array, revokedBy: string): ResolvedRevocation => ({
        ...base,
        revocation: { ...base.revocation, revokedBy, nonce: 1n } as never,
        envelopeBytes,
      });
      const withoutAuthority = unwritable(
        keys.seal({ ...base.revocation, revokedBy: OTHER_VOUCHER_DID }, TRUST_REVOCATION_MEDIA_TYPE, OTHER_VOUCHER_DID),
        OTHER_VOUCHER_DID,
      );
      const withAuthority = unwritable(sealedBy(VOUCHER_DID), VOUCHER_DID);
      await revokedBoth([withoutAuthority, withAuthority]);
      await revokedBoth([withAuthority, withoutAuthority]);
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

// ---------------------------------------------------------------------------
// The ceremony currency text (https://spec.jinn.network/profiles/ceremony-currency/v1)
// applies at step 3 only when the resolved binding carries the deployment's profile.
// ---------------------------------------------------------------------------

describe("verifyEnvelopeBinding under a ceremony currency profile", () => {
  async function verifyAt(effectiveStart: string, ceremonyCurrency?: ResolvedBinding["ceremonyCurrency"]) {
    const evidence = eoaCeremonyEvidence();
    const binding = keyBinding({
      agent: eoaFixture.agentIri,
      key: { publicKey: "0x04", keyid: eoaFixture.didKey, algorithm: "secp256k1", didKey: eoaFixture.didKey },
      voucher: { kind: "account", did: didPkh(eoaFixture.voucherChainId, eoaFixture.message.address), contractAccount: false },
      ceremony: { type: "eoa", digest: ceremonyEvidenceDigest(evidence) },
      validFrom: "2026-01-01T00:00:00Z",
    });
    const resolver = new FakeBindingResolver().register({
      key: eoaFixture.didKey,
      agent: eoaFixture.agentIri,
      resolved: resolvedBinding({
        binding,
        ceremonyEvidence: evidence,
        effectiveStart,
        ...(ceremonyCurrency === undefined ? {} : { ceremonyCurrency }),
      }),
    });
    return verifyEnvelopeBinding(
      {
        envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, eoaFixture.didKey),
        key: eoaFixture.didKey,
        agent: eoaFixture.agentIri,
        family: "deliveries",
        atTime: "2026-08-01T00:00:00Z",
      },
      { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier },
    );
  }

  test("with no profile, a binding that takes effect before its ceremony was issued verifies as before", async () => {
    expect(await verifyAt("2026-01-01T00:00:00Z")).toMatchObject({ ok: true });
  });

  test("with the profile, the same binding fails its ceremony", async () => {
    expect(await verifyAt("2026-01-01T00:00:00Z", {})).toMatchObject({
      ok: false,
      reason: "ceremony-verification-failed",
      detail: expect.stringMatching(/before the ceremony's issuedAt/),
    });
  });

  test("with the profile, a binding that takes effect within the ceremony's window verifies", async () => {
    expect(await verifyAt("2026-07-28T00:00:00Z", {})).toMatchObject({ ok: true });
  });

  test("with a terms cutover, an uncommitted ceremony fails from the cutover on", async () => {
    expect(await verifyAt("2026-07-28T00:00:00Z", { termsCutover: "2026-07-28T00:00:00Z" })).toMatchObject({
      ok: false,
      reason: "ceremony-verification-failed",
      detail: expect.stringMatching(/terms cutover/),
    });
  });
});

// ---------------------------------------------------------------------------
// The same text applies wherever the walk asks whether a binding gives authority: a revoker, an
// incumbent and a consenter each have to stand, and each stands only if its own ceremony meets the
// text. In every case below the authority's EOA ceremony fails the text only because its record
// took effect before the ceremony was issued, so the profile alone decides.
// ---------------------------------------------------------------------------

describe("authority under a ceremony currency profile", () => {
  const CURRENT = "2026-07-28T00:00:00Z";
  const STALE = "2026-01-01T00:00:00Z";
  const NOT_YET_REVOKED = "2026-09-01T00:00:00Z";
  const deps = (resolver: BindingResolver) => ({
    bindingResolver: resolver,
    witnessVerifier: fakeWitnessVerifier,
    dsseVerifier: trustingDsseVerifier,
  });

  /** A bindings-scoped authority whose EOA ceremony meets the text only from `CURRENT` on. */
  function eoaAuthority(effectiveStart: string, profile?: ResolvedBinding["ceremonyCurrency"], relationship: KeyBinding["relationship"] = "controls") {
    const evidence = eoaCeremonyEvidence();
    return authorityBinding(
      keyBinding({
        agent: eoaFixture.agentIri,
        key: { publicKey: "0x04", keyid: eoaFixture.didKey, algorithm: "secp256k1", didKey: eoaFixture.didKey },
        voucher: { kind: "account", did: didPkh(eoaFixture.voucherChainId, eoaFixture.message.address), contractAccount: false },
        ceremony: { type: "eoa", digest: ceremonyEvidenceDigest(evidence) },
        scope: ["bindings"],
        relationship,
      }),
      { ceremonyEvidence: evidence, effectiveStart, ...(profile === undefined ? {} : { ceremonyCurrency: profile }) },
    );
  }

  const successor = (extra: Partial<KeyBinding> = {}) => keyBinding({
    agent: eoaFixture.agentIri,
    key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
    voucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false },
    ...extra,
  });

  describe("a revocation signed by a sibling key", () => {
    const target = resolvedBinding({
      binding: successor(),
      revocations: [revocationEntry(eoaFixture.didKey, "2026-08-01T00:00:00Z")],
    });
    const revokedWith = async (effectiveStart: string, profile?: ResolvedBinding["ceremonyCurrency"]) => (
      await checkBindingRevocation(
        target,
        NOT_YET_REVOKED,
        deps(new FakeBindingResolver().register({ key: eoaFixture.didKey, agent: eoaFixture.agentIri, resolved: eoaAuthority(effectiveStart, profile) })),
      )
    ).ok;

    test("counts with the profile off, whatever the sibling's ceremony", async () => {
      expect(await revokedWith(STALE)).toBe(false);
    });

    test("does not count with the profile on when the sibling's own ceremony fails it", async () => {
      expect(await revokedWith(STALE, {})).toBe(true);
    });

    test("counts with the profile on when the sibling's own ceremony meets it", async () => {
      expect(await revokedWith(CURRENT, {})).toBe(false);
    });
  });

  describe("an incumbent that roots a self-extension", () => {
    const voucher = { kind: "account" as const, did: didPkh(eoaFixture.voucherChainId, eoaFixture.message.address), contractAccount: false };
    const standsWith = async (effectiveStart: string, profile?: ResolvedBinding["ceremonyCurrency"]) => {
      const candidate = resolvedBinding({
        binding: successor({ voucher }),
        isGenesis: false,
        effectiveStart: "2026-07-30T00:00:00Z",
        incumbentControls: [{ key: eoaFixture.didKey, voucher }],
      });
      const resolver = new FakeBindingResolver()
        .register({ key: KEY_2, agent: eoaFixture.agentIri, resolved: candidate })
        .register({ key: eoaFixture.didKey, agent: eoaFixture.agentIri, resolved: eoaAuthority(effectiveStart, profile) });
      return verifyEnvelopeBinding(
        {
          envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: eoaFixture.agentIri,
          family: "deliveries",
          atTime: "2026-08-01T00:00:00Z",
        },
        deps(resolver),
      );
    };

    test("roots it with the profile off, whatever the incumbent's ceremony", async () => {
      expect(await standsWith(STALE)).toMatchObject({ ok: true });
    });

    test("does not root it with the profile on when the incumbent's own ceremony fails it", async () => {
      expect(await standsWith(STALE, {})).toMatchObject({ ok: false, reason: "consent-chain-violation" });
    });

    test("roots it with the profile on when the incumbent's own ceremony meets it", async () => {
      expect(await standsWith(CURRENT, {})).toMatchObject({ ok: true });
    });
  });

  describe("a consent chain", () => {
    const standsWith = async (effectiveStart: string, profile?: ResolvedBinding["ceremonyCurrency"]) => {
      const candidate = resolvedBinding({
        binding: successor({ consent: { keyid: eoaFixture.didKey, sig: btoa("irrelevant-in-this-fake") } }),
        isGenesis: false,
        effectiveStart: "2026-07-30T00:00:00Z",
      });
      const resolver = new FakeBindingResolver()
        .register({ key: KEY_2, agent: eoaFixture.agentIri, resolved: candidate })
        .register({ key: eoaFixture.didKey, agent: eoaFixture.agentIri, resolved: eoaAuthority(effectiveStart, profile) });
      return verifyEnvelopeBinding(
        {
          envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: eoaFixture.agentIri,
          family: "deliveries",
          atTime: "2026-08-01T00:00:00Z",
        },
        deps(resolver),
      );
    };

    test("holds with the profile off, whatever the consenter's ceremony", async () => {
      expect(await standsWith(STALE)).toMatchObject({ ok: true });
    });

    test("fails with the profile on when the consenter's own ceremony fails it", async () => {
      expect(await standsWith(STALE, {})).toMatchObject({ ok: false, reason: "consent-chain-violation" });
    });

    test("holds with the profile on when the consenter's own ceremony meets it", async () => {
      expect(await standsWith(CURRENT, {})).toMatchObject({ ok: true });
    });
  });

  // One walk judges a row more than once. The row names neither the profile nor the effective start
  // it is read under, so the answer kept for it is kept under those too: an answer reached without
  // the profile is not the answer with it.
  test("a revoker row judged without the profile earlier in a walk is judged again when it carries one", async () => {
    const early = revocationEntry(eoaFixture.didKey, "2026-02-01T00:00:00Z");
    const late = revocationEntry(eoaFixture.didKey, "2026-08-01T00:00:00Z");
    const target = resolvedBinding({ binding: successor(), revocations: [early, late] });
    const unprofiled = eoaAuthority(STALE);
    const profiled = { ...unprofiled, ceremonyCurrency: {} };
    const resolver: BindingResolver = {
      resolveBinding: async (_query, atTime) => (atTime < "2026-06-01T00:00:00Z" ? profiled : unprofiled),
    };
    // The early entry reads the revoker with the profile and fails it; the late one reads the same
    // row without it and counts.
    expect((await checkBindingRevocation(target, NOT_YET_REVOKED, deps(resolver))).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A Safe ceremony's message is checked as an EOA ceremony's is (§7.2; ceremony currency §3 to §6).
// A 1271 witness says only that a Safe accepted a hash, so every case here runs under a witness
// verifier that accepts the witness: what decides it is the message that hash is of.
// ---------------------------------------------------------------------------

describe("a Safe ceremony's message (§7.2, §7.2a)", () => {
  const KEY = "did:key:z6MkfSAFEKEY111111111111111111111111111111";
  const OTHER_KEY = "did:key:z6MkfSAFEOTHER1111111111111111111111111111";
  const TERMS = { relationship: "controls", scope: ["deliveries"], validFrom: "2026-01-01T00:00:00Z" } as const;

  async function verifySafe(options: {
    readonly message?: SiweCeremonyMessage;
    readonly signedBytes?: Uint8Array;
    readonly witnessSays?: Record<string, unknown>;
    readonly witnessVerifier?: WitnessVerifier;
    readonly committed?: KeyBinding["ceremony"];
    readonly resolved?: Partial<ResolvedBinding>;
  } = {}) {
    const evidence = safeCeremonyEvidence(options.message ?? safeCeremonyMessage(AGENT, KEY), options.signedBytes);
    const binding = keyBinding({
      agent: AGENT,
      key: { publicKey: "0x04", keyid: KEY, algorithm: "ed25519", didKey: KEY },
      voucher: { kind: "account", did: SAFE_VOUCHER_DID, contractAccount: true },
      ceremony: options.committed ?? { type: "safe", digest: ceremonyEvidenceDigest(evidence) },
      validFrom: TERMS.validFrom,
    });
    const resolver = new FakeBindingResolver().register({
      key: KEY,
      agent: AGENT,
      resolved: resolvedBinding({
        binding,
        ceremonyEvidence: evidence,
        witness: safeWitness(evidence.messageBytes, options.witnessSays),
        ...options.resolved,
      }),
    });
    return verifyEnvelopeBinding(
      {
        envelopeBytes: sealedEnvelope({ hello: "world" }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY),
        key: KEY,
        agent: AGENT,
        family: "deliveries",
        atTime: "2026-03-01T00:00:00Z",
      },
      {
        bindingResolver: resolver,
        witnessVerifier: options.witnessVerifier ?? fakeWitnessVerifier,
        dsseVerifier: trustingDsseVerifier,
      },
    );
  }

  const refused = (detail: RegExp) => ({
    ok: false,
    reason: "ceremony-verification-failed",
    detail: expect.stringMatching(detail),
  });

  test("a genuine Safe ceremony verifies when the witness verifier accepts its witness", async () => {
    expect(await verifySafe()).toMatchObject({ ok: true });
  });

  test("a genuine Safe ceremony fails when the witness verifier refuses its witness", async () => {
    const refusing: WitnessVerifier = { verify1271Witness: async () => ({ verified: false, reason: "refused" }) };
    expect(await verifySafe({ witnessVerifier: refusing })).toMatchObject(refused(/refused/));
  });

  test.each([
    ["another Agent IRI", safeCeremonyMessage(OTHER_AGENT, KEY), /Agent IRI/],
    ["another key", safeCeremonyMessage(AGENT, OTHER_KEY), /did:key/],
    ["another domain", safeCeremonyMessage(AGENT, KEY, { domain: "login.example" }), /domain/],
    ["another URI", safeCeremonyMessage(AGENT, KEY, { uri: "https://trust.jinn.network/login" }), /URI/],
  ])("a message naming %s fails", async (_differsIn, message, detail) => {
    expect(await verifySafe({ message })).toMatchObject(refused(detail));
  });

  test("a message that is not the bytes the Safe signed fails", async () => {
    const signedBytes = serializeCeremonyMessage("safe", safeCeremonyMessage(OTHER_AGENT, KEY));
    expect(await verifySafe({ signedBytes })).toMatchObject(refused(/re-serialize/));
  });

  test("a witness over another message fails", async () => {
    const other = serializeCeremonyMessage("safe", safeCeremonyMessage(OTHER_AGENT, KEY));
    expect(await verifySafe({ witnessSays: { hash: personalSignHash(other) } })).toMatchObject(refused(/hash/));
  });

  test("a witness for another Safe fails", async () => {
    expect(await verifySafe({ witnessSays: { safe: "0x6666666666666666666666666666666666666666" } }))
      .toMatchObject(refused(/Safe/));
  });

  test("a witness on another chain fails", async () => {
    expect(await verifySafe({ witnessSays: { chainId: 1 } })).toMatchObject(refused(/chain/));
  });

  test("a witness statement that cannot be read fails", async () => {
    const unreadable = { ...safeWitness(new Uint8Array()), envelopeBytes: new TextEncoder().encode("not a statement") };
    expect(await verifySafe({ resolved: { witness: unreadable } })).toMatchObject(refused(/witness/));
  });

  test("a Safe ceremony with no message fails", async () => {
    expect(await verifySafe({ resolved: { ceremonyEvidence: undefined } })).toMatchObject(refused(/Safe ceremony evidence/));
  });

  test("a message the record does not commit to fails", async () => {
    expect(await verifySafe({ committed: { type: "safe", digest: `sha256:${"f".repeat(64)}` } }))
      .toMatchObject(refused(/ceremony evidence digest/));
  });

  test("the witness verifier is not asked about a ceremony whose message fails", async () => {
    let asked = 0;
    const counting: WitnessVerifier = { verify1271Witness: async () => ({ verified: (asked += 1) > 0 }) };
    expect(await verifySafe({ message: safeCeremonyMessage(OTHER_AGENT, KEY), witnessVerifier: counting }))
      .toMatchObject(refused(/Agent IRI/));
    expect(asked).toBe(0);
  });

  describe("under a ceremony currency profile", () => {
    test("with no profile, a binding that takes effect before the ceremony was issued verifies as before", async () => {
      expect(await verifySafe({ resolved: { effectiveStart: "2025-12-31T00:00:00Z" } })).toMatchObject({ ok: true });
    });

    test("with the profile, the same binding fails its ceremony", async () => {
      expect(await verifySafe({ resolved: { effectiveStart: "2025-12-31T00:00:00Z", ceremonyCurrency: {} } }))
        .toMatchObject(refused(/before the ceremony's issuedAt/));
    });

    test("with the profile, a ceremony committing to other terms fails", async () => {
      const message = safeCeremonyMessage(AGENT, KEY, {
        resources: [AGENT, KEY, bindingTermsCommitment({ ...TERMS, scope: ["deliveries", "bindings"] })],
      });
      expect(await verifySafe({ message, resolved: { ceremonyCurrency: {} } })).toMatchObject(refused(/commits to terms/));
    });

    test("with a terms cutover, an uncommitted ceremony fails and a committed one verifies", async () => {
      const ceremonyCurrency = { termsCutover: TERMS.validFrom };
      expect(await verifySafe({ resolved: { ceremonyCurrency } })).toMatchObject(refused(/terms cutover/));
      const message = safeCeremonyMessage(AGENT, KEY, { resources: [AGENT, KEY, bindingTermsCommitment(TERMS)] });
      expect(await verifySafe({ message, resolved: { ceremonyCurrency } })).toMatchObject({ ok: true });
    });
  });
});

// Key authority section 8: a voucher whose `contractAccount` is `true` cannot revoke, and a
// revocation whose `revokedBy` names one has no effect. Each case runs once with the voucher a
// contract account and once with it not, so the field alone decides.
describe("a contract account's revocation has no effect (key authority section 8)", () => {
  const GENESIS_KEY = "did:key:z6MkfCONTRACTGENESIS111111111111111111111";
  const LATER_KEY = "did:key:z6MkfCONTRACTLATER111111111111111111111111";
  const VERDICT_KEY = "did:key:z6MkfCONTRACTVERDICT11111111111111111111";
  const SETTLEMENT_KEY = "did:key:z6MkfCONTRACTSETTLE111111111111111111111";
  const ENVELOPE_TIME = "2026-03-01T00:00:00Z";
  const CLAIM_TIME = "2026-03-05T00:00:00Z";

  function accountBinding(key: string, contractAccount: boolean, scope: KeyBinding["scope"]): KeyBinding {
    return keyBinding({
      agent: AGENT,
      key: { publicKey: "0x00", keyid: key, algorithm: "ed25519", didKey: key },
      voucher: { kind: "account", did: VOUCHER_DID, contractAccount },
      scope,
    });
  }

  /** A binding that stands, with one revocation its voucher account signed. */
  function revokedByItsVoucher(binding: KeyBinding, effectiveTime: string): ResolvedBinding {
    return authorityBinding(binding, { revocations: [revocationEntry(VOUCHER_DID, effectiveTime)] });
  }

  function deps(resolver: BindingResolver) {
    return { bindingResolver: resolver, witnessVerifier: fakeWitnessVerifier, dsseVerifier: trustingDsseVerifier };
  }

  test.each([
    { contractAccount: true, ok: true },
    { contractAccount: false, ok: false },
  ])("checkBindingRevocation, contractAccount $contractAccount: ok is $ok", async ({ contractAccount, ok }) => {
    const resolved = revokedByItsVoucher(accountBinding(GENESIS_KEY, contractAccount, ["verdicts"]), "2026-02-01T00:00:00Z");
    expect((await checkBindingRevocation(resolved, ENVELOPE_TIME, deps(new FakeBindingResolver()))).ok).toBe(ok);
  });

  test.each([
    { contractAccount: true, expected: { ok: true } },
    { contractAccount: false, expected: { ok: false, reason: "revoked" } },
  ])("evidence verification, contractAccount $contractAccount", async ({ contractAccount, expected }) => {
    const resolver = new FakeBindingResolver().register({
      key: GENESIS_KEY,
      agent: AGENT,
      resolved: revokedByItsVoucher(accountBinding(GENESIS_KEY, contractAccount, ["verdicts"]), "2026-02-01T00:00:00Z"),
    });
    const outcome = await verifyEnvelopeBinding(
      {
        envelopeBytes: sealedEnvelope({ verdict: true }, TRUST_KEY_BINDING_MEDIA_TYPE, GENESIS_KEY),
        key: GENESIS_KEY,
        agent: AGENT,
        family: "verdicts",
        atTime: ENVELOPE_TIME,
      },
      deps(resolver),
    );
    expect(outcome).toMatchObject(expected);
  });

  test.each([
    { leg: "verdict", contractAccount: true, ok: true },
    { leg: "verdict", contractAccount: false, ok: false },
    { leg: "settlement", contractAccount: true, ok: true },
    { leg: "settlement", contractAccount: false, ok: false },
  ])("the settlement join, a $leg leg with contractAccount $contractAccount: ok is $ok", async ({ leg, contractAccount, ok }) => {
    const verdict = accountBinding(VERDICT_KEY, contractAccount, ["verdicts"]);
    const settlement = accountBinding(SETTLEMENT_KEY, contractAccount, ["settlements"]);
    const resolver = new FakeBindingResolver()
      .register({
        key: VERDICT_KEY,
        agent: AGENT,
        // Before the envelope's time, so the verdict leg's own check reads it.
        resolved: leg === "verdict" ? revokedByItsVoucher(verdict, "2026-02-01T00:00:00Z") : authorityBinding(verdict),
      })
      .register({
        key: SETTLEMENT_KEY,
        agent: AGENT,
        // Between the envelope's time and the claim, so the claim-time check reads it.
        resolved: leg === "settlement" ? revokedByItsVoucher(settlement, "2026-03-02T00:00:00Z") : authorityBinding(settlement),
      });
    const outcome = await settlementJoinCheck(
      {
        verdictKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimedEvaluatorAgent: AGENT,
        family: "verdicts",
        envelopeEffectiveTime: ENVELOPE_TIME,
        claimTime: CLAIM_TIME,
      },
      deps(resolver),
    );
    expect(outcome.ok).toBe(ok);
  });

  // Section 7: only the founding account's own revocation ends self-extension from the genesis
  // binding, and a voucher that cannot revoke leaves only the window to end it.
  test.each([
    { contractAccount: true, expected: { ok: true } },
    { contractAccount: false, expected: { ok: false, reason: "consent-chain-violation" } },
  ])("the founding account's rule, contractAccount $contractAccount", async ({ contractAccount, expected }) => {
    const genesis = revokedByItsVoucher(accountBinding(GENESIS_KEY, contractAccount, ["verdicts", "bindings"]), "2026-02-01T00:00:00Z");
    const later = resolvedBinding({
      binding: accountBinding(LATER_KEY, contractAccount, ["verdicts"]),
      bindingDigest: `sha256:${"f".repeat(64)}`,
      effectiveStart: ENVELOPE_TIME,
      isGenesis: false,
      incumbentControls: [{ key: GENESIS_KEY, voucher: { kind: "account", did: VOUCHER_DID, contractAccount } }],
    });
    const resolver = new FakeBindingResolver()
      .register({ key: GENESIS_KEY, agent: AGENT, resolved: genesis })
      .register({ key: LATER_KEY, agent: AGENT, resolved: later });
    const outcome = await verifyEnvelopeBinding(
      {
        envelopeBytes: sealedEnvelope({ verdict: true }, TRUST_KEY_BINDING_MEDIA_TYPE, LATER_KEY),
        key: LATER_KEY,
        agent: AGENT,
        family: "verdicts",
        atTime: CLAIM_TIME,
      },
      deps(resolver),
    );
    expect(outcome).toMatchObject(expected);
  });
});

// Key authority section 3: every rule judges an entry, not a digest, and nothing decided for one
// entry is decided for another. A resolver can list two revocations with one envelope that differ
// in what it hands over: their fields, the effective time it read for them, or the scope of the
// record they name. Section 8 asks of each whether it is authorized, so an entry with no authority
// takes nothing from one that has it, and the verdict is the same in either listed order.
describe("two revocations with one envelope are each judged on their own (key authority sections 3 and 8)", () => {
  const ENVELOPE_TIME = "2026-03-01T00:00:00Z";
  const CLAIM_TIME = "2026-03-05T00:00:00Z";
  const SETTLEMENT_KEY = "did:key:z6MkfSHAREDSETTLE1111111111111111111111";
  const REVOKED_DIGEST = `sha256:${"b".repeat(64)}` as const;

  // KEY_2's genesis binding, holding `bindings` scope. Its envelope is not KEY_2's, so it cannot
  // stand as an authority: KEY_2 revokes it only by giving up this record, or one that held
  // `bindings` scope.
  const revokedBinding = keyBinding({
    agent: AGENT,
    key: { publicKey: "0x00", keyid: KEY_2, algorithm: "ed25519", didKey: KEY_2 },
    voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    scope: ["verdicts", "bindings"],
  });
  // A key of the Agent that stands from 2025-12-01 with `bindings` scope.
  const revoker = authorityBinding(keyBinding({
    agent: AGENT,
    key: { publicKey: "0x00", keyid: CONSENT_KEY, algorithm: "ed25519", didKey: CONSENT_KEY },
    voucher: { kind: "account", did: VOUCHER_DID, contractAccount: false },
    scope: ["bindings"],
  }));
  const settlementLeg = authorityBinding(keyBinding({
    agent: AGENT,
    key: { publicKey: "0x00", keyid: SETTLEMENT_KEY, algorithm: "ed25519", didKey: SETTLEMENT_KEY },
    voucher: { kind: "account", did: OTHER_VOUCHER_DID, contractAccount: false },
    scope: ["settlements"],
  }));

  function over(revocations: readonly ResolvedRevocation[]) {
    const resolved = resolvedBinding({
      binding: revokedBinding,
      envelopeBytes: sealedEnvelope(revokedBinding, TRUST_KEY_BINDING_MEDIA_TYPE, CONSENT_KEY),
      bindingDigest: REVOKED_DIGEST,
      revocations,
    });
    const deps = {
      bindingResolver: new FakeBindingResolver()
        .register({ key: KEY_2, agent: AGENT, resolved })
        .register({ key: CONSENT_KEY, agent: AGENT, resolved: revoker })
        .register({ key: SETTLEMENT_KEY, agent: AGENT, resolved: settlementLeg }),
      witnessVerifier: fakeWitnessVerifier,
      dsseVerifier: trustingDsseVerifier,
    };
    return {
      checkBindingRevocation: async () => (await checkBindingRevocation(resolved, ENVELOPE_TIME, deps)).ok,
      verifyEnvelopeBinding: async () => (await verifyEnvelopeBinding(
        {
          envelopeBytes: sealedEnvelope({ verdict: true }, TRUST_KEY_BINDING_MEDIA_TYPE, KEY_2),
          key: KEY_2,
          agent: AGENT,
          family: "verdicts",
          atTime: ENVELOPE_TIME,
        },
        deps,
      )).ok,
      settlementJoinCheck: async () => (await settlementJoinCheck(
        {
          verdictKey: KEY_2,
          settlementDeclarationKey: SETTLEMENT_KEY,
          claimedEvaluatorAgent: AGENT,
          family: "verdicts",
          envelopeEffectiveTime: ENVELOPE_TIME,
          claimTime: CLAIM_TIME,
        },
        deps,
      )).ok,
    };
  }
  const entryPoints = ["checkBindingRevocation", "verifyEnvelopeBinding", "settlementJoinCheck"] as const;

  interface Variation {
    readonly differsIn: string;
    /** Whose signatures the one envelope carries. Its payload is the authorized entry's fields. */
    readonly signers: readonly string[];
    readonly authorized: ResolvedRevocation;
    readonly unauthorized: ResolvedRevocation;
  }
  const byVoucher = revocationEntry(VOUCHER_DID, "2026-02-01T00:00:00Z");
  const byItsKey = revocationEntry(KEY_2, "2026-02-01T00:00:00Z");
  const byRevoker = revocationEntry(CONSENT_KEY, "2026-02-01T00:00:00Z");
  const variations: readonly Variation[] = [
    {
      differsIn: "revokedBy",
      signers: [OTHER_VOUCHER_DID, VOUCHER_DID],
      authorized: byVoucher,
      unauthorized: { ...byVoucher, revocation: { ...byVoucher.revocation, revokedBy: OTHER_VOUCHER_DID } },
    },
    {
      differsIn: "target",
      signers: [KEY_2],
      authorized: { ...byItsKey, revocation: { ...byItsKey.revocation, target: REVOKED_DIGEST } },
      unauthorized: byItsKey,
    },
    {
      // Before the revoker's binding took effect, so nothing resolves for it then.
      differsIn: "effectiveTime",
      signers: [CONSENT_KEY],
      authorized: byRevoker,
      unauthorized: { ...byRevoker, effectiveTime: "2025-11-01T00:00:00Z" },
    },
    {
      differsIn: "targetScope",
      signers: [KEY_2],
      authorized: { ...byItsKey, targetScope: ["verdicts", "bindings"] },
      unauthorized: { ...byItsKey, targetScope: ["verdicts"] },
    },
  ];

  function oneEnvelope({ authorized, signers }: Variation): Uint8Array {
    const [first, ...rest] = signers.map((keyid) => ({ signature: new Uint8Array([1, 2, 3]), keyid }));
    return sealDsseEnvelope({
      payloadBytes: canonicalJsonBytes(authorized.revocation),
      payloadType: TRUST_REVOCATION_MEDIA_TYPE,
      signatures: [first!, ...rest],
    });
  }

  describe.each(variations)("differing in $differsIn", (variation) => {
    const envelopeBytes = oneEnvelope(variation);
    const counts = { ...variation.authorized, envelopeBytes };
    const doesNot = { ...variation.unauthorized, envelopeBytes };

    test.each(entryPoints)("%s finds the binding revoked in either listed order", async (entryPoint) => {
      expect(await over([doesNot, counts])[entryPoint]()).toBe(false);
      expect(await over([counts, doesNot])[entryPoint]()).toBe(false);
    });

    test.each(entryPoints)("%s finds it unrevoked by the entry with no authority alone", async (entryPoint) => {
      expect(await over([doesNot])[entryPoint]()).toBe(true);
    });
  });

  test("an entry that cannot be written out is still judged on its own", async () => {
    const variation = variations[0]!;
    const envelopeBytes = oneEnvelope(variation);
    const unwritten = (entry: ResolvedRevocation): ResolvedRevocation =>
      ({ ...entry, envelopeBytes, revocation: { ...entry.revocation, note: 1n } });
    const counts = { ...variation.authorized, envelopeBytes };
    const doesNot = { ...variation.unauthorized, envelopeBytes };
    for (const revocations of [[doesNot, unwritten(variation.authorized)], [unwritten(variation.unauthorized), counts]]) {
      expect(await over(revocations).checkBindingRevocation()).toBe(false);
      expect(await over([...revocations].reverse()).checkBindingRevocation()).toBe(false);
    }
    expect(await over([unwritten(variation.unauthorized)]).checkBindingRevocation()).toBe(true);
  });
});
