// SPDX-License-Identifier: Apache-2.0

/**
 * The kit-only RFC 3161 fixture authority (anchor-evidence design §11).
 *
 * A deterministic, seeded ECDSA P-256 authority that mints its own self-signed
 * certificate and `TimeStampToken`s over a caller-supplied digest -- valid by
 * default, and deliberately broken in exactly one named way per §6.1 rule.
 * Nothing here is a real authority: the key is derived from a seed string, the
 * root is trusted only by the kit's own verifier configuration, and no vendor
 * name or endpoint appears anywhere (§14, standards-only).
 *
 * **Determinism.** Everything the token carries is a fixed constant or a pure
 * function of the seed and the subject digest: the certificate validity window
 * is `20260101000000Z .. 20360101000000Z`, `genTime` is a constant, the serial
 * numbers are constants, and `@noble/curves` signs deterministically (RFC 6979).
 * Nothing reads the wall clock -- the captured real tokens' `genTime` values are
 * historical, and a kit that drifted with the clock could not assert against
 * either. The kit-minted canonical token is committed under
 * `fixtures/anchor-kit-v1/` so the cross-validation transcript keeps describing
 * bytes that exist; a builder change that moves those bytes fails loudly.
 *
 * **Signature scope.** The authority signs with P-256 only. RSA production
 * output -- including the bare `rsaEncryption` SignerInfo algorithm that real
 * authorities emit -- is covered by the captured real tokens, not synthesized
 * here: minting RSA would mean shipping an RSA implementation in a kit whose
 * whole point is to be small and auditable.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { p256 } from "@noble/curves/nist.js";
import {
  OID_CONTENT_TYPE_ATTRIBUTE,
  OID_ECDSA_WITH_SHA256,
  OID_ID_CT_TST_INFO,
  OID_ID_KP_TIME_STAMPING,
  OID_ID_SIGNED_DATA,
  OID_MESSAGE_DIGEST_ATTRIBUTE,
  OID_SHA256,
  OID_SIGNING_CERTIFICATE_ATTRIBUTE,
  OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE,
  DER_TAG,
  derGeneralizedTimeToRfc3339,
} from "@jinn-network/trust-core";

import {
  bytesToHex,
  concatenateBytes,
  contextConstructed,
  derBitString,
  derBoolean,
  derExplicit,
  derGeneralizedTime,
  derImplicitConstructed,
  derIndefiniteLength,
  derInteger,
  derIntegerFromContent,
  derOctetString,
  derOid,
  derSequence,
  derSet,
  derSetOf,
  derUtcTime,
  derUtf8String,
  hexToBytes,
  retagAsSetOf,
  retagDer,
} from "./der-encoder.js";

// --- OIDs this module needs beyond trust-core's pinned set -----------------

/** CMS `id-data` -- the wrong eContentType and the wrong contentType attribute
 * value both point here, because it is the one an inattentive producer reaches
 * for. */
export const OID_ID_DATA = "1.2.840.113549.1.7.1";
export const OID_ID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
export const OID_PRIME256V1 = "1.2.840.10045.3.1.7";
/** `ecdsa-with-SHA1` -- refused by §6.1 rule 5's signature-algorithm floor. */
export const OID_ECDSA_WITH_SHA1 = "1.2.840.10045.4.1";
/** `id-sha1` -- refused by rule 5 wherever a digest algorithm can appear. */
export const OID_SHA1 = "1.3.14.3.2.26";
export const OID_AT_COMMON_NAME = "2.5.4.3";
export const OID_EXT_SUBJECT_KEY_IDENTIFIER = "2.5.29.14";
export const OID_EXT_KEY_USAGE = "2.5.29.15";
export const OID_EXT_EXTENDED_KEY_USAGE = "2.5.29.37";
export const OID_ID_KP_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

/**
 * The kit's TSA policy and its unknown-critical-extension OID, both under
 * `2.999`, the arc ITU-T X.660 designates for examples and testing. A kit that
 * borrowed a real authority's policy arc would be asserting something about
 * that authority.
 */
