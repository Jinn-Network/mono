// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, test } from "vitest";

import type { AuthorizationStatement } from "./authorization.js";
import {
  matchCeremonyContent,
  recoverEip191Address,
  serializeCeremonyMessage,
  verifyEoaCeremony,
  verifyReCapCeremony,
} from "./ceremony.js";
import type { EoaCeremonyEvidence, ReCapCeremonyEvidence, SiweCeremonyMessage } from "./ceremony.js";
import type { KeyBinding } from "./key-binding.js";
import { didPkh } from "./spellings.js";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function loadFixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`../fixtures/ceremony-v1/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const eoaFixture = loadFixture("eoa-siwe.json") as {
  message: EoaCeremonyEvidence["message"];
  messageBytesHex: string;
  signatureHex: string;
  voucherChainId: number;
  agentIri: string;
  otherAgentIri: string;
  didKey: string;
};

const recapFixture = loadFixture("recap.json") as {
  message: ReCapCeremonyEvidence["message"];
  messageBytesHex: string;
  signatureHex: string;
  capabilities: readonly string[];
  narrowerCapabilities: readonly string[];
  mismatchedCapabilities: readonly string[];
};

function eoaCeremony(): EoaCeremonyEvidence {
  return {
    type: "eoa",
    message: eoaFixture.message,
    messageBytes: hexToBytes(eoaFixture.messageBytesHex),
    signature: hexToBytes(eoaFixture.signatureHex),
  };
}

function recapCeremony(): ReCapCeremonyEvidence {
  return {
    type: "recap",
    message: recapFixture.message,
    messageBytes: hexToBytes(recapFixture.messageBytesHex),
    signature: hexToBytes(recapFixture.signatureHex),
  };
}

function keyBindingFor(agent: string): KeyBinding {
  return {
    protocol: "https://spec.jinn.network/trust/key-binding/v1",
    agent,
    key: {
      publicKey: "0x04abcdef",
      keyid: eoaFixture.didKey,
      algorithm: "secp256k1",
      didKey: eoaFixture.didKey,
    },
    voucher: {
      kind: "account",
      did: didPkh(eoaFixture.voucherChainId, eoaFixture.message.address),
      contractAccount: false,
    },
    relationship: "controls",
    scope: ["deliveries"],
    validFrom: "2026-07-28T00:00:00Z",
    ceremony: {
      type: "eoa",
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    strength: "strong",
    anchors: [],
  };
}

function authorizationStatementFor(capabilities: readonly string[]): AuthorizationStatement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "input-digest", digest: { sha256: "c".repeat(64) } }],
    predicateType: "https://spec.jinn.network/trust/authorization/v1",
    predicate: {
      issuer: eoaFixture.agentIri,
      capabilities: [...capabilities],
      expiry: "2026-08-01T00:00:00Z",
      nonce: "n-1",
    },
  };
}

describe("recoverEip191Address", () => {
  test("recovers the signing address from message bytes + signature", () => {
    const ceremony = eoaCeremony();
    expect(recoverEip191Address(ceremony.messageBytes, ceremony.signature)).toBe(
      eoaFixture.message.address,
    );
  });

  test("rejects a malformed signature length", () => {
    expect(() => recoverEip191Address(new Uint8Array(10), new Uint8Array(64))).toThrow();
  });

  test("a tampered message recovers to a different address than the genuine signer", () => {
    const ceremony = eoaCeremony();
    const tampered = new TextEncoder().encode("this was never signed");
    expect(recoverEip191Address(tampered, ceremony.signature)).not.toBe(
      eoaFixture.message.address,
    );
  });
});

describe("matchCeremonyContent (§7.2 mandatory content match)", () => {
  test("a matching EOA ceremony passes", () => {
    const result = matchCeremonyContent(eoaCeremony(), keyBindingFor(eoaFixture.agentIri));
    expect(result.matches).toBe(true);
  });

  test("a genuine ceremony whose resources name IRI-X fails to bind a record claiming IRI-Y (lifted-ceremony content mismatch)", () => {
    const result = matchCeremonyContent(eoaCeremony(), keyBindingFor(eoaFixture.otherAgentIri));
    expect(result.matches).toBe(false);
    expect(result.mismatch).toMatch(/Agent IRI/);
  });

  test("a matching ReCap ceremony passes", () => {
    const result = matchCeremonyContent(
      recapCeremony(),
      authorizationStatementFor(recapFixture.capabilities),
    );
    expect(result.matches).toBe(true);
  });

  test("a ReCap ceremony whose transcribed capabilities differ from the statement fails", () => {
    const result = matchCeremonyContent(
      recapCeremony(),
      authorizationStatementFor(recapFixture.mismatchedCapabilities),
    );
    expect(result.matches).toBe(false);
    expect(result.mismatch).toMatch(/capabilities/);
  });

  test("a ReCap ceremony transcribing a narrower capability set than the statement fails (not a subset check -- exact content match)", () => {
    const result = matchCeremonyContent(
      recapCeremony(),
      authorizationStatementFor(recapFixture.narrowerCapabilities),
    );
    expect(result.matches).toBe(false);
  });

  // -------------------------------------------------------------------------
  // §7.2 mandatory content match MUST bind to the signed bytes, not just to
  // whatever `message` claims (blocker finding): a structured `message`
  // that disagrees with `messageBytes` must never reach the field-for-field
  // comparison below, and a genuine signature over one message must never
  // content-match a fabricated `message` describing a different one.
  // -------------------------------------------------------------------------

  test("(a) EOA: a structured message that disagrees with the signed messageBytes fails before any message.* field is trusted", () => {
    const genuine = eoaCeremony();
    const tampered: EoaCeremonyEvidence = {
      ...genuine,
      message: { ...genuine.message, nonce: "tampered-nonce-not-in-messageBytes" },
    };
    const result = matchCeremonyContent(tampered, keyBindingFor(eoaFixture.agentIri));
    expect(result.matches).toBe(false);
    expect(result.mismatch).toMatch(/messageBytes/);
  });

  test("(b) EOA: a genuine signature by voucher V over a DIFFERENT message, paired with a fabricated message claiming a binding for an attacker's (key, agent), fails (forged-binding attempt)", () => {
    const genuine = eoaCeremony();
    // The attacker keeps V's genuine messageBytes + signature (signed over
    // the ORIGINAL message naming eoaFixture.agentIri) but swaps in a
    // fabricated `message` whose resources claim a binding for a different
    // Agent IRI -- the record they actually want to forge.
    const forged: EoaCeremonyEvidence = {
      type: "eoa",
      message: { ...genuine.message, resources: [eoaFixture.otherAgentIri, eoaFixture.didKey] },
      messageBytes: genuine.messageBytes,
      signature: genuine.signature,
    };
    const contentResult = matchCeremonyContent(forged, keyBindingFor(eoaFixture.otherAgentIri));
    expect(contentResult.matches).toBe(false);

    const verifyResult = verifyEoaCeremony(forged, keyBindingFor(eoaFixture.otherAgentIri));
    expect(verifyResult.verified).toBe(false);
  });

  test("(a) ReCap: a structured message that disagrees with the signed messageBytes fails before any message.* field is trusted", () => {
    const genuine = recapCeremony();
    const tampered: ReCapCeremonyEvidence = {
      ...genuine,
      message: { ...genuine.message, nonce: "tampered-nonce-not-in-messageBytes" },
    };
    const result = matchCeremonyContent(tampered, authorizationStatementFor(recapFixture.capabilities));
    expect(result.matches).toBe(false);
    expect(result.mismatch).toMatch(/messageBytes/);
  });

  test("(b) ReCap: a genuine signature over a DIFFERENT message, paired with a fabricated message claiming wider capabilities, fails (forged-authorization attempt)", () => {
    const genuine = recapCeremony();
    const forged: ReCapCeremonyEvidence = {
      type: "recap",
      message: { ...genuine.message, resources: recapFixture.mismatchedCapabilities },
      messageBytes: genuine.messageBytes,
      signature: genuine.signature,
    };
    const contentResult = matchCeremonyContent(
      forged,
      authorizationStatementFor(recapFixture.mismatchedCapabilities),
    );
    expect(contentResult.matches).toBe(false);

    const verifyResult = verifyReCapCeremony(forged, authorizationStatementFor(recapFixture.mismatchedCapabilities));
    expect(verifyResult.verified).toBe(false);
  });
});

describe("verifyEoaCeremony (§7.5 step 3 offline EOA leg)", () => {
  test("a genuine, matching ceremony verifies", () => {
    const result = verifyEoaCeremony(eoaCeremony(), keyBindingFor(eoaFixture.agentIri));
    expect(result.verified).toBe(true);
    expect(result.recoveredAddress).toBe(eoaFixture.message.address);
  });

  test("a genuine ceremony lifted onto a binding for a different Agent IRI fails (binds nothing)", () => {
    const result = verifyEoaCeremony(eoaCeremony(), keyBindingFor(eoaFixture.otherAgentIri));
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/Agent IRI/);
  });

  test("a binding whose voucher is not an EOA account identity is rejected", () => {
    const binding = {
      ...keyBindingFor(eoaFixture.agentIri),
      voucher: { kind: "github-human" as const, profile: "https://github.com/octocat", id: 1 },
    };
    const result = verifyEoaCeremony(eoaCeremony(), binding);
    expect(result.verified).toBe(false);
  });

  test("a binding accepted on envelope signature alone (no genuine ceremony at all) is not how this function is satisfied -- a fabricated signature fails recovery-consistency", () => {
    const ceremony = eoaCeremony();
    const forged = { ...ceremony, signature: new Uint8Array(65) };
    const result = verifyEoaCeremony(forged, keyBindingFor(eoaFixture.agentIri));
    expect(result.verified).toBe(false);
  });
});

describe("verifyReCapCeremony", () => {
  test("a genuine, self-consistent, matching ceremony verifies", () => {
    const result = verifyReCapCeremony(
      recapCeremony(),
      authorizationStatementFor(recapFixture.capabilities),
    );
    expect(result.verified).toBe(true);
    expect(result.recoveredAddress).toBe(recapFixture.message.address);
  });

  test("a ceremony whose declared message.address does not match the recovered signer fails", () => {
    const ceremony = { ...recapCeremony(), message: { ...recapFixture.message, address: eoaFixture.message.address } };
    const result = verifyReCapCeremony(ceremony, authorizationStatementFor(recapFixture.capabilities));
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/declared message address/);
  });

  test("capability content mismatch fails even with a genuine signature", () => {
    const result = verifyReCapCeremony(
      recapCeremony(),
      authorizationStatementFor(recapFixture.mismatchedCapabilities),
    );
    expect(result.verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §7.2 pins a dedicated ceremony `domain` and `uri`. EIP-4361 has the wallet
// compare `domain` with the site that asks for the signature, so these two
// fields are what tie a signature to the place and purpose it was asked for.
// Every ceremony below is genuine: the signature recovers to the voucher, the
// message bytes are the serialized message, and the content matches. Only the
// domain or the URI differs from the profile's.
// ---------------------------------------------------------------------------

/** The secp256k1 secret key 1, a test value with no other use. */
const TEST_SECRET_KEY = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0));
const TEST_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as const;
const PROFILE_DOMAIN = "trust.jinn.network";
const KEY_BINDING_URI = "https://trust.jinn.network/ceremony/key-binding";
const AUTHORIZATION_URI = "https://trust.jinn.network/ceremony/authorization";

/** EIP-191 `personal_sign` by the test key, as `r || s || v`. */
function signEip191(messageBytes: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const digest = keccak_256(Uint8Array.of(...prefix, ...messageBytes));
  const recovered = secp256k1.sign(digest, TEST_SECRET_KEY, { prehash: false, format: "recovered" });
  return Uint8Array.of(...recovered.slice(1), recovered[0]! + 27);
}

function signedMessage(type: "eoa" | "recap", overrides: Partial<SiweCeremonyMessage>) {
  const message: SiweCeremonyMessage = {
    domain: PROFILE_DOMAIN,
    address: TEST_ADDRESS,
    uri: type === "eoa" ? KEY_BINDING_URI : AUTHORIZATION_URI,
    version: "1",
    chainId: 8453,
    nonce: "domain-and-uri-1",
    issuedAt: "2026-07-28T00:00:00Z",
    resources: type === "eoa" ? [eoaFixture.agentIri, eoaFixture.didKey] : [...recapFixture.capabilities],
    ...overrides,
  };
  const messageBytes = serializeCeremonyMessage(type, message);
  return { message, messageBytes, signature: signEip191(messageBytes) };
}

function signedEoaCeremony(overrides: Partial<SiweCeremonyMessage> = {}): EoaCeremonyEvidence {
  return { type: "eoa", ...signedMessage("eoa", overrides) };
}

function signedReCapCeremony(overrides: Partial<SiweCeremonyMessage> = {}): ReCapCeremonyEvidence {
  return { type: "recap", ...signedMessage("recap", overrides) };
}

function bindingVouchedByTestKey(): KeyBinding {
  return {
    ...keyBindingFor(eoaFixture.agentIri),
    voucher: { kind: "account", did: didPkh(8453, TEST_ADDRESS), contractAccount: false },
  };
}

describe("the profile's ceremony domain and URI (§7.2)", () => {
  test("a genuine ceremony with the profile's domain and URI verifies", () => {
    const eoa = verifyEoaCeremony(signedEoaCeremony(), bindingVouchedByTestKey());
    expect(eoa).toEqual({ verified: true, recoveredAddress: TEST_ADDRESS });
    const recap = verifyReCapCeremony(signedReCapCeremony(), authorizationStatementFor(recapFixture.capabilities));
    expect(recap).toEqual({ verified: true, recoveredAddress: TEST_ADDRESS });
  });

  test("the repository's sealed ceremonies still verify", () => {
    expect(verifyEoaCeremony(eoaCeremony(), keyBindingFor(eoaFixture.agentIri)).verified).toBe(true);
    expect(verifyReCapCeremony(recapCeremony(), authorizationStatementFor(recapFixture.capabilities)).verified)
      .toBe(true);
  });

  test.each([
    ["another domain", { domain: "login.example" }, /domain "login\.example"/],
    ["the domain in upper case", { domain: "TRUST.JINN.NETWORK" }, /domain "TRUST\.JINN\.NETWORK"/],
    ["the domain with a port", { domain: "trust.jinn.network:443" }, /domain "trust\.jinn\.network:443"/],
    ["another URI", { uri: "https://trust.jinn.network/login" }, /URI "https:\/\/trust\.jinn\.network\/login"/],
    ["the authorization URI", { uri: AUTHORIZATION_URI }, /URI "https:\/\/trust\.jinn\.network\/ceremony\/authorization"/],
  ])("a genuine key-binding ceremony with %s binds nothing", (_label, overrides, reason) => {
    const ceremony = signedEoaCeremony(overrides);
    const binding = bindingVouchedByTestKey();
    expect(matchCeremonyContent(ceremony, binding)).toEqual({ matches: false, mismatch: expect.stringMatching(reason) });
    expect(verifyEoaCeremony(ceremony, binding)).toEqual({
      verified: false,
      recoveredAddress: TEST_ADDRESS,
      reason: expect.stringMatching(reason),
    });
  });

  test.each([
    ["another domain", { domain: "login.example" }, /domain "login\.example"/],
    ["the key-binding URI", { uri: KEY_BINDING_URI }, /URI "https:\/\/trust\.jinn\.network\/ceremony\/key-binding"/],
  ])("a genuine authorization ceremony with %s authorizes nothing", (_label, overrides, reason) => {
    const ceremony = signedReCapCeremony(overrides);
    const statement = authorizationStatementFor(recapFixture.capabilities);
    expect(matchCeremonyContent(ceremony, statement)).toEqual({ matches: false, mismatch: expect.stringMatching(reason) });
    expect(verifyReCapCeremony(ceremony, statement)).toEqual({
      verified: false,
      recoveredAddress: TEST_ADDRESS,
      reason: expect.stringMatching(reason),
    });
  });
});
