// SPDX-License-Identifier: Apache-2.0

/**
 * The conformance kit run against the trust-core RFC 3161 rule engine, on pure
 * ports (design §11, §6.1).
 *
 * This is placement one of two. Here the three injected ports are **pure**:
 * `@noble/curves` P-256 for signatures (the kit authority signs with nothing
 * else), and the trust-core DER reader for certificate structure. No `node:`
 * module is touched, so the same suite that gates the product's `node:crypto`
 * ports also gates the rules themselves on a platform-free implementation --
 * a rule that only passed because of something `node:crypto` did would fail
 * here.
 *
 * The captured production tokens deliberately do **not** enter this placement:
 * one of them is RSA-signed, and `@noble/curves` cannot verify RSA. They enter
 * through the standalone verifier package's run of this same suite, where the
 * ports are `node:crypto`. Splitting it this way is the point of the kit taking
 * `realTokens` as an input rather than reading them itself.
 *
 * Nothing in this file is exported: these ports exist to exercise the contract,
 * not to be reused. A consumer needing real ports wants the `node:crypto` pair
 * in the verifier package, not a fixture.
 */

import { describe, expect, test } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import {
  DER_TAG,
  OID_ECDSA_WITH_SHA256,
  OID_ECDSA_WITH_SHA384,
  OID_ECDSA_WITH_SHA512,
  OID_ID_KP_TIME_STAMPING,
  RFC3161_TSA_ANCHOR_PROFILE,
  compareCalendarStrictRfc3339Instants,
  createRfc3161AnchorProofVerifier,
  decodeDer,
  decodeDerChildren,
  encodeDerElement,
  readDerOid,
} from "@jinn-network/trust-core";
import type {
  AnchorCertificateFacts,
  AnchorCertificateReader,
  AnchorChainVerifier,
  AnchorSignatureVerifier,
  AnchorSignerIdentifier,
  DerElement,
  Rfc3161AnchorTrustMaterial,
} from "@jinn-network/trust-core";

import { bytesToHex } from "./der-encoder.js";
import { KIT_AUTHORITY_SEED, describeAnchorProofVerifierContract } from "./conformance.js";
import type { AnchorKitFixtures } from "./conformance.js";
import { createFixtureAuthority } from "./fixture-authority.js";

// ---------------------------------------------------------------------------
// X.509 field extraction, structural only
// ---------------------------------------------------------------------------

const OID_EXT_SUBJECT_KEY_IDENTIFIER = "2.5.29.14";
const OID_EXT_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_EXT_EXTENDED_KEY_USAGE = "2.5.29.37";
const CONTEXT_CONSTRUCTED_0 = 0xa0;
const CONTEXT_CONSTRUCTED_3 = 0xa3;
/** `GeneralName ::= CHOICE { ... directoryName [4] Name ... }`, explicit
 * because `Name` is itself a CHOICE. */
const GENERAL_NAME_DIRECTORY = 0xa4;

function children(element: DerElement): readonly DerElement[] {
  return decodeDerChildren(element);
}

/** `UTCTime` in the RFC 5280 profile: `YYMMDDHHMMSSZ`, with the century pivot
 * at 50. Rendered into the same calendar-strict RFC 3339 spelling every other
 * trust instant uses, so one comparator judges them all. */