export const KIT_TSA_POLICY_OID = "2.999.1";
export const KIT_UNKNOWN_TST_EXTENSION_OID = "2.999.2";

// --- Fixed constants (never the wall clock) --------------------------------

export const KIT_CERTIFICATE_NOT_BEFORE_UTC = "260101000000Z";
export const KIT_CERTIFICATE_NOT_AFTER_UTC = "360101000000Z";
export const KIT_CERTIFICATE_NOT_BEFORE_RFC3339 = "2026-01-01T00:00:00Z";
export const KIT_CERTIFICATE_NOT_AFTER_RFC3339 = "2036-01-01T00:00:00Z";

/** Inside the certificate window by construction. */
export const KIT_GEN_TIME = "20260817120000Z";
/** Before `KIT_CERTIFICATE_NOT_BEFORE_UTC` -- the §6.1 rule 11 window negative. */
export const KIT_GEN_TIME_OUTSIDE_VALIDITY = "20200101000000Z";

export const KIT_CERTIFICATE_SERIAL_HEX = "5c1a7f0000000000000000000000000001";
export const KIT_OTHER_CERTIFICATE_SERIAL_HEX = "5c1a7f0000000000000000000000000002";
export const KIT_TOKEN_SERIAL_HEX = "0102030405060708090a0b0c0d0e0f10";

export const KIT_ACCURACY_SECONDS = 1;

// --- Types ------------------------------------------------------------------

/**
 * One named mutation per §6.1 rule (and per the §11 RFC 3161 negative list).
 * Options compose only where composition is meaningful; the kit's own case set
 * uses exactly one at a time, so each negative names one rule.
 */
export interface TimeStampTokenMutations {
  /** Rule 1a: outer `ContentInfo.contentType` is not `id-signedData`. */
  readonly wrongContentType?: boolean;
  /** Rule 1b: `eContentType` is not `id-ct-TSTInfo`. */
  readonly wrongEContentType?: boolean;
  /** Rule 2a: `TSTInfo.version` is not 1. */
  readonly tstInfoVersion?: number;
  /** Rule 2b: a critical TSTInfo extension this profile does not know. */
  readonly unknownCriticalExtension?: boolean;
  /** Rule 3: two `SignerInfo`s, which RFC 3161 does not permit. */
  readonly twoSignerInfos?: boolean;
  /** Rule 4a: `signedAttrs` absent (the signature then covers `eContent`). */
  readonly omitSignedAttrs?: boolean;
  /** Rule 4b: the `contentType` attribute names something else. */
  readonly wrongContentTypeAttribute?: boolean;
  /** Rule 4c: the `messageDigest` attribute is not the digest of `eContent`. */
  readonly wrongMessageDigestAttribute?: boolean;
  /** Rule 5a: SHA-1 `messageImprint.hashAlgorithm`. */
  readonly sha1Imprint?: boolean;
  /** Rule 5b: SHA-1 SignerInfo `digestAlgorithm`. */
  readonly sha1SignerInfoDigest?: boolean;
  /** Rule 5c: a signature algorithm whose digest component is SHA-1. */
  readonly sha1SignatureAlgorithm?: boolean;
  /** Rule 6a: the v1 `SigningCertificate` attribute (ESSCertID is SHA-1). */
  readonly signingCertificateV1?: boolean;
  /** Rule 6b: `SigningCertificateV2` names a certificate not embedded. */
  readonly signingCertificateV2NamesAbsentCertificate?: boolean;
  /** Rule 6c: no embedded certificate at all. */
  readonly omitEmbeddedCertificate?: boolean;
  /** Rule 7: `sid` names a different issuer and serial than the embedded cert. */
  readonly inconsistentSid?: boolean;
  /** Rule 8a: the signature covers `eContent` instead of the `signedAttrs`
   * SET OF re-encoding. */
  readonly signOverEContent?: boolean;
  /** Rule 8b: a structurally sound signature made by a different key. */
  readonly brokenSignature?: boolean;
  /** Rule 4c, the interesting direction: `eContent` is altered after the
   * `messageDigest` attribute was computed, so `signedAttrs` and its signature
   * stay internally valid and only the digest comparison catches it. */
  readonly tamperedEContent?: boolean;
  /** Rule 9a: extended key usage carries an additional usage. */
  readonly additionalExtendedKeyUsage?: boolean;
  /** Rule 9b: no extended key usage extension at all. */
  readonly omitExtendedKeyUsage?: boolean;
  /** Rule 10: the TSTInfo `tsa` field names something that is not among the
   * certificate's own subject names. */
  readonly tsaNameMismatch?: boolean;
  /** Rule 11a: `genTime` outside the signer certificate's validity window. */
  readonly genTimeOutsideValidity?: boolean;
  /** Rule 11b: `genTime` that is not DER GeneralizedTime in Zulu form with
   * seconds and no trailing fractional zeros. */
  readonly malformedGenTime?: "trailing-fraction-zeros" | "missing-zulu" | "missing-seconds";
  /** Rule 12: `messageImprint.hashedMessage` is not the subject digest. */
  readonly imprintMismatch?: boolean;
  /** Parsing discipline: the outer `ContentInfo` uses indefinite-length BER. */
  readonly indefiniteLengthOuter?: boolean;
}

