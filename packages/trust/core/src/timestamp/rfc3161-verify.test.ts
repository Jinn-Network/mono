// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the RFC 3161 rule engine.
 *
 * The conformance kit (`@jinn-network/trust-testing`) is the outcome gate: it
 * asserts what this engine *answers* for eighty-odd token shapes, and the two
 * placements that run it are the real proof of the rules. This file asserts what
 * the kit structurally cannot -- the engine's side of the **port contract** --
 * because trust-core may not import the kit, and because the kit sees only
 * results, never the arguments the engine hands to the injected ports:
 *
 * - `digestAlgorithmOid` is set from the SignerInfo `digestAlgorithm` on every
 *   call, including for bare `rsaEncryption`, where it is the only statement of
 *   the hash anywhere in the token;
 * - `parameters` carries the exact `AlgorithmIdentifier.parameters` DER;
 * - `message` is the signedAttrs re-encoding under an explicit SET OF tag, never
 *   `eContent`;
 * - the chain port is called at the token's own `genTime`, never at a wall
 *   clock, and never at all when the caller supplied no roots.
 *
 * The tokens below are assembled from trust-core's own encoder primitives
 * (`encodeDerElement`, `encodeOid`) rather than from the kit's fixture
 * authority: no signature is ever made, because the ports are stubs. That is
 * the point -- these tests are about the seam, not about cryptography.
 */

import { describe, expect, test } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type {
  AnchorCertificateFacts,
  AnchorChainVerificationInput,
  AnchorSignatureVerificationInput,
} from "../anchor-provider.js";
import { RFC3161_TSA_ANCHOR_PROFILE } from "../anchor-provider.js";
import { DER_TAG, encodeDerElement } from "./der.js";
import { encodeOid } from "./oids.js";
import {
  OID_CONTENT_TYPE_ATTRIBUTE,
  OID_ECDSA_WITH_SHA256,
  OID_ID_CT_TST_INFO,
  OID_ID_KP_TIME_STAMPING,
  OID_ID_SIGNED_DATA,
  OID_MESSAGE_DIGEST_ATTRIBUTE,
  OID_RSA_ENCRYPTION,
  OID_SHA256,
  OID_SHA384,
  OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE,
} from "./oids.js";
import { createRfc3161AnchorProofVerifier } from "./rfc3161-verify.js";
import type { Rfc3161AnchorFacts, Rfc3161AnchorProofVerifierPorts } from "./rfc3161-verify.js";

// ---------------------------------------------------------------------------
// A minimal encoder, built on the reader's own primitives
// ---------------------------------------------------------------------------

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

const seq = (...parts: Uint8Array[]): Uint8Array => encodeDerElement(DER_TAG.SEQUENCE, concat(parts));
const set = (...parts: Uint8Array[]): Uint8Array => encodeDerElement(DER_TAG.SET, concat(parts));
const oid = (dotted: string): Uint8Array =>
  encodeDerElement(DER_TAG.OBJECT_IDENTIFIER, encodeOid(dotted));
const octet = (bytes: Uint8Array): Uint8Array => encodeDerElement(DER_TAG.OCTET_STRING, bytes);
const int = (value: number): Uint8Array => encodeDerElement(DER_TAG.INTEGER, Uint8Array.of(value));
const nul = (): Uint8Array => encodeDerElement(DER_TAG.NULL, new Uint8Array(0));
const generalizedTime = (value: string): Uint8Array =>
  encodeDerElement(DER_TAG.GENERALIZED_TIME, new TextEncoder().encode(value));
const tagged = (tagNumber: number, ...parts: Uint8Array[]): Uint8Array =>
  encodeDerElement(0xa0 | tagNumber, concat(parts));

const SUBJECT_SHA256 = "47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c";
const OTHER_SHA256 = "0000000000000000000000000000000000000000000000000000000000000001";
const GEN_TIME_DER = "20260817120000Z";
const GEN_TIME = "2026-08-17T12:00:00Z";
const POLICY_OID = "2.999.1";
const SERIAL_HEX = "0102030405060708090a0b0c0d0e0f10";
const SIGNATURE = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** An opaque stand-in for the embedded signer certificate: rule 6 identifies it
 * by digest, and every fact about it comes from the certificate port, so the
 * engine never reads a byte of its interior. */
const CERTIFICATE_DER = seq(octet(Uint8Array.of(0x01, 0x02, 0x03)));
const CERTIFICATE_SHA256 = bytesToHex(sha256(CERTIFICATE_DER));
const SUBJECT_GENERAL_NAME = tagged(4, seq(oid("2.5.4.3")));

