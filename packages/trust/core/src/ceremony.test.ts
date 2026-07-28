// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { AuthorizationStatement } from "./authorization.js";
import {
  matchCeremonyContent,
  recoverEip191Address,
  verifyEoaCeremony,
  verifyReCapCeremony,
} from "./ceremony.js";
import type { EoaCeremonyEvidence, ReCapCeremonyEvidence } from "./ceremony.js";
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
    protocol: "https://jinn.network/trust/key-binding/v1",
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
    predicateType: "https://jinn.network/trust/authorization/v1",
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