export interface MintTimeStampTokenOptions extends TimeStampTokenMutations {
  /** The subject digest the token is minted over: 32 bytes, or its 64-character
   * lowercase hex spelling. */
  readonly subjectSha256: Uint8Array | string;
  readonly genTime?: string;
  readonly policyOid?: string;
  readonly tokenSerialHex?: string;
  /** Omit the optional `accuracy` field. */
  readonly omitAccuracy?: boolean;
  /** Omit the optional `tsa` field (rule 10 applies only when present). */
  readonly omitTsaField?: boolean;
}

/**
 * The §6.1 extracted facts a conformant verifier reports for a valid token.
 *
 * Renderings, and which of them the design pins:
 *
 * - `genTime` -- pinned by §6.1 ("Time semantics"): the positional transform of
 *   the DER GeneralizedTime to RFC 3339 UTC, preserving the token's precision.
 * - `policyOid`, `signatureAlgorithmOid` -- dotted strings, the only rendering
 *   `decodeOid` produces.
 * - `signerCertificateSha256` -- 64 lowercase hex, matching every other digest
 *   spelling in this tree.
 * - `serialNumber` -- **kit-pinned, not spec-pinned**: lowercase hex of the DER
 *   INTEGER content octets, exactly as encoded. §7.4 byte-compares this fact in
 *   the claim package but §6.1 never pins its rendering; hex of the encoded
 *   octets is chosen because DER INTEGERs are minimal (so the spelling is
 *   unique), it survives serial numbers far beyond `Number`, and it raises no
 *   sign question. Recorded as a finding for the design owner.
 */
export interface Rfc3161ExpectedFacts {
  readonly genTime: string;
  readonly policyOid: string;
  readonly serialNumber: string;
  readonly signerCertificateSha256: string;
  readonly signatureAlgorithmOid: string;
}

export interface MintedTimeStampToken {
  /** The DER `TimeStampToken` -- the CMS `ContentInfo`, not a `TimeStampResp`. */
  readonly tokenDer: Uint8Array;
  /** The certificate embedded in the token (still reported when the mutation
   * omitted it from the token, so a test can supply it as trust material). */
  readonly signerCertificateDer: Uint8Array;
  /** The token's own `genTime` string, exactly as encoded. */
  readonly genTimeDer: string;
  /** The subject digest the token was minted over, 64 lowercase hex. */
  readonly subjectSha256: string;
  /** What a conformant verifier extracts from a valid token. Reported for every
   * mint; meaningful only where the token is not mutated into refusal. */
  readonly facts: Rfc3161ExpectedFacts;
}