interface TokenOptions {
  readonly subjectSha256?: string;
  readonly imprintAlgorithmOid?: string;
  readonly signatureAlgorithmOid?: string;
  readonly signatureAlgorithmParameters?: Uint8Array;
  readonly accuracySeconds?: number;
  readonly tsaGeneralName?: Uint8Array;
  readonly omitSigningCertificateV2?: boolean;
}

interface BuiltToken {
  readonly tokenDer: Uint8Array;
  readonly signedAttrsSetOf: Uint8Array;
  readonly eContent: Uint8Array;
}

function buildToken(options: TokenOptions = {}): BuiltToken {
  const imprintAlgorithmOid = options.imprintAlgorithmOid ?? OID_SHA256;
  const signatureAlgorithmOid = options.signatureAlgorithmOid ?? OID_ECDSA_WITH_SHA256;
  const imprintDigest = hexToBytes(options.subjectSha256 ?? SUBJECT_SHA256);

  const eContent = seq(
    int(1),
    oid(POLICY_OID),
    seq(seq(oid(imprintAlgorithmOid)), octet(imprintDigest)),
    encodeDerElement(DER_TAG.INTEGER, hexToBytes(SERIAL_HEX)),
    generalizedTime(GEN_TIME_DER),
    ...(options.accuracySeconds === undefined ? [] : [seq(int(options.accuracySeconds))]),
    ...(options.tsaGeneralName === undefined ? [] : [tagged(0, options.tsaGeneralName)]),
  );

  const attributes = [
    seq(oid(OID_CONTENT_TYPE_ATTRIBUTE), set(oid(OID_ID_CT_TST_INFO))),
    seq(oid(OID_MESSAGE_DIGEST_ATTRIBUTE), set(octet(sha256(eContent)))),
    ...(options.omitSigningCertificateV2
      ? []
      : [
        seq(
          oid(OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE),
          set(seq(seq(seq(octet(sha256(CERTIFICATE_DER)))))),
        ),
      ]),
  ];
  const signedAttrsSetOf = set(...attributes);
  // signedAttrs travels under an IMPLICIT [0] tag; only the signature's own copy
  // carries the explicit SET OF tag (§6.1 rule 8).
  const signedAttrs = tagged(0, ...attributes);

  const signerInfo = seq(
    int(1),
    seq(seq(oid("2.5.4.3")), encodeDerElement(DER_TAG.INTEGER, Uint8Array.of(0x2a))),
    seq(oid(OID_SHA256)),
    signedAttrs,
    options.signatureAlgorithmParameters === undefined
      ? seq(oid(signatureAlgorithmOid))
      : seq(oid(signatureAlgorithmOid), options.signatureAlgorithmParameters),
    octet(SIGNATURE),
  );

  const signedData = seq(
    int(3),
    set(seq(oid(OID_SHA256))),
    seq(oid(OID_ID_CT_TST_INFO), tagged(0, octet(eContent))),
    tagged(0, CERTIFICATE_DER),
    set(signerInfo),
  );

  return {
    tokenDer: seq(oid(OID_ID_SIGNED_DATA), tagged(0, signedData)),
    signedAttrsSetOf,
    eContent,
  };
}

// ---------------------------------------------------------------------------
// Recording stub ports
// ---------------------------------------------------------------------------

const CERTIFICATE_FACTS: AnchorCertificateFacts = {
  subjectPublicKeyInfoDer: Uint8Array.of(0x30, 0x00),
  notBefore: "2026-01-01T00:00:00Z",
  notAfter: "2036-01-01T00:00:00Z",
  extendedKeyUsageOids: [OID_ID_KP_TIME_STAMPING],
  subjectNames: [SUBJECT_GENERAL_NAME],
  sid: [
    {
      kind: "issuerAndSerialNumber",
      issuerDer: seq(oid("2.5.4.3")),
      serialNumber: Uint8Array.of(0x2a),
    },
  ],
};

interface Recorder {
  readonly ports: Rfc3161AnchorProofVerifierPorts;
  readonly signatureCalls: AnchorSignatureVerificationInput[];
  readonly chainCalls: AnchorChainVerificationInput[];
}

