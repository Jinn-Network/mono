// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the three `node:crypto` anchor ports.
 *
 * The conformance kit gates the *rules*; this file gates the *platform*, over
 * the cases the kit's fixture authority cannot reach. The kit signs with P-256
 * and nothing else, and its authority is a single self-signed certificate, so
 * three things it can never exercise live here:
 *
 * - **RSA under a hash the signature algorithm does not name.** Bare
 *   `rsaEncryption` leaves the hash to the SignerInfo `digestAlgorithm`, and a
 *   port that fell back to a platform default would still pass every kit case
 *   and every committed capture (both are SHA-256). The SHA-384 pair below is
 *   the case that tells the two implementations apart.
 * - **RSASSA-PSS parameters.** No captured token uses PSS, so the salt length,
 *   the MGF1 hash, and the trailer field are asserted here against signatures
 *   this file actually makes.
 * - **Real certificate chains.** Roots, intermediates, basic constraints, depth,
 *   and cycles need more than one certificate.
 *
 * Certificates and keys are minted in-process with `node:crypto` plus
 * trust-core's DER primitives -- deterministic in structure, fresh in key
 * material, and never written to disk. Nothing here is a fixture: the committed
 * fixture set is the kit's, and it does not grow for a unit test.
 */

import { X509Certificate, constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  DER_TAG,
  OID_ECDSA_WITH_SHA256,
  OID_ID_CT_TST_INFO,
  OID_ID_KP_TIME_STAMPING,
  OID_ID_SIGNED_DATA,
  OID_RSASSA_PSS,
  OID_RSA_ENCRYPTION,
  OID_SHA256,
  OID_SHA256_WITH_RSA_ENCRYPTION,
  OID_SHA384,
  createRfc3161AnchorProofVerifier,
  encodeDerElement,
  encodeOid,
} from "@jinn-network/trust-core";

import {
  anchorCertificateReader,
  anchorChainVerifier,
  anchorSignatureVerifier,
  nodeCryptoAnchorPorts,
} from "./ports.js";

// ---------------------------------------------------------------------------
// DER, from trust-core's own primitives
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
const intFromContent = (content: Uint8Array): Uint8Array =>
  encodeDerElement(DER_TAG.INTEGER, content);
const nul = (): Uint8Array => encodeDerElement(DER_TAG.NULL, new Uint8Array(0));
const bool = (value: boolean): Uint8Array =>
  encodeDerElement(DER_TAG.BOOLEAN, Uint8Array.of(value ? 0xff : 0x00));
const bitString = (bytes: Uint8Array, unusedBits: number): Uint8Array =>
  encodeDerElement(DER_TAG.BIT_STRING, concat([Uint8Array.of(unusedBits), bytes]));
const utf8String = (value: string): Uint8Array =>
  encodeDerElement(0x0c, new TextEncoder().encode(value));
const utcTime = (value: string): Uint8Array =>
  encodeDerElement(DER_TAG.UTC_TIME, new TextEncoder().encode(value));
const generalizedTime = (value: string): Uint8Array =>
  encodeDerElement(DER_TAG.GENERALIZED_TIME, new TextEncoder().encode(value));
const tagged = (tagNumber: number, ...parts: Uint8Array[]): Uint8Array =>
  encodeDerElement(0xa0 | tagNumber, concat(parts));

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const OID_AT_COMMON_NAME = "2.5.4.3";
const OID_EXT_KEY_USAGE = "2.5.29.15";
const OID_EXT_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_EXT_EXTENDED_KEY_USAGE = "2.5.29.37";
const OID_MGF1 = "1.2.840.113549.1.1.8";
const OID_SHA1 = "1.3.14.3.2.26";

const NOT_BEFORE_UTC = "260101000000Z";
const NOT_AFTER_UTC = "360101000000Z";
const AT_TIME = "2026-08-17T12:00:00Z";
const GEN_TIME_DER = "20260817120000Z";
const SUBJECT_SHA256 = "47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c";