export interface FixtureAuthority {
  readonly seed: string;
  /** The conformant self-signed authority certificate: the kit's trust material,
   * and the only root a kit verifier configuration ever trusts. */
  readonly certificateDer: Uint8Array;
  readonly certificateSha256: string;
  /** Exact DER of the `GeneralName` (directoryName form) the certificate
   * presents for itself -- what §6.1 rule 10 compares `tsa` against. */
  readonly subjectGeneralNameDer: Uint8Array;
  readonly notBefore: string;
  readonly notAfter: string;
  mintTimeStampToken(options: MintTimeStampTokenOptions): MintedTimeStampToken;
}

// --- Structure builders -----------------------------------------------------

function algorithmIdentifier(oid: string, parameters?: Uint8Array): Uint8Array {
  return parameters === undefined ? derSequence(derOid(oid)) : derSequence(derOid(oid), parameters);
}

function distinguishedName(commonName: string): Uint8Array {
  return derSequence(derSetOf(derSequence(derOid(OID_AT_COMMON_NAME), derUtf8String(commonName))));
}

/** `GeneralName ::= CHOICE { ... directoryName [4] Name ... }`; the tag is
 * explicit because `Name` is itself a CHOICE. */
function directoryGeneralName(name: Uint8Array): Uint8Array {
  return derExplicit(4, name);
}

function extension(oid: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical
    ? derSequence(derOid(oid), derBoolean(true), derOctetString(value))
    : derSequence(derOid(oid), derOctetString(value));
}

interface CertificateInput {
  readonly commonName: string;
  readonly serialHex: string;
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly extendedKeyUsageOids: readonly string[] | null;
}

function buildSelfSignedCertificate(input: CertificateInput): Uint8Array {
  const name = distinguishedName(input.commonName);
  const spki = derSequence(
    derSequence(derOid(OID_ID_EC_PUBLIC_KEY), derOid(OID_PRIME256V1)),
    derBitString(input.publicKey),
  );
  // RFC 5280 admits any key-identifier derivation that yields a unique value;
  // the conventional SHA-1 method is avoided so the kit never encodes SHA-1
  // where it does not have to.
  const subjectKeyIdentifier = sha256(input.publicKey).slice(0, 20);
  const extensions = [
    extension(OID_EXT_SUBJECT_KEY_IDENTIFIER, false, derOctetString(subjectKeyIdentifier)),
    // digitalSignature only: an authority certificate asserting keyCertSign
    // fails the timestamp-signing purpose check in independent verifiers.
    extension(OID_EXT_KEY_USAGE, true, derBitString(Uint8Array.of(0x80), 7)),
    ...(input.extendedKeyUsageOids === null
      ? []
      : [
        // RFC 3161 requires this extension to be critical as well as sole.
        extension(
          OID_EXT_EXTENDED_KEY_USAGE,
          true,
          derSequence(...input.extendedKeyUsageOids.map((oid) => derOid(oid))),
        ),
      ]),
  ];
  const tbsCertificate = derSequence(
    derExplicit(0, derInteger(2)),
    derIntegerFromContent(hexToBytes(input.serialHex)),
    algorithmIdentifier(OID_ECDSA_WITH_SHA256),
    name,
    derSequence(
      derUtcTime(KIT_CERTIFICATE_NOT_BEFORE_UTC),
      derUtcTime(KIT_CERTIFICATE_NOT_AFTER_UTC),
    ),
    name,
    spki,
    derExplicit(3, derSequence(...extensions)),
  );
  const signature = p256.sign(sha256(tbsCertificate), input.privateKey, {
    format: "der",
    prehash: false,
  });
  return derSequence(
    tbsCertificate,
    algorithmIdentifier(OID_ECDSA_WITH_SHA256),
    derBitString(signature),
  );
}

function attribute(oid: string, ...values: readonly Uint8Array[]): Uint8Array {
  return derSequence(derOid(oid), derSetOf(...values));
}