function utcTimeToRfc3339(value: string): string {
  const match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (match === null) throw new Error(`"${value}" is not a profile-conformant UTCTime.`);
  const year = Number.parseInt(match[1]!, 10);
  const century = year >= 50 ? 1900 : 2000;
  return `${century + year}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

function readTime(element: DerElement): string {
  const value = new TextDecoder().decode(element.content);
  if (element.identifier === DER_TAG.UTC_TIME) return utcTimeToRfc3339(value);
  if (element.identifier === DER_TAG.GENERALIZED_TIME) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(value);
    if (match === null) throw new Error(`"${value}" is not a profile-conformant GeneralizedTime.`);
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  }
  throw new Error(`Validity bound has identifier 0x${element.identifier.toString(16)}.`);
}

interface TbsFields {
  readonly serialNumber: Uint8Array;
  readonly issuerDer: Uint8Array;
  readonly subjectDer: Uint8Array;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly subjectPublicKeyInfoDer: Uint8Array;
  readonly extensions: readonly DerElement[];
}

function readTbsCertificate(certificateDer: Uint8Array): TbsFields {
  const certificate = children(decodeDer(certificateDer));
  const tbs = children(certificate[0]!);
  // `version [0] EXPLICIT INTEGER DEFAULT v1` -- absent for a v1 certificate.
  const offset = tbs[0]!.identifier === CONTEXT_CONSTRUCTED_0 ? 1 : 0;
  const validity = children(tbs[offset + 3]!);
  const extensionsWrapper = tbs.slice(offset + 6).find(
    (element) => element.identifier === CONTEXT_CONSTRUCTED_3,
  );
  return {
    serialNumber: tbs[offset]!.content,
    issuerDer: tbs[offset + 2]!.bytes,
    subjectDer: tbs[offset + 4]!.bytes,
    notBefore: readTime(validity[0]!),
    notAfter: readTime(validity[1]!),
    subjectPublicKeyInfoDer: tbs[offset + 5]!.bytes,
    extensions: extensionsWrapper === undefined ? [] : children(children(extensionsWrapper)[0]!),
  };
}

/** `Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE,
 * extnValue OCTET STRING }` -- returns the DER inside `extnValue`. */
function extensionValue(extensions: readonly DerElement[], oid: string): Uint8Array | undefined {
  for (const extension of extensions) {
    const parts = children(extension);
    if (readDerOid(parts[0]!) !== oid) continue;
    return parts.at(-1)!.content;
  }
  return undefined;
}

function readCertificateStructurally(certificateDer: Uint8Array): AnchorCertificateFacts {
  const tbs = readTbsCertificate(certificateDer);
  const extendedKeyUsage = extensionValue(tbs.extensions, OID_EXT_EXTENDED_KEY_USAGE);
  const subjectAltName = extensionValue(tbs.extensions, OID_EXT_SUBJECT_ALT_NAME);
  const subjectKeyIdentifier = extensionValue(tbs.extensions, OID_EXT_SUBJECT_KEY_IDENTIFIER);

  const sid: AnchorSignerIdentifier[] = [
    { kind: "issuerAndSerialNumber", issuerDer: tbs.issuerDer, serialNumber: tbs.serialNumber },
  ];
  if (subjectKeyIdentifier !== undefined) {
    sid.push({ kind: "subjectKeyIdentifier", keyIdentifier: decodeDer(subjectKeyIdentifier).content });
  }

  return {
    subjectPublicKeyInfoDer: tbs.subjectPublicKeyInfoDer,
    notBefore: tbs.notBefore,
    notAfter: tbs.notAfter,
    extendedKeyUsageOids: extendedKeyUsage === undefined
      ? []
      : children(decodeDer(extendedKeyUsage)).map((element) => readDerOid(element)),
    // The certificate's own `directoryName` GeneralName, plus every name it
    // presents through subjectAltName -- exact DER either way, because §6.1
    // rule 10 compares bytes.
    subjectNames: [
      encodeDerElement(GENERAL_NAME_DIRECTORY, tbs.subjectDer),
      ...(subjectAltName === undefined
        ? []
        : children(decodeDer(subjectAltName)).map((element) => element.bytes)),
    ],
    sid,
  };
}

// ---------------------------------------------------------------------------
// The pure ports
// ---------------------------------------------------------------------------

/** ECDSA names its own digest, so the SignerInfo digest algorithm is not
 * consulted here -- the hash-agnostic algorithms that make `digestAlgorithmOid`
 * load-bearing are all RSA, and RSA belongs to the other placement. */
const ECDSA_DIGESTS: ReadonlyMap<string, (bytes: Uint8Array) => Uint8Array> = new Map<
  string,
  (bytes: Uint8Array) => Uint8Array
>([
  [OID_ECDSA_WITH_SHA256, sha256],
  [OID_ECDSA_WITH_SHA384, sha384],
  [OID_ECDSA_WITH_SHA512, sha512],
]);

/**
 * P-256 only. The kit authority signs with nothing else (`fixture-authority.ts`
 * says so and explains why), and a port that pretended to cover RSA here would
 * be claiming coverage the captured tokens provide in the other placement.
 */
const nobleSignatureVerifier: AnchorSignatureVerifier = {
  verifySignature(input) {
    try {
      // ECDSA names its own digest; anything else is out of this port's scope.
      const digest = ECDSA_DIGESTS.get(input.algorithmOid);
      if (digest === undefined) return false;
      const spki = children(decodeDer(input.spkiDer));
      const point = spki[1]!.content.subarray(1);
      return p256.verify(input.signature, digest(input.message), point, {
        format: "der",
        prehash: false,
      });
    } catch {
      return false;
    }
  },
};

const structuralCertificateReader: AnchorCertificateReader = {
  readCertificate: readCertificateStructurally,
};

/**
 * The kit's chain verifier.
 *
 * The fixture authority is self-signed and is its own root, so a conformant
 * chain here is exactly one certificate long and the check is: does the leaf
 * *equal* a root the caller supplied, and was that root valid at `atTime`. A
 * general path builder in a fixture would be an invention -- the real one is
 * the `node:crypto` port in the verifier package, which this same suite gates
 * in its other placement.
 */
const kitChainVerifier: AnchorChainVerifier = {
  verifyCertificateChain(input) {
    const leaf = input.certificateChainDer[0];
    if (leaf === undefined || input.trustAnchorsDer.length === 0) return false;
    const leafHex = bytesToHex(leaf);
    if (!input.trustAnchorsDer.some((anchor) => bytesToHex(anchor) === leafHex)) return false;
    const facts = readCertificateStructurally(leaf);
    const afterNotBefore = compareCalendarStrictRfc3339Instants(input.atTime, facts.notBefore);
    const beforeNotAfter = compareCalendarStrictRfc3339Instants(input.atTime, facts.notAfter);
    return afterNotBefore !== undefined && beforeNotAfter !== undefined
      && afterNotBefore >= 0 && beforeNotAfter <= 0;
  },
};

// ---------------------------------------------------------------------------

describeAnchorProofVerifierContract<Rfc3161AnchorTrustMaterial>(
  RFC3161_TSA_ANCHOR_PROFILE,
  (kit: AnchorKitFixtures) => ({
    verifier: createRfc3161AnchorProofVerifier({
      signatureVerifier: nobleSignatureVerifier,
      certificateReader: structuralCertificateReader,
      chainVerifier: kitChainVerifier,
    }),
    // The only root a kit verifier configuration ever trusts, and it is supplied
    // here -- caller-side -- rather than read out of any proof.
    trust: { trustAnchorsDer: [kit.authority.certificateDer] },
  }),
);

describe("the pure kit ports", () => {
  const authority = createFixtureAuthority(KIT_AUTHORITY_SEED);

  test("read the fixture authority certificate the way §6.1 rules 7, 9, 10, and 11 need", () => {
    const facts = structuralCertificateReader.readCertificate(authority.certificateDer);
    expect(facts.notBefore).toBe(authority.notBefore);
    expect(facts.notAfter).toBe(authority.notAfter);
    expect(facts.extendedKeyUsageOids).toEqual([OID_ID_KP_TIME_STAMPING]);
    expect(bytesToHex(facts.subjectNames[0]!)).toBe(bytesToHex(authority.subjectGeneralNameDer));
    expect(facts.sid.map((form) => form.kind))
      .toEqual(["issuerAndSerialNumber", "subjectKeyIdentifier"]);
  });

  test("refuse a chain whose leaf is not one of the supplied roots", () => {
    expect(kitChainVerifier.verifyCertificateChain({
      certificateChainDer: [authority.certificateDer],
      trustAnchorsDer: [],
      atTime: "2026-08-17T12:00:00Z",
    })).toBe(false);
    expect(kitChainVerifier.verifyCertificateChain({
      certificateChainDer: [authority.certificateDer],
      trustAnchorsDer: [Uint8Array.of(0x30, 0x00)],
      atTime: "2026-08-17T12:00:00Z",
    })).toBe(false);
    expect(kitChainVerifier.verifyCertificateChain({
      certificateChainDer: [authority.certificateDer],
      trustAnchorsDer: [authority.certificateDer],
      atTime: "2020-01-01T00:00:00Z",
    })).toBe(false);
  });
});