function distinguishedName(commonName: string): Uint8Array {
  return seq(set(seq(oid(OID_AT_COMMON_NAME), utf8String(commonName))));
}

function extension(extnOid: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical
    ? seq(oid(extnOid), bool(true), octet(value))
    : seq(oid(extnOid), octet(value));
}

// ---------------------------------------------------------------------------
// A minimal certificate authority
// ---------------------------------------------------------------------------

interface KeyPair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

function ecKeyPair(): KeyPair {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

interface MintedCertificate {
  readonly der: Uint8Array;
  readonly subjectDer: Uint8Array;
  readonly keys: KeyPair;
  readonly serialContent: Uint8Array;
}

interface MintCertificateOptions {
  readonly commonName: string;
  readonly serialHex?: string;
  readonly keys?: KeyPair;
  /** Self-signed when absent. */
  readonly issuer?: MintedCertificate;
  readonly ca?: boolean;
  readonly keyCertSign?: boolean;
  readonly extendedKeyUsageOids?: readonly string[];
  readonly notBefore?: string;
  readonly notAfter?: string;
}

let nextSerial = 0x11;

function mintCertificate(options: MintCertificateOptions): MintedCertificate {
  const keys = options.keys ?? ecKeyPair();
  const serialContent = hexToBytes(
    options.serialHex ?? (nextSerial += 1).toString(16).padStart(2, "0"),
  );
  const subjectDer = distinguishedName(options.commonName);
  const issuerDer = options.issuer?.subjectDer ?? subjectDer;
  const signingKey = options.issuer?.keys.privateKey ?? keys.privateKey;
  const ca = options.ca ?? false;
  const keyCertSign = options.keyCertSign ?? ca;

  const keyUsageBits = keyCertSign
    // keyCertSign is bit 5, digitalSignature bit 0.
    ? bitString(Uint8Array.of(0x84), 2)
    : bitString(Uint8Array.of(0x80), 7);

  const extensions = [
    extension(OID_EXT_BASIC_CONSTRAINTS, true, ca ? seq(bool(true)) : seq()),
    extension(OID_EXT_KEY_USAGE, true, keyUsageBits),
    ...(options.extendedKeyUsageOids === undefined
      ? []
      : [extension(OID_EXT_EXTENDED_KEY_USAGE, true, seq(...options.extendedKeyUsageOids.map((each) => oid(each))))]),
  ];

  const tbsCertificate = seq(
    tagged(0, int(2)),
    intFromContent(serialContent),
    seq(oid(OID_ECDSA_WITH_SHA256)),
    issuerDer,
    seq(utcTime(options.notBefore ?? NOT_BEFORE_UTC), utcTime(options.notAfter ?? NOT_AFTER_UTC)),
    subjectDer,
    new Uint8Array(keys.publicKey.export({ format: "der", type: "spki" })),
    tagged(3, seq(...extensions)),
  );
  const signature = sign("sha256", Buffer.from(tbsCertificate), signingKey);
  return {
    der: seq(tbsCertificate, seq(oid(OID_ECDSA_WITH_SHA256)), bitString(new Uint8Array(signature), 0)),
    subjectDer,
    keys,
    serialContent,
  };
}

/**
 * One `TimeStampToken` signed by a minted certificate's key. Real bytes and a
 * real ECDSA signature over the signedAttrs SET OF re-encoding, so the whole
 * engine plus all three real ports run end to end.
 */
function mintToken(options: {
  readonly certificate: MintedCertificate;
  readonly sidSerialContent?: Uint8Array;
}): Uint8Array {
  const { certificate } = options;
  // The SigningCertificateV2 certHash, under its DEFAULT SHA-256.
  const certificateSha256 = new Uint8Array(
    createHash("sha256").update(Buffer.from(certificate.der)).digest(),
  );

  const eContent = seq(
    int(1),
    oid("2.999.1"),
    seq(seq(oid(OID_SHA256)), octet(hexToBytes(SUBJECT_SHA256))),
    intFromContent(Uint8Array.of(0x01, 0x02)),
    generalizedTime(GEN_TIME_DER),
  );
  const messageDigest = new Uint8Array(
    createHash("sha256").update(Buffer.from(eContent)).digest(),
  );

  const attributes = [
    seq(oid("1.2.840.113549.1.9.3"), set(oid(OID_ID_CT_TST_INFO))),
    seq(oid("1.2.840.113549.1.9.4"), set(octet(messageDigest))),
    seq(oid("1.2.840.113549.1.9.16.2.47"), set(seq(seq(seq(octet(certificateSha256)))))),
  ];
  const signature = sign("sha256", Buffer.from(set(...attributes)), certificate.keys.privateKey);

  const signerInfo = seq(
    int(1),
    seq(certificate.subjectDer, intFromContent(options.sidSerialContent ?? certificate.serialContent)),
    seq(oid(OID_SHA256)),
    tagged(0, ...attributes),
    seq(oid(OID_ECDSA_WITH_SHA256)),
    octet(new Uint8Array(signature)),
  );
  const signedData = seq(
    int(3),
    set(seq(oid(OID_SHA256))),
    seq(oid(OID_ID_CT_TST_INFO), tagged(0, octet(eContent))),
    tagged(0, certificate.der),
    set(signerInfo),
  );
  return seq(oid(OID_ID_SIGNED_DATA), tagged(0, signedData));
}

// ---------------------------------------------------------------------------
// The signature port
// ---------------------------------------------------------------------------

describe("the node:crypto signature port", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spkiDer = new Uint8Array(rsa.publicKey.export({ format: "der", type: "spki" }));
  const message = new TextEncoder().encode("the exact bytes a signature covers");

  describe("bare rsaEncryption takes its hash from digestAlgorithmOid", () => {
    // The headline property of the whole port, and the one a platform default
    // silently breaks: `rsaEncryption` names no digest at all, and Node's
    // `crypto.verify` falls back to SHA-256 when the algorithm pins none. Every
    // kit case and both committed captures are SHA-256, so only a SHA-384 pair
    // can tell a conformant port from a defaulting one.
    const signature = new Uint8Array(sign("sha384", Buffer.from(message), rsa.privateKey));

    test("a SHA-384 signature verifies when digestAlgorithmOid says SHA-384", () => {
      expect(anchorSignatureVerifier.verifySignature({
        algorithmOid: OID_RSA_ENCRYPTION,
        digestAlgorithmOid: OID_SHA384,
        spkiDer,
        message,
        signature,
      })).toBe(true);
    });

    test("the same signature fails when digestAlgorithmOid says SHA-256", () => {
      expect(anchorSignatureVerifier.verifySignature({
        algorithmOid: OID_RSA_ENCRYPTION,
        digestAlgorithmOid: OID_SHA256,
        spkiDer,
        message,
        signature,
      })).toBe(false);
    });

    test("an unadmitted digest OID fails rather than falling back", () => {
      expect(anchorSignatureVerifier.verifySignature({
        algorithmOid: OID_RSA_ENCRYPTION,
        digestAlgorithmOid: OID_SHA1,
        spkiDer,
        message,
        signature,
      })).toBe(false);
    });
  });

  test("a signature algorithm that names its own hash uses that hash", () => {
    const signature = new Uint8Array(sign("sha256", Buffer.from(message), rsa.privateKey));
    expect(anchorSignatureVerifier.verifySignature({
      algorithmOid: OID_SHA256_WITH_RSA_ENCRYPTION,
      // Deliberately disagreeing: the algorithm's own digest wins for a
      // hash-naming algorithm, so this must not decide the verification.
      digestAlgorithmOid: OID_SHA384,
      spkiDer,
      message,
      signature,
    })).toBe(true);
  });

  test("an RSA algorithm over an EC key is refused", () => {
    const ec = ecKeyPair();
    expect(anchorSignatureVerifier.verifySignature({
      algorithmOid: OID_RSA_ENCRYPTION,
      digestAlgorithmOid: OID_SHA256,
      spkiDer: new Uint8Array(ec.publicKey.export({ format: "der", type: "spki" })),
      message,
      signature: new Uint8Array(sign("sha256", Buffer.from(message), ec.privateKey)),
    })).toBe(false);
  });

  describe("RSASSA-PSS parameters", () => {
    function pssParameters(options: {
      readonly hashOid?: string;
      readonly mgfHashOid?: string;
      readonly saltLength?: number;
      readonly trailerField?: number;
      readonly omitMgf?: boolean;
      readonly omitSaltLength?: boolean;
    } = {}): Uint8Array {
      const hashOid = options.hashOid ?? OID_SHA256;
      return seq(
        tagged(0, seq(oid(hashOid), nul())),
        ...(options.omitMgf === true
          ? []
          : [tagged(1, seq(oid(OID_MGF1), seq(oid(options.mgfHashOid ?? hashOid), nul())))]),
        ...(options.omitSaltLength === true ? [] : [tagged(2, int(options.saltLength ?? 32))]),
        ...(options.trailerField === undefined ? [] : [tagged(3, int(options.trailerField))]),
      );
    }

    function pssSignature(saltLength: number): Uint8Array {
      return new Uint8Array(sign("sha256", Buffer.from(message), {
        key: rsa.privateKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength,
      }));
    }

    function verifyPss(parameters: Uint8Array | undefined, signature: Uint8Array): boolean {
      return anchorSignatureVerifier.verifySignature({
        algorithmOid: OID_RSASSA_PSS,
        digestAlgorithmOid: OID_SHA256,
        ...(parameters === undefined ? {} : { parameters }),
        spkiDer,
        message,
        signature,
      });
    }

    test("correct parameters verify", () => {
      expect(verifyPss(pssParameters(), pssSignature(32))).toBe(true);
    });

    test("a salt length the parameters do not declare fails", () => {
      expect(verifyPss(pssParameters({ saltLength: 48 }), pssSignature(32))).toBe(false);
    });

    test("an MGF1 hash differing from the signature hash fails", () => {
      // `crypto.verify` uses one hash for both, so a token declaring different
      // ones would otherwise be checked under parameters it never stated.
      expect(verifyPss(pssParameters({ mgfHashOid: OID_SHA384 }), pssSignature(32))).toBe(false);
    });

    test("an absent maskGenAlgorithm fails, because its DEFAULT is MGF1-SHA-1", () => {
      expect(verifyPss(pssParameters({ omitMgf: true }), pssSignature(32))).toBe(false);
    });

    test("a trailerField other than 1 fails", () => {
      expect(verifyPss(pssParameters({ trailerField: 2 }), pssSignature(32))).toBe(false);
    });

    test("absent parameters fail", () => {
      expect(verifyPss(undefined, pssSignature(32))).toBe(false);
    });

    test("an omitted saltLength honours the DEFAULT of 20", () => {
      expect(verifyPss(pssParameters({ omitSaltLength: true }), pssSignature(20))).toBe(true);
      expect(verifyPss(pssParameters({ omitSaltLength: true }), pssSignature(32))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// The certificate port
// ---------------------------------------------------------------------------

describe("the node:crypto certificate port", () => {
  /** 17 content octets: a 16-byte serial whose leading octet has the high bit
   * set needs a 0x00 sign octet, which is exactly what a hex rendering of the
   * *value* drops. */
  const HIGH_BIT_SERIAL_HEX = "00ce28e208030db02ff8ca617585729ed5";

  const certificate = mintCertificate({
    commonName: "P4 high-bit serial timestamping",
    serialHex: HIGH_BIT_SERIAL_HEX,
    extendedKeyUsageOids: [OID_ID_KP_TIME_STAMPING],
  });

  test("reports the serial as DER content octets, sign octet preserved", () => {
    const facts = anchorCertificateReader.readCertificate(certificate.der);
    const issuerAndSerial = facts.sid.find((form) => form.kind === "issuerAndSerialNumber")!;
    expect(issuerAndSerial.kind === "issuerAndSerialNumber"
      && bytesToHex(issuerAndSerial.serialNumber)).toBe(HIGH_BIT_SERIAL_HEX);
  });

  test("the platform's own rendering drops that sign octet", () => {
    // Why the port extracts structurally rather than reading
    // `X509Certificate.serialNumber`: the two differ by exactly the octet §6.1
    // rule 7 compares.
    const platform = new X509Certificate(Buffer.from(certificate.der));
    expect(platform.serialNumber.toLowerCase()).toBe(HIGH_BIT_SERIAL_HEX.slice(2));
  });

  test("rule 7 matches a sid naming that serial, and refuses one without the sign octet", () => {
    const verifier = createRfc3161AnchorProofVerifier(nodeCryptoAnchorPorts);
    expect(verifier.verifyProof({
      subjectSha256: SUBJECT_SHA256,
      proofBytes: mintToken({ certificate }),
    }).status).toBe("present");

    const stripped = verifier.verifyProof({
      subjectSha256: SUBJECT_SHA256,
      proofBytes: mintToken({
        certificate,
        sidSerialContent: hexToBytes(HIGH_BIT_SERIAL_HEX.slice(2)),
      }),
    });
    expect(stripped.status).toBe("invalid");
    expect(stripped.status === "invalid" && stripped.reason).toContain("rule 7");
  });
});

// ---------------------------------------------------------------------------
// The chain verifier
// ---------------------------------------------------------------------------

describe("the node:crypto chain verifier", () => {
  const root = mintCertificate({ commonName: "P4 test root", ca: true });
  const intermediate = mintCertificate({
    commonName: "P4 test intermediate",
    ca: true,
    issuer: root,
  });
  const leaf = mintCertificate({
    commonName: "P4 test timestamping unit",
    issuer: intermediate,
    extendedKeyUsageOids: [OID_ID_KP_TIME_STAMPING],
  });

  function verifyChain(chain: readonly MintedCertificate[], anchors: readonly MintedCertificate[], atTime = AT_TIME): boolean {
    return anchorChainVerifier.verifyCertificateChain({
      certificateChainDer: chain.map((certificate) => certificate.der),
      trustAnchorsDer: anchors.map((certificate) => certificate.der),
      atTime,
    });
  }

  test("a leaf issued directly by a supplied root verifies", () => {
    const direct = mintCertificate({
      commonName: "P4 directly issued unit",
      issuer: root,
      extendedKeyUsageOids: [OID_ID_KP_TIME_STAMPING],
    });
    expect(verifyChain([direct], [root])).toBe(true);
  });

  test("a leaf reaching the root through a carried intermediate verifies", () => {
    // The `chain.find` walk: the anchor does not issue the leaf, so the port has
    // to climb through a certificate the token carried.
    expect(verifyChain([leaf, intermediate], [root])).toBe(true);
  });

  test("a chain that never reaches a supplied root does not verify", () => {
    const stranger = mintCertificate({ commonName: "P4 unrelated root", ca: true });
    expect(verifyChain([leaf, intermediate], [stranger])).toBe(false);
  });

  test("an intermediate the token did not carry does not verify", () => {
    expect(verifyChain([leaf], [root])).toBe(false);
  });

  describe("basic constraints", () => {
    // The measured bypass: `checkIssued` covers names, key identifiers, and
    // keyCertSign -- but not `CA:FALSE`. A leaf certificate that asserts
    // keyCertSign would otherwise be usable as an intermediate.
    const rogue = mintCertificate({
      commonName: "P4 rogue non-CA signer",
      issuer: root,
      ca: false,
      keyCertSign: true,
    });
    const splice = mintCertificate({
      commonName: "P4 spliced unit",
      issuer: rogue,
      extendedKeyUsageOids: [OID_ID_KP_TIME_STAMPING],
    });

    test("the bypass is real: the platform's own issuance check accepts the rogue", () => {
      const spliceCertificate = new X509Certificate(Buffer.from(splice.der));
      const rogueCertificate = new X509Certificate(Buffer.from(rogue.der));
      expect(spliceCertificate.checkIssued(rogueCertificate)).toBe(true);
      expect(rogueCertificate.ca).toBe(false);
    });

    test("a CA:FALSE certificate cannot serve as an intermediate", () => {
      expect(verifyChain([splice, rogue], [root])).toBe(false);
    });

    test("a CA:FALSE certificate cannot serve as a trust anchor's issuer either", () => {
      expect(verifyChain([splice], [rogue])).toBe(false);
    });
  });

  describe("bounds", () => {
    function ladder(length: number): { readonly chain: MintedCertificate[]; readonly root: MintedCertificate } {
      const base = mintCertificate({ commonName: "P4 ladder root", ca: true });
      let issuer = base;
      const rungs: MintedCertificate[] = [];
      for (let index = 0; index < length; index += 1) {
        issuer = mintCertificate({ commonName: `P4 ladder ${index}`, ca: true, issuer });
        rungs.push(issuer);
      }
      const end = mintCertificate({
        commonName: "P4 ladder unit",
        issuer,
        extendedKeyUsageOids: [OID_ID_KP_TIME_STAMPING],
      });
      return { chain: [end, ...rungs.reverse()], root: base };
    }

    test("a chain inside MAX_CHAIN_DEPTH verifies", () => {
      const { chain, root: base } = ladder(6);
      expect(verifyChain(chain, [base])).toBe(true);
    });

    test("a chain beyond MAX_CHAIN_DEPTH does not", () => {
      const { chain, root: base } = ladder(9);
      expect(verifyChain(chain, [base])).toBe(false);
    });

    test("a cross-signed cycle terminates without verifying", () => {
      // Two CA certificates that issue each other. The `seen` set is the first
      // line here and the depth bound the backstop; either way the walk must
      // return rather than spin.
      const alphaKeys = ecKeyPair();
      const betaKeys = ecKeyPair();
      const alphaName = "P4 cycle alpha";
      const betaName = "P4 cycle beta";
      const betaShell = mintCertificate({ commonName: betaName, keys: betaKeys, ca: true });
      const alphaShell = mintCertificate({ commonName: alphaName, keys: alphaKeys, ca: true });
      const alpha = mintCertificate({ commonName: alphaName, keys: alphaKeys, ca: true, issuer: betaShell });
      const beta = mintCertificate({ commonName: betaName, keys: betaKeys, ca: true, issuer: alphaShell });
      const stranger = mintCertificate({ commonName: "P4 cycle stranger root", ca: true });
      expect(verifyChain([alpha, beta], [stranger])).toBe(false);
    });
  });

  describe("the instant the chain is validated at", () => {
    test("a genTime outside the chain's validity does not verify", () => {
      expect(verifyChain([leaf, intermediate], [root], "2020-01-01T00:00:00Z")).toBe(false);
    });

    test.each([
      ["a bare date", "2026-08-17"],
      ["a local-time reading", "2026-08-17T12:00:00"],
      ["a non-RFC-3339 spelling", "17 Aug 2026 12:00:00 GMT"],
      ["an empty string", ""],
    ])("%s is refused rather than parsed", (_name, atTime) => {
      // `Date.parse` accepts the first three and would validate the chain at an
      // instant nobody named; the calendar-strict comparator does not.
      expect(verifyChain([leaf, intermediate], [root], atTime)).toBe(false);
    });

    test("an offset-bearing RFC 3339 instant is judged, not rejected out of hand", () => {
      // Calendar-strict RFC 3339 admits an offset; the comparator normalizes it,
      // so this is the same instant as the Zulu spelling above.
      expect(verifyChain([leaf, intermediate], [root], "2026-08-17T14:00:00+02:00")).toBe(true);
    });
  });
});
