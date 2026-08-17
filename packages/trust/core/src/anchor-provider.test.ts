import { describe, expect, test } from "vitest";

import {
  ANCHOR_PROOF_STATUSES,
  ANCHOR_TIME_BASES,
  ANCHOR_VERIFICATION_POSTURES,
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
} from "./anchor-provider.js";
import type {
  AnchorCertificateFacts,
  AnchorChainVerifier,
  AnchorClass,
  AnchorProofResult,
  AnchorProofVerifier,
  AnchorSignatureVerifier,
  AnchorSignerIdentifier,
} from "./anchor-provider.js";

interface Rfc3161Facts {
  readonly genTime: string;
  readonly policyOid: string;
  readonly serialNumber: string;
  readonly signerCertificateSha256: string;
  readonly signatureAlgorithmOid: string;
}

describe("the tier-1 anchor provider contract (design §4.3)", () => {
  test("pins the provider profile URIs", () => {
    expect(RFC3161_TSA_ANCHOR_PROFILE)
      .toBe("https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1");
    expect(OPENTIMESTAMPS_ANCHOR_PROFILE)
      .toBe("https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1");
  });

  test("enumerates exactly the four proof statuses, two bases, and three postures", () => {
    expect([...ANCHOR_PROOF_STATUSES]).toEqual(["verified", "present", "pending", "invalid"]);
    expect([...ANCHOR_TIME_BASES]).toEqual(["authority-time", "chain-time"]);
    expect([...ANCHOR_VERIFICATION_POSTURES]).toEqual([
      "offline-from-artifact",
      "offline-with-external-data",
      "lookup-only",
    ]);
  });

  test("discriminates a result union on status, carrying the per-status fields", () => {
    const facts: Rfc3161Facts = {
      genTime: "2026-08-17T12:00:00Z",
      policyOid: "1.2.3.4",
      serialNumber: "0a0b",
      signerCertificateSha256: "0".repeat(64),
      signatureAlgorithmOid: "1.2.840.113549.1.1.11",
    };
    const results: readonly AnchorProofResult<Rfc3161Facts>[] = [
      {
        status: "verified",
        profile: RFC3161_TSA_ANCHOR_PROFILE,
        timeBasis: "authority-time",
        time: "2026-08-17T12:00:00Z",
        facts,
      },
      {
        status: "present",
        profile: RFC3161_TSA_ANCHOR_PROFILE,
        timeBasis: "authority-time",
        facts,
      },
      {
        status: "pending",
        profile: OPENTIMESTAMPS_ANCHOR_PROFILE,
        timeBasis: "authority-time",
        reason: "calendar promise only",
      },
      { status: "invalid", profile: RFC3161_TSA_ANCHOR_PROFILE, reason: "signature failed" },
    ];

    const described = results.map((result) => {
      switch (result.status) {
        case "verified":
          return `${result.time}/${result.facts.policyOid}`;
        case "present":
          return `${result.timeBasis}/${result.facts.genTime}`;
        case "pending":
        case "invalid":
          return result.reason;
      }
    });
    expect(described).toEqual([
      "2026-08-17T12:00:00Z/1.2.3.4",
      "authority-time/2026-08-17T12:00:00Z",
      "calendar promise only",
      "signature failed",
    ]);
  });

  test("a verifier declares its profile, basis, and posture, and stays pure", () => {
    const verifier: AnchorProofVerifier<Rfc3161Facts, readonly Uint8Array[]> = {
      profile: RFC3161_TSA_ANCHOR_PROFILE,
      timeBasis: "authority-time",
      posture: "offline-from-artifact",
      verifyProof: ({ proofBytes }) => ({
        status: "invalid",
        profile: RFC3161_TSA_ANCHOR_PROFILE,
        reason: `no rule engine in this packet (${proofBytes.length} bytes)`,
      }),
    };
    const result = verifier.verifyProof({
      subjectSha256: "a".repeat(64),
      proofBytes: Uint8Array.from([0x30, 0x00]),
    });
    expect(result.status).toBe("invalid");
    expect(verifier.posture).toBe("offline-from-artifact");
  });

  test("models both SignerInfo sid forms and the certificate facts the ports return", () => {
    const issuerAndSerial: AnchorSignerIdentifier = {
      kind: "issuerAndSerialNumber",
      issuerDer: Uint8Array.from([0x30, 0x00]),
      serialNumber: Uint8Array.from([0x0a, 0x0b]),
    };
    const subjectKeyIdentifier: AnchorSignerIdentifier = {
      kind: "subjectKeyIdentifier",
      keyIdentifier: Uint8Array.from([0x01, 0x02, 0x03]),
    };
    const certificate: AnchorCertificateFacts = {
      subjectPublicKeyInfoDer: Uint8Array.from([0x30, 0x00]),
      notBefore: "2026-01-01T00:00:00Z",
      notAfter: "2027-01-01T00:00:00Z",
      extendedKeyUsageOids: ["1.3.6.1.5.5.7.3.8"],
      subjectNames: [Uint8Array.from([0x30, 0x00])],
      sid: [issuerAndSerial, subjectKeyIdentifier],
    };
    expect(certificate.sid.map((identifier) => identifier.kind))
      .toEqual(["issuerAndSerialNumber", "subjectKeyIdentifier"]);
  });

  test("names both anchor classes (§4.1's third declared fact)", () => {
    const classes: readonly AnchorClass[] = ["lookup", "proof-carrying"];
    expect(classes).toEqual(["lookup", "proof-carrying"]);
  });

  test("carries the SignerInfo digest algorithm to the signature port", () => {
    // A hash-agnostic signature OID (bare rsaEncryption) names no digest, so
    // the port must be told which one to verify under rather than defaulting.
    const seen: string[] = [];
    const port: AnchorSignatureVerifier = {
      verifySignature: ({ algorithmOid, digestAlgorithmOid }) => {
        seen.push(`${algorithmOid}/${digestAlgorithmOid}`);
        return true;
      },
    };
    expect(port.verifySignature({
      algorithmOid: "1.2.840.113549.1.1.1",
      digestAlgorithmOid: "2.16.840.1.101.3.4.2.3",
      spkiDer: Uint8Array.from([0x30, 0x00]),
      message: Uint8Array.from([0x31, 0x00]),
      signature: Uint8Array.from([0x01]),
    })).toBe(true);
    expect(seen).toEqual(["1.2.840.113549.1.1.1/2.16.840.1.101.3.4.2.3"]);
  });

  test("validates a chain at the token's own genTime, against caller-supplied roots", () => {
    const port: AnchorChainVerifier = {
      // `verified` is unreachable without this port; an empty root set can
      // never yield it (§8 step 3).
      verifyCertificateChain: ({ trustAnchorsDer, atTime }) =>
        trustAnchorsDer.length > 0 && atTime === "2026-08-17T12:00:00Z",
    };
    const chain = [Uint8Array.from([0x30, 0x00])];
    expect(port.verifyCertificateChain({
      certificateChainDer: chain,
      trustAnchorsDer: [Uint8Array.from([0x30, 0x01, 0x00])],
      atTime: "2026-08-17T12:00:00Z",
    })).toBe(true);
    expect(port.verifyCertificateChain({
      certificateChainDer: chain,
      trustAnchorsDer: [],
      atTime: "2026-08-17T12:00:00Z",
    })).toBe(false);
  });
});