/** `ESSCertIDv2 ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier DEFAULT sha256,
 * certHash OCTET STRING, issuerSerial IssuerSerial OPTIONAL }`. DER omits a
 * DEFAULT value, so the SHA-256 algorithm identifier is absent here exactly as
 * it is absent from production tokens: a rule engine reads "absent" as SHA-256
 * rather than as "unspecified". */
function signingCertificateV2Attribute(certificateDer: Uint8Array): Uint8Array {
  return attribute(
    OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE,
    derSequence(derSequence(derSequence(derOctetString(sha256(certificateDer))))),
  );
}

/** The v1 attribute, whose `ESSCertID` is SHA-1 by definition (§6.1 rule 6). */
function signingCertificateV1Attribute(certificateDer: Uint8Array): Uint8Array {
  return attribute(
    OID_SIGNING_CERTIFICATE_ATTRIBUTE,
    derSequence(derSequence(derSequence(derOctetString(sha1(certificateDer))))),
  );
}

function issuerAndSerialNumber(name: Uint8Array, serialHex: string): Uint8Array {
  return derSequence(name, derIntegerFromContent(hexToBytes(serialHex)));
}

function normalizeSubjectDigest(subject: Uint8Array | string): Uint8Array {
  if (typeof subject === "string") {
    if (!/^[0-9a-f]{64}$/.test(subject)) {
      throw new Error("A subject digest string must be 64 lowercase hex characters.");
    }
    return hexToBytes(subject);
  }
  if (subject.length !== 32) {
    throw new Error(`A SHA-256 subject digest is 32 bytes, not ${subject.length}.`);
  }
  return subject;
}

function malformedGenTimeValue(variant: NonNullable<TimeStampTokenMutations["malformedGenTime"]>): string {
  switch (variant) {
    case "trailing-fraction-zeros":
      return "20260817120000.500Z";
    case "missing-zulu":
      return "20260817120000";
    case "missing-seconds":
      return "202608171200Z";
  }
}

// --- The authority ----------------------------------------------------------

/**
 * Derives a deterministic P-256 authority from `seed` -- the same shape as
 * `createEoaTestSigner(seed)`, and for the same reason: fixtures that are
 * reproducible byte-for-byte across runs and hosts.
 */