function recordingPorts(options: {
  readonly signatureVerifies?: boolean;
  readonly chainVerifies?: boolean;
  readonly chainThrows?: boolean;
  readonly certificate?: AnchorCertificateFacts;
} = {}): Recorder {
  const signatureCalls: AnchorSignatureVerificationInput[] = [];
  const chainCalls: AnchorChainVerificationInput[] = [];
  return {
    signatureCalls,
    chainCalls,
    ports: {
      signatureVerifier: {
        verifySignature(input) {
          signatureCalls.push(input);
          return options.signatureVerifies ?? true;
        },
      },
      certificateReader: {
        readCertificate() {
          return options.certificate ?? CERTIFICATE_FACTS;
        },
      },
      chainVerifier: {
        verifyCertificateChain(input) {
          chainCalls.push(input);
          if (options.chainThrows === true) throw new Error("chain port exploded");
          return options.chainVerifies ?? true;
        },
      },
    },
  };
}

function factsOf(result: { readonly status: string } & Record<string, unknown>): Rfc3161AnchorFacts {
  return result["facts"] as Rfc3161AnchorFacts;
}

// ---------------------------------------------------------------------------

describe("the RFC 3161 anchor proof verifier (design §6.1)", () => {
  test("declares the profile, time basis, and posture the profile pins", () => {
    const verifier = createRfc3161AnchorProofVerifier(recordingPorts().ports);
    expect(verifier.profile).toBe(RFC3161_TSA_ANCHOR_PROFILE);
    expect(verifier.timeBasis).toBe("authority-time");
    expect(verifier.posture).toBe("offline-from-artifact");
  });

  test("extracts the §6.1 facts, and reports accuracy when the token carries it", () => {
    const verifier = createRfc3161AnchorProofVerifier(recordingPorts().ports);
    const result = verifier.verifyProof({
      subjectSha256: SUBJECT_SHA256,
      proofBytes: buildToken({ accuracySeconds: 1 }).tokenDer,
    });
    expect(result.status).toBe("present");
    expect(factsOf(result as never)).toEqual({
      genTime: GEN_TIME,
      policyOid: POLICY_OID,
      serialNumber: SERIAL_HEX,
      signerCertificateSha256: CERTIFICATE_SHA256,
      signatureAlgorithmOid: OID_ECDSA_WITH_SHA256,
      accuracy: { seconds: 1 },
    });
  });

  describe("the signature port contract (§6.1 rule 8)", () => {
    test("covers the signedAttrs SET OF re-encoding, never eContent", () => {
      const recorder = recordingPorts();
      const token = buildToken();
      createRfc3161AnchorProofVerifier(recorder.ports).verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: token.tokenDer,
      });
      expect(recorder.signatureCalls).toHaveLength(1);
      const call = recorder.signatureCalls[0]!;
      expect(bytesToHex(call.message)).toBe(bytesToHex(token.signedAttrsSetOf));
      expect(call.message[0]).toBe(DER_TAG.SET);
      expect(bytesToHex(call.message)).not.toBe(bytesToHex(token.eContent));
      expect(bytesToHex(call.signature)).toBe(bytesToHex(SIGNATURE));
      expect(call.spkiDer).toBe(CERTIFICATE_FACTS.subjectPublicKeyInfoDer);
    });

    test("always carries digestAlgorithmOid, including for bare rsaEncryption", () => {
      // The capture that made this rule: a real authority emits
      // `rsaEncryption` as the SignerInfo signatureAlgorithm and leaves the
      // hash to the digestAlgorithm. A port left to a platform default would
      // verify a SHA-384 token under SHA-256.
      const recorder = recordingPorts();
      createRfc3161AnchorProofVerifier(recorder.ports).verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken({
          signatureAlgorithmOid: OID_RSA_ENCRYPTION,
          signatureAlgorithmParameters: nul(),
        }).tokenDer,
      });
      const call = recorder.signatureCalls[0]!;
      expect(call.algorithmOid).toBe(OID_RSA_ENCRYPTION);
      expect(call.digestAlgorithmOid).toBe(OID_SHA256);
      expect(bytesToHex(call.parameters!)).toBe(bytesToHex(nul()));
    });

    test("omits parameters when the AlgorithmIdentifier carries none", () => {
      const recorder = recordingPorts();
      createRfc3161AnchorProofVerifier(recorder.ports).verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
      });
      expect(recorder.signatureCalls[0]!.parameters).toBeUndefined();
    });

    test("a port that answers false refuses the token", () => {
      const recorder = recordingPorts({ signatureVerifies: false });
      const result = createRfc3161AnchorProofVerifier(recorder.ports).verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
      });
      expect(result.status).toBe("invalid");
    });
  });

  describe("the chain port contract (§4.3, §8 step 3)", () => {
    test("is never called without caller-supplied roots, and yields present", () => {
      const recorder = recordingPorts();
      const result = createRfc3161AnchorProofVerifier(recorder.ports).verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
      });
      expect(result.status).toBe("present");
      expect(recorder.chainCalls).toEqual([]);
      expect("time" in result).toBe(false);
    });

    test("an empty root set can never yield verified", () => {
      const recorder = recordingPorts();
      const result = createRfc3161AnchorProofVerifier(recorder.ports).verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
        trust: { trustAnchorsDer: [] },
      });
      expect(result.status).toBe("present");
      expect(recorder.chainCalls).toEqual([]);
    });

    test("validates at the token's own genTime, leaf first", () => {
      const recorder = recordingPorts();
      const root = Uint8Array.of(0x30, 0x00);
      const result = createRfc3161AnchorProofVerifier(recorder.ports).verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
        trust: { trustAnchorsDer: [root] },
      });
      expect(result.status).toBe("verified");
      expect(result.status === "verified" && result.time).toBe(GEN_TIME);
      expect(recorder.chainCalls).toHaveLength(1);
      expect(recorder.chainCalls[0]!.atTime).toBe(GEN_TIME);
      expect(recorder.chainCalls[0]!.trustAnchorsDer).toEqual([root]);
      expect(bytesToHex(recorder.chainCalls[0]!.certificateChainDer[0]!))
        .toBe(bytesToHex(CERTIFICATE_DER));
    });

    test("a chain that does not reach the roots is present, not invalid", () => {
      // Authority acceptability is consumer policy (§4.2): an operator's
      // incomplete root set is not an accusation against the token.
      const recorder = recordingPorts({ chainVerifies: false });
      const result = createRfc3161AnchorProofVerifier(recorder.ports).verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
        trust: { trustAnchorsDer: [Uint8Array.of(0x30, 0x00)] },
      });
      expect(result.status).toBe("present");
    });

    test("a chain port that throws is present, not invalid", () => {
      const recorder = recordingPorts({ chainThrows: true });
      const result = createRfc3161AnchorProofVerifier(recorder.ports).verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
        trust: { trustAnchorsDer: [Uint8Array.of(0x30, 0x00)] },
      });
      expect(result.status).toBe("present");
    });
  });

  describe("refusals are returned, never thrown (§4.3)", () => {
    const verifier = createRfc3161AnchorProofVerifier(recordingPorts().ports);

    test.each([
      ["empty proof bytes", new Uint8Array(0)],
      ["a truncated token", buildToken().tokenDer.subarray(0, 40)],
      ["trailing bytes after the token", concat([buildToken().tokenDer, Uint8Array.of(0x00)])],
      ["bytes that are not DER at all", Uint8Array.of(0xff, 0xff, 0xff, 0xff)],
    ])("%s is invalid with a reason", (_name, proofBytes) => {
      const result = verifier.verifyProof({ subjectSha256: SUBJECT_SHA256, proofBytes });
      expect(result.status).toBe("invalid");
      expect(result.status === "invalid" && result.reason.length).toBeGreaterThan(0);
      expect(result.profile).toBe(RFC3161_TSA_ANCHOR_PROFILE);
    });

    test("a subject digest that is not 64 lowercase hex is invalid", () => {
      const result = verifier.verifyProof({
        subjectSha256: SUBJECT_SHA256.toUpperCase(),
        proofBytes: buildToken().tokenDer,
      });
      expect(result.status).toBe("invalid");
    });

    test("a certificate port that throws is invalid, not a thrown error", () => {
      const throwing = createRfc3161AnchorProofVerifier({
        ...recordingPorts().ports,
        certificateReader: {
          readCertificate() {
            throw new Error("certificate port exploded");
          },
        },
      });
      const result = throwing.verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
      });
      expect(result.status).toBe("invalid");
      expect(result.status === "invalid" && result.reason).toContain("certificate port exploded");
    });
  });

  describe("the binding rules", () => {
    const verifier = createRfc3161AnchorProofVerifier(recordingPorts().ports);

    test("a token over another subject digest is invalid (rule 12)", () => {
      const result = verifier.verifyProof({
        subjectSha256: OTHER_SHA256,
        proofBytes: buildToken().tokenDer,
      });
      expect(result.status).toBe("invalid");
    });

    test("an imprint under SHA-384 is refused as incomparable (rule 12)", () => {
      // Rule 5 admits the family; §5 admits only `sha256` in a subject
      // DigestSet, so the caller never computed the digest this token names.
      const result = verifier.verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken({ imprintAlgorithmOid: OID_SHA384 }).tokenDer,
      });
      expect(result.status).toBe("invalid");
      expect(result.status === "invalid" && result.reason).toContain("cannot be compared");
    });

    test("a missing SigningCertificateV2 attribute is invalid (rule 6)", () => {
      const result = verifier.verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken({ omitSigningCertificateV2: true }).tokenDer,
      });
      expect(result.status).toBe("invalid");
    });

    test("a tsa field the certificate does not present is invalid (rule 10)", () => {
      const result = verifier.verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken({ tsaGeneralName: tagged(4, seq(oid("2.5.4.10"))) }).tokenDer,
      });
      expect(result.status).toBe("invalid");
    });

    test("a tsa field the certificate does present is accepted (rule 10)", () => {
      const result = verifier.verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken({ tsaGeneralName: SUBJECT_GENERAL_NAME }).tokenDer,
      });
      expect(result.status).toBe("present");
    });

    test("an extended key usage beyond id-kp-timeStamping is invalid (rule 9)", () => {
      const extra = createRfc3161AnchorProofVerifier(
        recordingPorts({
          certificate: {
            ...CERTIFICATE_FACTS,
            extendedKeyUsageOids: [OID_ID_KP_TIME_STAMPING, "1.3.6.1.5.5.7.3.2"],
          },
        }).ports,
      );
      const result = extra.verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
      });
      expect(result.status).toBe("invalid");
    });

    test("a genTime outside the certificate window is invalid (rule 11)", () => {
      const expired = createRfc3161AnchorProofVerifier(
        recordingPorts({
          certificate: {
            ...CERTIFICATE_FACTS,
            notBefore: "2020-01-01T00:00:00Z",
            notAfter: "2021-01-01T00:00:00Z",
          },
        }).ports,
      );
      const result = expired.verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
      });
      expect(result.status).toBe("invalid");
      expect(result.status === "invalid" && result.reason).toContain("validity window");
    });

    test("a sid naming another certificate is invalid (rule 7)", () => {
      const other = createRfc3161AnchorProofVerifier(
        recordingPorts({
          certificate: {
            ...CERTIFICATE_FACTS,
            sid: [
              {
                kind: "issuerAndSerialNumber",
                issuerDer: seq(oid("2.5.4.10")),
                serialNumber: Uint8Array.of(0x2a),
              },
            ],
          },
        }).ports,
      );
      const result = other.verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: buildToken().tokenDer,
      });
      expect(result.status).toBe("invalid");
    });

    test("a sid matching the certificate's subjectKeyIdentifier form is accepted (rule 7)", () => {
      // A token may name the certificate either way; a single-form certificate
      // reader could not answer the other one.
      const keyIdentifier = Uint8Array.of(0xaa, 0xbb, 0xcc);
      const bySki = createRfc3161AnchorProofVerifier(
        recordingPorts({
          certificate: {
            ...CERTIFICATE_FACTS,
            sid: [{ kind: "subjectKeyIdentifier", keyIdentifier }],
          },
        }).ports,
      );
      const token = buildToken();
      // Re-encode the SignerInfo sid as [0] IMPLICIT OCTET STRING by rebuilding
      // the token around the other form.
      const eContent = token.eContent;
      const attributes = [
        seq(oid(OID_CONTENT_TYPE_ATTRIBUTE), set(oid(OID_ID_CT_TST_INFO))),
        seq(oid(OID_MESSAGE_DIGEST_ATTRIBUTE), set(octet(sha256(eContent)))),
        seq(
          oid(OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE),
          set(seq(seq(seq(octet(sha256(CERTIFICATE_DER)))))),
        ),
      ];
      const signerInfo = seq(
        int(1),
        encodeDerElement(0x80, keyIdentifier),
        seq(oid(OID_SHA256)),
        tagged(0, ...attributes),
        seq(oid(OID_ECDSA_WITH_SHA256)),
        octet(SIGNATURE),
      );
      const signedData = seq(
        int(3),
        set(seq(oid(OID_SHA256))),
        seq(oid(OID_ID_CT_TST_INFO), tagged(0, octet(eContent))),
        tagged(0, CERTIFICATE_DER),
        set(signerInfo),
      );
      const result = bySki.verifyProof({
        subjectSha256: SUBJECT_SHA256,
        proofBytes: seq(oid(OID_ID_SIGNED_DATA), tagged(0, signedData)),
      });
      expect(result.status).toBe("present");
    });
  });
});