export function createFixtureAuthority(seed: string): FixtureAuthority {
  const privateKey = sha256(new TextEncoder().encode(`jinn-anchor-kit-authority:${seed}`));
  const publicKey = p256.getPublicKey(privateKey, false);
  // A second key that never signs a conformant token: the broken-signature
  // mutation signs the right bytes with the wrong key, so the signature stays
  // structurally sound and fails only where rule 8 checks it.
  const decoyPrivateKey = sha256(new TextEncoder().encode(`jinn-anchor-kit-decoy:${seed}`));

  const commonName = `Jinn anchor kit fixture authority (${seed})`;
  const otherCommonName = `Jinn anchor kit unrelated certificate (${seed})`;

  const certificate = buildSelfSignedCertificate({
    commonName,
    serialHex: KIT_CERTIFICATE_SERIAL_HEX,
    publicKey,
    privateKey,
    extendedKeyUsageOids: [OID_ID_KP_TIME_STAMPING],
  });
  const otherCertificate = buildSelfSignedCertificate({
    commonName: otherCommonName,
    serialHex: KIT_OTHER_CERTIFICATE_SERIAL_HEX,
    publicKey: p256.getPublicKey(decoyPrivateKey, false),
    privateKey: decoyPrivateKey,
    extendedKeyUsageOids: [OID_ID_KP_TIME_STAMPING],
  });

  const subjectName = distinguishedName(commonName);
  const otherSubjectName = distinguishedName(otherCommonName);

  function mintTimeStampToken(options: MintTimeStampTokenOptions): MintedTimeStampToken {
    const subjectDigest = normalizeSubjectDigest(options.subjectSha256);

    // The signer certificate, which the extended-key-usage mutations change.
    const signerCertificate = options.additionalExtendedKeyUsage || options.omitExtendedKeyUsage
      ? buildSelfSignedCertificate({
        commonName,
        serialHex: KIT_CERTIFICATE_SERIAL_HEX,
        publicKey,
        privateKey,
        extendedKeyUsageOids: options.omitExtendedKeyUsage
          ? null
          : [OID_ID_KP_TIME_STAMPING, OID_ID_KP_CLIENT_AUTH],
      })
      : certificate;

    // --- TSTInfo ---------------------------------------------------------
    const imprintAlgorithmOid = options.sha1Imprint ? OID_SHA1 : OID_SHA256;
    const hashedMessage = options.sha1Imprint
      // The subject is already a digest, so there is no preimage to re-hash;
      // the truncation is immaterial because rule 5's algorithm floor refuses
      // this token before rule 12 ever compares the bytes.
      ? subjectDigest.slice(0, 20)
      : options.imprintMismatch
        ? concatenateBytes([
          subjectDigest.slice(0, 31),
          Uint8Array.of(subjectDigest[31]! ^ 0xff),
        ])
        : subjectDigest;

    const genTimeValue = options.malformedGenTime !== undefined
      ? malformedGenTimeValue(options.malformedGenTime)
      : options.genTimeOutsideValidity
        ? KIT_GEN_TIME_OUTSIDE_VALIDITY
        : options.genTime ?? KIT_GEN_TIME;
    const policyOid = options.policyOid ?? KIT_TSA_POLICY_OID;
    const tokenSerialHex = options.tokenSerialHex ?? KIT_TOKEN_SERIAL_HEX;

    const tsaGeneralName = directoryGeneralName(
      options.tsaNameMismatch ? otherSubjectName : subjectName,
    );

    const buildTstInfo = (serialHex: string): Uint8Array =>
      derSequence(
        derInteger(options.tstInfoVersion ?? 1),
        derOid(policyOid),
        derSequence(
          algorithmIdentifier(imprintAlgorithmOid),
          derOctetString(hashedMessage),
        ),
        derIntegerFromContent(hexToBytes(serialHex)),
        derGeneralizedTime(genTimeValue),
        ...(options.omitAccuracy ? [] : [derSequence(derInteger(KIT_ACCURACY_SECONDS))]),
        ...(options.omitTsaField ? [] : [derExplicit(0, tsaGeneralName)]),
        ...(options.unknownCriticalExtension
          ? [
            derImplicitConstructed(
              1,
              derSequence(
                derOid(KIT_UNKNOWN_TST_EXTENSION_OID),
                derBoolean(true),
                derOctetString(Uint8Array.of(0x00)),
              ),
            ),
          ]
          : []),
      );

    // The signed content, and -- for the tampered-eContent fixture -- the
    // different content actually carried. Both are valid DER of the same
    // length, so only the digest comparison distinguishes them.
    const signedEContent = buildTstInfo(tokenSerialHex);
    const carriedEContent = options.tamperedEContent
      ? buildTstInfo(`${tokenSerialHex.slice(0, -2)}ff`)
      : signedEContent;

    // --- SignerInfo ------------------------------------------------------
    const digestAlgorithmOid = options.sha1SignerInfoDigest ? OID_SHA1 : OID_SHA256;
    const digest = options.sha1SignerInfoDigest ? sha1 : sha256;
    const signatureAlgorithmOid = options.sha1SignatureAlgorithm
      ? OID_ECDSA_WITH_SHA1
      : OID_ECDSA_WITH_SHA256;

    const certHashTarget = options.signingCertificateV2NamesAbsentCertificate
      ? otherCertificate
      : signerCertificate;

    const signedAttributes = options.omitSignedAttrs
      ? undefined
      : derSetOf(
        attribute(
          OID_CONTENT_TYPE_ATTRIBUTE,
          derOid(options.wrongContentTypeAttribute ? OID_ID_DATA : OID_ID_CT_TST_INFO),
        ),
        attribute(
          OID_MESSAGE_DIGEST_ATTRIBUTE,
          derOctetString(
            options.wrongMessageDigestAttribute ? new Uint8Array(32) : digest(signedEContent),
          ),
        ),
        options.signingCertificateV1
          ? signingCertificateV1Attribute(certHashTarget)
          : signingCertificateV2Attribute(certHashTarget),
      );

    // Rule 8: the signature covers the SET OF re-encoding of signedAttrs. The
    // two refusal shapes are covering eContent instead, and (when signedAttrs
    // is absent) covering eContent because CMS says so -- which is exactly the
    // downgrade rule 4 exists to refuse.
    const signedBytes = signedAttributes === undefined || options.signOverEContent
      ? signedEContent
      : retagAsSetOf(signedAttributes);
    const signatureDigest = options.sha1SignatureAlgorithm ? sha1 : sha256;
    const signature = p256.sign(
      signatureDigest(signedBytes),
      options.brokenSignature ? decoyPrivateKey : privateKey,
      { format: "der", prehash: false },
    );

    const sid = options.inconsistentSid
      ? issuerAndSerialNumber(otherSubjectName, KIT_OTHER_CERTIFICATE_SERIAL_HEX)
      : issuerAndSerialNumber(subjectName, KIT_CERTIFICATE_SERIAL_HEX);

    const signerInfo = derSequence(
      derInteger(1),
      sid,
      algorithmIdentifier(digestAlgorithmOid),
      ...(signedAttributes === undefined
        // signedAttrs travels under an IMPLICIT [0] tag; only the signature's
        // own copy carries the explicit SET OF tag.
        ? []
        : [retagDer(signedAttributes, contextConstructed(0))]),
      algorithmIdentifier(signatureAlgorithmOid),
      derOctetString(signature),
    );

    // --- SignedData ------------------------------------------------------
    const signedData = derSequence(
      // RFC 5652 §5.1: version is 3 whenever eContentType is not id-data,
      // which for a timestamp token it never is.
      derInteger(3),
      derSet(algorithmIdentifier(digestAlgorithmOid)),
      derSequence(
        derOid(options.wrongEContentType ? OID_ID_DATA : OID_ID_CT_TST_INFO),
        derExplicit(0, derOctetString(carriedEContent)),
      ),
      ...(options.omitEmbeddedCertificate
        ? []
        : [derImplicitConstructed(0, signerCertificate)]),
      ...(options.twoSignerInfos
        ? [derSet(signerInfo, signerInfo)]
        : [derSet(signerInfo)]),
    );

    const contentTypeOid = derOid(options.wrongContentType ? OID_ID_DATA : OID_ID_SIGNED_DATA);
    const outerContent = concatenateBytes([contentTypeOid, derExplicit(0, signedData)]);
    const tokenDer = options.indefiniteLengthOuter
      ? derIndefiniteLength(DER_TAG.SEQUENCE, outerContent)
      : derSequence(contentTypeOid, derExplicit(0, signedData));

    return {
      tokenDer,
      signerCertificateDer: signerCertificate,
      genTimeDer: genTimeValue,
      subjectSha256: bytesToHex(subjectDigest),
      facts: {
        // The malformed variants exist to be refused, so no RFC 3339 rendering
        // is claimed for them; the DER string is reported as-is instead.
        genTime: options.malformedGenTime === undefined
          ? derGeneralizedTimeToRfc3339(genTimeValue)
          : genTimeValue,
        policyOid,
        serialNumber: tokenSerialHex,
        signerCertificateSha256: bytesToHex(sha256(signerCertificate)),
        signatureAlgorithmOid,
      },
    };
  }

  return {
    seed,
    certificateDer: certificate,
    certificateSha256: bytesToHex(sha256(certificate)),
    subjectGeneralNameDer: directoryGeneralName(subjectName),
    notBefore: KIT_CERTIFICATE_NOT_BEFORE_RFC3339,
    notAfter: KIT_CERTIFICATE_NOT_AFTER_RFC3339,
    mintTimeStampToken,
  };
}
