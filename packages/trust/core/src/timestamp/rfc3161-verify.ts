// SPDX-License-Identifier: Apache-2.0

/**
 * The RFC 3161 timestamp-token rule engine (anchor-evidence design §6.1).
 *
 * This is the pure half of the §4.3 provider contract for the profile
 * `rfc3161-tsa/v1`: it reads one DER `TimeStampToken` through P1's
 * definite-length reader, applies §6.1 rules 1-12, and produces the exact bytes
 * the signature must cover. Every platform primitive it cannot perform without
 * I/O or a parser it must not hand-write -- signature verification, certificate
 * reading, chain validation -- crosses the boundary as one of the three injected
 * ports (§6.1 "Placement", `anchor-provider.ts`). Nothing here imports `node:`
 * anything, and the algorithm allowlists in `oids.ts` are the only algorithm
 * authority.
 *
 * Four disciplines shape the code below, each of them load-bearing:
 *
 * - **A rule failure is a returned `invalid`, never a thrown error.** The
 *   consuming check (§8) must be able to report every anchor a bundle carries,
 *   so a malformed token cannot be allowed to abort the walk. Refusals are
 *   raised internally and converted at the single exit; a throwing port is
 *   caught the same way.
 * - **`present` is the default, `verified` is earned.** Rules 1-12 passing
 *   yields `present` with extracted facts. `verified` additionally requires the
 *   embedded chain to validate against roots *the caller supplied* -- absent or
 *   empty roots can never yield it (§4.3, §8 step 3). Only `verified` reports an
 *   evaluated `time`; routing the §8 step-4 splice-catch through `facts.genTime`
 *   instead is what keeps that catch alive in the default configuration.
 * - **A chain that does not reach the caller's roots is `present`, not
 *   `invalid`.** Authority acceptability is consumer policy (§4.2): verification
 *   identifies the authority, it never endorses one, and an operator's
 *   incomplete root set is not an accusation against the proof. This mirrors the
 *   conformance kit's OpenTimestamps reasoning for an unsupplied block header.
 * - **Facts are extracted, never asserted.** The five §6.1 facts (plus
 *   `accuracy` where the token carries it) are read out of the bytes the
 *   authority signed. The issuer distinguished name is deliberately not among
 *   them: DN-to-string rendering is not canonical across implementations.
 *
 * Two readings this engine pins, both recorded for the design owner:
 *
 * - **Rule 6 is a requirement on v2, not a prohibition on v1.** A production
 *   token may carry the v1 `SigningCertificate` attribute *alongside* the v2
 *   one -- the committed RSA production capture does -- and must still verify. What
 *   refuses is the absence of a binding `SigningCertificateV2`, so the v1
 *   attribute is never read at all. `ESSCertIDv2.hashAlgorithm` absent means
 *   SHA-256 by ASN.1 DEFAULT, not "unspecified".
 * - **Rule 12 requires a SHA-256 message imprint.** Rule 5's allowlist admits
 *   the whole SHA-256 family in the imprint, but the caller's subject digest is
 *   a SHA-256 (§5 admits no other DigestSet algorithm), so a token imprinting
 *   under SHA-384 or SHA-512 cannot be compared to it at all. Refusing is the
 *   honest answer; silently reporting `present` on an uncompared imprint would
 *   be the dangerous one.
 */

import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type {
  AnchorCertificateFacts,
  AnchorCertificateReader,
  AnchorChainVerifier,
  AnchorProofResult,
  AnchorProofVerificationInput,
  AnchorProofVerifier,
  AnchorSignatureVerifier,
  AnchorSignerIdentifier,
} from "../anchor-provider.js";
import { RFC3161_TSA_ANCHOR_PROFILE } from "../anchor-provider.js";
import { compareCalendarStrictRfc3339Instants } from "../rfc3339.js";
import { DER_TAG, decodeDer, decodeDerChildren, retagDerElement } from "./der.js";
import type { DerElement } from "./der.js";
import { derGeneralizedTimeToRfc3339, readDerGeneralizedTime } from "./generalized-time.js";
import {
  ALLOWED_IMPRINT_DIGEST_OIDS,
  ALLOWED_SIGNATURE_ALGORITHM_OIDS,
  ALLOWED_SIGNERINFO_DIGEST_OIDS,
  OID_CONTENT_TYPE_ATTRIBUTE,
  OID_ID_CT_TST_INFO,
  OID_ID_KP_TIME_STAMPING,
  OID_ID_SIGNED_DATA,
  OID_MESSAGE_DIGEST_ATTRIBUTE,
  OID_RSASSA_PSS,
  OID_SHA256,
  OID_SHA384,
  OID_SHA512,
  OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE,
  readDerOid,
} from "./oids.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** RFC 3161 `Accuracy`, in the units the token declares. The design reports the
 * interval (`genTime ± accuracy`) rather than folding it into `genTime`. */
export interface Rfc3161Accuracy {
  readonly seconds?: number;
  readonly millis?: number;
  readonly micros?: number;
}

/**
 * The §6.1 extracted facts. Renderings:
 *
 * - `genTime` -- the pinned positional transform of the token's DER
 *   GeneralizedTime to RFC 3339 UTC, at the token's own precision.
 * - `policyOid`, `signatureAlgorithmOid` -- dotted strings.
 * - `serialNumber` -- lowercase hex of the DER INTEGER content octets, exactly
 *   as encoded. DER integers are minimal, so the spelling is unique; it survives
 *   serials far beyond `Number`, and raises no sign question.
 * - `signerCertificateSha256` -- 64 lowercase hex over the embedded signer
 *   certificate's DER. This is the disclosure that makes the trust decision
 *   actionable: a reader compares it against the authority's published
 *   certificate themselves.
 */
export interface Rfc3161AnchorFacts {
  readonly genTime: string;
  readonly policyOid: string;
  readonly serialNumber: string;
  readonly signerCertificateSha256: string;
  readonly signatureAlgorithmOid: string;
  readonly accuracy?: Rfc3161Accuracy;
}

/**
 * Verifier-side trust material: the root certificates the verifier's operator
 * chose to trust, in DER. Strictly caller-side -- a verifier ships with none,
 * and an empty set can never yield `verified` (§8 step 3).
 */
export interface Rfc3161AnchorTrustMaterial {
  readonly trustAnchorsDer: readonly Uint8Array[];
}

/** The three injected ports §6.1 "Placement" names. */
export interface Rfc3161AnchorProofVerifierPorts {
  readonly signatureVerifier: AnchorSignatureVerifier;
  readonly certificateReader: AnchorCertificateReader;
  readonly chainVerifier: AnchorChainVerifier;
}

export type Rfc3161AnchorProofVerifier = AnchorProofVerifier<
  Rfc3161AnchorFacts,
  Rfc3161AnchorTrustMaterial
>;

// ---------------------------------------------------------------------------
// Internal refusal plumbing
// ---------------------------------------------------------------------------

/** A rule refusal in flight. Never escapes `verifyProof`. */
class Rfc3161Refusal extends Error {
  override readonly name = "Rfc3161Refusal";
}

function refuse(reason: string): never {
  throw new Rfc3161Refusal(reason);
}

// ---------------------------------------------------------------------------
// Small DER readers this profile needs beyond P1's primitives
// ---------------------------------------------------------------------------

const CONTEXT_CONSTRUCTED_0 = 0xa0;
const CONTEXT_CONSTRUCTED_1 = 0xa1;
const CONTEXT_PRIMITIVE_0 = 0x80;
const CONTEXT_PRIMITIVE_1 = 0x81;

type DigestFunction = (bytes: Uint8Array) => Uint8Array;

const DIGEST_FUNCTIONS: ReadonlyMap<string, DigestFunction> = new Map<string, DigestFunction>([
  [OID_SHA256, sha256],
  [OID_SHA384, sha384],
  [OID_SHA512, sha512],
]);

function children(element: DerElement, label: string): readonly DerElement[] {
  if (!element.constructed) refuse(`${label} must be a constructed element.`);
  return decodeDerChildren(element);
}

function expect(element: DerElement, identifier: number, label: string): DerElement {
  if (element.identifier !== identifier) {
    refuse(
      `${label} has identifier 0x${element.identifier.toString(16)}, expected 0x${identifier.toString(16)}.`,
    );
  }
  return element;
}

/**
 * The single element a tagged position holds, refusing a supernumerary sibling.
 *
 * DER admits exactly one element inside `ContentInfo.content [0]` and inside
 * `eContent [0] EXPLICIT`, and exactly one `certificates [0]` field in a
 * SignedData. Reading the first and ignoring the rest is how a token grows a
 * second body that this reader never looks at but another verifier might, so a
 * second element is a refusal rather than remainder.
 */
function only(elements: readonly DerElement[], label: string): DerElement {
  if (elements.length !== 1) {
    refuse(`${label} holds ${elements.length} element(s); DER admits exactly one.`);
  }
  return elements[0]!;
}

function at(elements: readonly DerElement[], index: number, label: string): DerElement {
  const element = elements[index];
  if (element === undefined) refuse(`${label} is missing.`);
  return element;
}

/** Reads a DER INTEGER as a JavaScript number, refusing anything a small
 * structural field could not legitimately be. */
function readSmallInteger(element: DerElement, label: string): number {
  expect(element, DER_TAG.INTEGER, label);
  if (element.content.length > 6) refuse(`${label} is larger than this profile reads.`);
  let value = 0;
  const negative = (element.content[0]! & 0x80) !== 0;
  for (const octet of element.content) value = value * 256 + octet;
  if (negative) refuse(`${label} is negative.`);
  return value;
}

interface AlgorithmIdentifierParts {
  readonly oid: string;
  /** Exact DER of `parameters` when the identifier carries them. */
  readonly parameters?: Uint8Array;
}

function readAlgorithmIdentifier(element: DerElement, label: string): AlgorithmIdentifierParts {
  const parts = children(expect(element, DER_TAG.SEQUENCE, label), label);
  const oid = readDerOid(at(parts, 0, `${label} algorithm OID`));
  if (parts.length > 2) refuse(`${label} carries ${parts.length} elements.`);
  const parameters = parts[1];
  return parameters === undefined ? { oid } : { oid, parameters: parameters.bytes };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function digestUnder(oid: string, bytes: Uint8Array, label: string): Uint8Array {
  const digest = DIGEST_FUNCTIONS.get(oid);
  if (digest === undefined) refuse(`${label} names digest algorithm ${oid}, which is not admitted.`);
  return digest(bytes);
}

function hexToBytes32(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    refuse("subjectSha256 must be 64 lowercase hex characters.");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// CMS structure
// ---------------------------------------------------------------------------

interface SignerInfoParts {
  readonly sid: DerElement;
  readonly digestAlgorithm: AlgorithmIdentifierParts;
  readonly signedAttrs?: DerElement;
  readonly signatureAlgorithm: AlgorithmIdentifierParts;
  readonly signature: DerElement;
}

interface SignedDataParts {
  readonly eContentTypeOid: string;
  readonly eContent: Uint8Array;
  readonly certificates: readonly Uint8Array[];
  readonly signerInfo: SignerInfoParts;
}

/** ContentInfo -> SignedData -> the one SignerInfo (§6.1 rules 1 and 3). */
function readSignedData(proofBytes: Uint8Array): SignedDataParts {
  const contentInfo = children(
    expect(decodeDer(proofBytes), DER_TAG.SEQUENCE, "ContentInfo"),
    "ContentInfo",
  );
  if (contentInfo.length !== 2) {
    refuse(`ContentInfo carries ${contentInfo.length} elements, not a contentType and a content.`);
  }
  if (readDerOid(at(contentInfo, 0, "ContentInfo.contentType")) !== OID_ID_SIGNED_DATA) {
    refuse("ContentInfo.contentType is not id-signedData (§6.1 rule 1).");
  }
  const wrapper = expect(at(contentInfo, 1, "ContentInfo.content"), CONTEXT_CONSTRUCTED_0, "ContentInfo.content");
  const signedData = children(
    expect(
      only(children(wrapper, "ContentInfo.content"), "ContentInfo.content"),
      DER_TAG.SEQUENCE,
      "SignedData",
    ),
    "SignedData",
  );

  readSmallInteger(at(signedData, 0, "SignedData.version"), "SignedData.version");
  expect(at(signedData, 1, "SignedData.digestAlgorithms"), DER_TAG.SET, "SignedData.digestAlgorithms");

  const encapsulated = children(
    expect(at(signedData, 2, "EncapsulatedContentInfo"), DER_TAG.SEQUENCE, "EncapsulatedContentInfo"),
    "EncapsulatedContentInfo",
  );
  const eContentTypeOid = readDerOid(at(encapsulated, 0, "eContentType"));
  const eContentWrapper = expect(at(encapsulated, 1, "eContent"), CONTEXT_CONSTRUCTED_0, "eContent");
  const eContent = expect(
    only(children(eContentWrapper, "eContent"), "eContent"),
    DER_TAG.OCTET_STRING,
    "eContent OCTET STRING",
  ).content;

  const tail = signedData.slice(3);
  const certificateSets = tail.filter((element) => element.identifier === CONTEXT_CONSTRUCTED_0);
  if (certificateSets.length > 1) {
    refuse(`SignedData carries ${certificateSets.length} certificates fields; DER admits one.`);
  }
  const certificateSet = certificateSets[0];
  const signerInfoSets = tail.filter((element) => element.identifier === DER_TAG.SET);
  if (signerInfoSets.length !== 1) {
    refuse(`SignedData carries ${signerInfoSets.length} signerInfos SETs.`);
  }
  const signerInfos = children(signerInfoSets[0]!, "SignedData.signerInfos");
  // RFC 3161 permits exactly one signer (§6.1 rule 3).
  if (signerInfos.length !== 1) {
    refuse(`SignedData carries ${signerInfos.length} SignerInfos; RFC 3161 permits exactly one.`);
  }

  // CertificateChoices: a plain X.509 certificate is a SEQUENCE. The tagged
  // alternatives (attribute certificates, other) are not certificates this
  // profile can read, and are skipped rather than refused -- rule 6 refuses if
  // no *readable* certificate the attribute names is present.
  const certificates = certificateSet === undefined
    ? []
    : children(certificateSet, "SignedData.certificates")
      .filter((element) => element.identifier === DER_TAG.SEQUENCE)
      .map((element) => element.bytes);

  return {
    eContentTypeOid,
    eContent,
    certificates,
    signerInfo: readSignerInfo(signerInfos[0]!),
  };
}

function readSignerInfo(element: DerElement): SignerInfoParts {
  const parts = children(expect(element, DER_TAG.SEQUENCE, "SignerInfo"), "SignerInfo");
  readSmallInteger(at(parts, 0, "SignerInfo.version"), "SignerInfo.version");
  const sid = at(parts, 1, "SignerInfo.sid");
  const digestAlgorithm = readAlgorithmIdentifier(
    at(parts, 2, "SignerInfo.digestAlgorithm"),
    "SignerInfo.digestAlgorithm",
  );
  let index = 3;
  const candidate = parts[index];
  const signedAttrs = candidate !== undefined && candidate.identifier === CONTEXT_CONSTRUCTED_0
    ? (index += 1, candidate)
    : undefined;
  const signatureAlgorithm = readAlgorithmIdentifier(
    at(parts, index, "SignerInfo.signatureAlgorithm"),
    "SignerInfo.signatureAlgorithm",
  );
  const signature = expect(
    at(parts, index + 1, "SignerInfo.signature"),
    DER_TAG.OCTET_STRING,
    "SignerInfo.signature",
  );
  const trailing = parts.slice(index + 2);
  if (trailing.some((part) => part.identifier !== CONTEXT_CONSTRUCTED_1)) {
    refuse("SignerInfo carries an element beyond unsignedAttrs.");
  }
  return signedAttrs === undefined
    ? { sid, digestAlgorithm, signatureAlgorithm, signature }
    : { sid, digestAlgorithm, signedAttrs, signatureAlgorithm, signature };
}

// ---------------------------------------------------------------------------
// TSTInfo
// ---------------------------------------------------------------------------

interface TstInfoParts {
  readonly policyOid: string;
  readonly imprintAlgorithmOid: string;
  readonly hashedMessage: Uint8Array;
  readonly serialNumberHex: string;
  readonly genTimeDer: string;
  readonly accuracy?: Rfc3161Accuracy;
  readonly tsaGeneralName?: Uint8Array;
}

function readTstInfo(eContent: Uint8Array): TstInfoParts {
  const parts = children(expect(decodeDer(eContent), DER_TAG.SEQUENCE, "TSTInfo"), "TSTInfo");
  const version = readSmallInteger(at(parts, 0, "TSTInfo.version"), "TSTInfo.version");
  if (version !== 1) refuse(`TSTInfo.version is ${version}, not 1 (§6.1 rule 2).`);

  const policyOid = readDerOid(at(parts, 1, "TSTInfo.policy"));
  const imprint = children(
    expect(at(parts, 2, "TSTInfo.messageImprint"), DER_TAG.SEQUENCE, "TSTInfo.messageImprint"),
    "TSTInfo.messageImprint",
  );
  const imprintAlgorithm = readAlgorithmIdentifier(
    at(imprint, 0, "messageImprint.hashAlgorithm"),
    "messageImprint.hashAlgorithm",
  );
  const hashedMessage = expect(
    at(imprint, 1, "messageImprint.hashedMessage"),
    DER_TAG.OCTET_STRING,
    "messageImprint.hashedMessage",
  ).content;

  const serialNumber = expect(at(parts, 3, "TSTInfo.serialNumber"), DER_TAG.INTEGER, "TSTInfo.serialNumber");
  const genTimeDer = readDerGeneralizedTime(at(parts, 4, "TSTInfo.genTime"));

  // The optional tail, in its ASN.1 order: accuracy, ordering, nonce, tsa [0],
  // extensions [1]. Each is identified by its tag, so an out-of-order encoding
  // simply fails to match and lands in the trailing-element refusal below.
  let index = 5;
  let accuracy: Rfc3161Accuracy | undefined;
  if (parts[index]?.identifier === DER_TAG.SEQUENCE) {
    accuracy = readAccuracy(parts[index]!);
    index += 1;
  }
  if (parts[index]?.identifier === DER_TAG.BOOLEAN) index += 1;
  if (parts[index]?.identifier === DER_TAG.INTEGER) index += 1;
  let tsaGeneralName: Uint8Array | undefined;
  if (parts[index]?.identifier === CONTEXT_CONSTRUCTED_0) {
    // tsa [0] EXPLICIT GeneralName -- the GeneralName TLV is the content.
    tsaGeneralName = at(children(parts[index]!, "TSTInfo.tsa"), 0, "TSTInfo.tsa GeneralName").bytes;
    index += 1;
  }
  if (parts[index]?.identifier === CONTEXT_CONSTRUCTED_1) {
    assertNoCriticalExtension(parts[index]!);
    index += 1;
  }
  if (index !== parts.length) refuse("TSTInfo carries an element this profile does not read.");

  return {
    policyOid,
    imprintAlgorithmOid: imprintAlgorithm.oid,
    hashedMessage,
    serialNumberHex: bytesToHex(serialNumber.content),
    genTimeDer,
    ...(accuracy === undefined ? {} : { accuracy }),
    ...(tsaGeneralName === undefined ? {} : { tsaGeneralName }),
  };
}

/** `Accuracy ::= SEQUENCE { seconds INTEGER OPTIONAL, millis [0] IMPLICIT
 * INTEGER OPTIONAL, micros [1] IMPLICIT INTEGER OPTIONAL }`. */
function readAccuracy(element: DerElement): Rfc3161Accuracy {
  const accuracy: { seconds?: number; millis?: number; micros?: number } = {};
  for (const part of children(element, "TSTInfo.accuracy")) {
    if (part.identifier === DER_TAG.INTEGER) {
      accuracy.seconds = readSmallInteger(part, "accuracy.seconds");
    } else if (part.identifier === CONTEXT_PRIMITIVE_0) {
      accuracy.millis = readImplicitInteger(part, "accuracy.millis");
    } else if (part.identifier === CONTEXT_PRIMITIVE_1) {
      accuracy.micros = readImplicitInteger(part, "accuracy.micros");
    } else {
      refuse("TSTInfo.accuracy carries an element this profile does not read.");
    }
  }
  return accuracy;
}

/** An IMPLICIT-tagged INTEGER: the content octets are an INTEGER's, but the
 * identifier is context-class, so the reader's universal INTEGER checks did not
 * run over it. */
function readImplicitInteger(element: DerElement, label: string): number {
  if (element.content.length === 0 || element.content.length > 6) {
    refuse(`${label} is outside the range this profile reads.`);
  }
  if ((element.content[0]! & 0x80) !== 0) refuse(`${label} is negative.`);
  let value = 0;
  for (const octet of element.content) value = value * 256 + octet;
  return value;
}

/**
 * §6.1 rule 2: every TSTInfo extension marked critical must be known to this
 * profile, and v1 knows none -- so any critical extension refuses. Non-critical
 * unknown extensions are ignored, which is what `critical` means.
 *
 * The shape is checked before the flag is read, and that order is the rule.
 * `Extension ::= SEQUENCE { extnID OBJECT IDENTIFIER, critical BOOLEAN DEFAULT
 * FALSE, extnValue OCTET STRING }` puts the flag in the middle; an encoder that
 * emits `{ extnID, extnValue, critical }` instead moves a TRUE flag past a
 * position-based read and lands a critical extension in a token that looks
 * unremarkable. Refusing every shape but the ASN.1 one closes that without
 * having to guess where a flag might be hiding.
 */
function assertNoCriticalExtension(element: DerElement): void {
  for (const extension of children(element, "TSTInfo.extensions")) {
    const parts = children(expect(extension, DER_TAG.SEQUENCE, "TSTInfo extension"), "TSTInfo extension");
    if (parts.length < 2 || parts.length > 3) {
      refuse(`A TSTInfo extension carries ${parts.length} elements; ASN.1 admits two or three.`);
    }
    const oid = readDerOid(at(parts, 0, "TSTInfo extension OID"));
    expect(at(parts, parts.length - 1, "TSTInfo extension extnValue"), DER_TAG.OCTET_STRING, "TSTInfo extension extnValue");
    if (parts.length === 2) continue;
    // `critical BOOLEAN DEFAULT FALSE`: present here, so it must be a BOOLEAN in
    // the middle position. The reader has already refused any BOOLEAN octet
    // other than 0x00 and 0xFF.
    const flag = expect(at(parts, 1, "TSTInfo extension critical"), DER_TAG.BOOLEAN, "TSTInfo extension critical");
    if (flag.content[0] !== 0x00) {
      refuse(`TSTInfo carries critical extension ${oid}, which this profile does not know (§6.1 rule 2).`);
    }
  }
}

// ---------------------------------------------------------------------------
// Signed attributes
// ---------------------------------------------------------------------------

/** One attribute's values, keyed by attribute OID. */
function readAttributeValues(
  signedAttrs: DerElement,
  oid: string,
  label: string,
): readonly DerElement[] | undefined {
  const matches = children(signedAttrs, "signedAttrs")
    .map((attribute) => children(expect(attribute, DER_TAG.SEQUENCE, label), label))
    .filter((parts) => readDerOid(at(parts, 0, `${label} OID`)) === oid);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) refuse(`signedAttrs carries ${matches.length} ${label} attributes.`);
  return children(expect(at(matches[0]!, 1, `${label} values`), DER_TAG.SET, `${label} values`), label);
}

function singleAttributeValue(
  signedAttrs: DerElement,
  oid: string,
  label: string,
): DerElement | undefined {
  const values = readAttributeValues(signedAttrs, oid, label);
  if (values === undefined) return undefined;
  if (values.length !== 1) refuse(`The ${label} attribute carries ${values.length} values.`);
  return values[0]!;
}

// ---------------------------------------------------------------------------
// SigningCertificateV2 (§6.1 rule 6)
// ---------------------------------------------------------------------------

interface EssCertIdV2 {
  readonly hashAlgorithmOid: string;
  readonly certHash: Uint8Array;
}

/**
 * `ESSCertIDv2 ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier DEFAULT
 * {algorithm id-sha256}, certHash OCTET STRING, issuerSerial IssuerSerial
 * OPTIONAL }`.
 *
 * Only the first `ESSCertIDv2` is read: RFC 5035 puts the signing certificate
 * first, and later entries name chain certificates whose presence rule 6 does
 * not require. `issuerSerial` is not compared -- rule 7 already binds
 * `SignerInfo.sid` to this certificate, and adding an unstated comparison here
 * would refuse conformant production output over a redundancy.
 */
function readSigningCertificateV2(value: DerElement): EssCertIdV2 {
  const parts = children(expect(value, DER_TAG.SEQUENCE, "SigningCertificateV2"), "SigningCertificateV2");
  const certs = children(
    expect(at(parts, 0, "SigningCertificateV2.certs"), DER_TAG.SEQUENCE, "SigningCertificateV2.certs"),
    "SigningCertificateV2.certs",
  );
  const essCertIdV2 = children(
    expect(at(certs, 0, "ESSCertIDv2"), DER_TAG.SEQUENCE, "ESSCertIDv2"),
    "ESSCertIDv2",
  );
  const first = at(essCertIdV2, 0, "ESSCertIDv2.certHash");
  // DER omits a DEFAULT value, so an absent hashAlgorithm is SHA-256 -- not
  // "unspecified". A stated SHA-256-family algorithm is equally acceptable:
  // rule 6 governs the binding, not the producer's encoding preference.
  if (first.identifier === DER_TAG.SEQUENCE) {
    const algorithm = readAlgorithmIdentifier(first, "ESSCertIDv2.hashAlgorithm");
    if (!ALLOWED_SIGNERINFO_DIGEST_OIDS.includes(algorithm.oid)) {
      refuse(
        `ESSCertIDv2.hashAlgorithm is ${algorithm.oid}, outside the SHA-256 family (§6.1 rule 6).`,
      );
    }
    return {
      hashAlgorithmOid: algorithm.oid,
      certHash: expect(at(essCertIdV2, 1, "ESSCertIDv2.certHash"), DER_TAG.OCTET_STRING, "ESSCertIDv2.certHash").content,
    };
  }
  return {
    hashAlgorithmOid: OID_SHA256,
    certHash: expect(first, DER_TAG.OCTET_STRING, "ESSCertIDv2.certHash").content,
  };
}

// ---------------------------------------------------------------------------
// RSASSA-PSS parameters (§6.1 rule 5)
// ---------------------------------------------------------------------------

/**
 * `RSASSA-PSS-params ::= SEQUENCE { hashAlgorithm [0] DEFAULT sha1,
 * maskGenAlgorithm [1] DEFAULT mgf1SHA1, saltLength [2] DEFAULT 20,
 * trailerField [3] DEFAULT 1 }`.
 *
 * The OID names the scheme, not the hash, so a PSS signature over SHA-1 would
 * otherwise sail through an allowlist check that admits `id-RSASSA-PSS`. Two
 * things are checked here, and the port re-reads the same bytes for the salt
 * length it must pass to the platform:
 *
 * - the parameter hash is floored against the SHA-256 family (§6.1 rule 5);
 * - it **equals** the SignerInfo `digestAlgorithm` (RFC 4056 §3). Without that
 *   equality a token could declare SHA-512 in the SignerInfo, satisfy the floor
 *   with SHA-256 in the parameters, and leave two layers disagreeing about
 *   which hash the signature covers -- with the port obliged to pick one.
 */
function assertPssParametersFloor(
  parameters: Uint8Array | undefined,
  signerInfoDigestOid: string,
): void {
  if (parameters === undefined) {
    refuse("RSASSA-PSS carries no parameters, so its digest defaults to SHA-1 (§6.1 rule 5).");
  }
  const parts = children(
    expect(decodeDer(parameters), DER_TAG.SEQUENCE, "RSASSA-PSS-params"),
    "RSASSA-PSS-params",
  );
  const hashAlgorithm = parts.find((part) => part.identifier === CONTEXT_CONSTRUCTED_0);
  if (hashAlgorithm === undefined) {
    refuse("RSASSA-PSS-params omits hashAlgorithm, so it defaults to SHA-1 (§6.1 rule 5).");
  }
  const algorithm = readAlgorithmIdentifier(
    only(children(hashAlgorithm, "RSASSA-PSS-params.hashAlgorithm"), "RSASSA-PSS-params.hashAlgorithm"),
    "RSASSA-PSS-params.hashAlgorithm",
  );
  if (!ALLOWED_SIGNERINFO_DIGEST_OIDS.includes(algorithm.oid)) {
    refuse(
      `RSASSA-PSS-params.hashAlgorithm is ${algorithm.oid}, below the SHA-256 family floor (§6.1 rule 5).`,
    );
  }
  if (algorithm.oid !== signerInfoDigestOid) {
    refuse(
      `RSASSA-PSS-params.hashAlgorithm is ${algorithm.oid} but the SignerInfo digestAlgorithm is ${signerInfoDigestOid}; RFC 4056 §3 requires them to agree.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rule 7 -- SignerInfo.sid against the certificate's identifier forms
// ---------------------------------------------------------------------------

function sidMatches(sid: DerElement, forms: readonly AnchorSignerIdentifier[]): boolean {
  if (sid.identifier === DER_TAG.SEQUENCE) {
    const parts = children(sid, "SignerInfo.sid");
    const issuerDer = at(parts, 0, "sid.issuer").bytes;
    const serialNumber = expect(at(parts, 1, "sid.serialNumber"), DER_TAG.INTEGER, "sid.serialNumber").content;
    return forms.some((form) =>
      form.kind === "issuerAndSerialNumber"
      && equalBytes(form.issuerDer, issuerDer)
      && equalBytes(form.serialNumber, serialNumber));
  }
  if (sid.identifier === CONTEXT_PRIMITIVE_0) {
    // subjectKeyIdentifier [0] IMPLICIT OCTET STRING.
    return forms.some((form) =>
      form.kind === "subjectKeyIdentifier" && equalBytes(form.keyIdentifier, sid.content));
  }
  refuse(`SignerInfo.sid has identifier 0x${sid.identifier.toString(16)}, which is neither CMS form.`);
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

/**
 * Builds the pure `AnchorProofVerifier` for
 * `https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1`.
 *
 * The three ports are the caller's: implemented once with `node:crypto` in the
 * standalone verifier package and reused by the product core. Nothing in this
 * module performs platform cryptography beyond the SHA-2 digests its own rules
 * compute over bytes it already holds.
 */
export function createRfc3161AnchorProofVerifier(
  ports: Rfc3161AnchorProofVerifierPorts,
): Rfc3161AnchorProofVerifier {
  return {
    profile: RFC3161_TSA_ANCHOR_PROFILE,
    timeBasis: "authority-time",
    posture: "offline-from-artifact",
    verifyProof(
      input: AnchorProofVerificationInput<Rfc3161AnchorTrustMaterial>,
    ): AnchorProofResult<Rfc3161AnchorFacts> {
      try {
        return verifyTimeStampToken(ports, input);
      } catch (cause) {
        // Every refusal path lands here: this profile's own rule failures, the
        // DER reader's conformance failures, and anything a port threw. A rule
        // failure is reported, never thrown (§4.3).
        return {
          status: "invalid",
          profile: RFC3161_TSA_ANCHOR_PROFILE,
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
  };
}

function verifyTimeStampToken(
  ports: Rfc3161AnchorProofVerifierPorts,
  input: AnchorProofVerificationInput<Rfc3161AnchorTrustMaterial>,
): AnchorProofResult<Rfc3161AnchorFacts> {
  if (!(input.proofBytes instanceof Uint8Array)) refuse("proofBytes must be a Uint8Array.");
  const subjectDigest = hexToBytes32(input.subjectSha256);

  // --- Rules 1 and 3: CMS structure -------------------------------------
  const signedData = readSignedData(input.proofBytes);
  if (signedData.eContentTypeOid !== OID_ID_CT_TST_INFO) {
    refuse(`eContentType is ${signedData.eContentTypeOid}, not id-ct-TSTInfo (§6.1 rule 1).`);
  }
  const { signerInfo } = signedData;

  // --- Rule 2: TSTInfo ---------------------------------------------------
  const tstInfo = readTstInfo(signedData.eContent);

  // --- Rule 5: the algorithm floor, at every layer ------------------------
  if (!ALLOWED_IMPRINT_DIGEST_OIDS.includes(tstInfo.imprintAlgorithmOid)) {
    refuse(
      `messageImprint.hashAlgorithm is ${tstInfo.imprintAlgorithmOid}, below the SHA-256 family floor (§6.1 rule 5).`,
    );
  }
  if (!ALLOWED_SIGNERINFO_DIGEST_OIDS.includes(signerInfo.digestAlgorithm.oid)) {
    refuse(
      `SignerInfo.digestAlgorithm is ${signerInfo.digestAlgorithm.oid}, below the SHA-256 family floor (§6.1 rule 5).`,
    );
  }
  if (!ALLOWED_SIGNATURE_ALGORITHM_OIDS.includes(signerInfo.signatureAlgorithm.oid)) {
    refuse(
      `SignerInfo.signatureAlgorithm is ${signerInfo.signatureAlgorithm.oid}, which is not admitted (§6.1 rule 5).`,
    );
  }
  if (signerInfo.signatureAlgorithm.oid === OID_RSASSA_PSS) {
    assertPssParametersFloor(signerInfo.signatureAlgorithm.parameters, signerInfo.digestAlgorithm.oid);
  }

  // --- Rule 12: the binding, from the caller's side -----------------------
  // §5 admits `sha256` and nothing else in a subject DigestSet, so an imprint
  // under another admitted algorithm names a digest the caller never computed
  // and this verifier cannot compare. Refusing is the honest answer.
  if (tstInfo.imprintAlgorithmOid !== OID_SHA256) {
    refuse(
      `messageImprint.hashAlgorithm is ${tstInfo.imprintAlgorithmOid}; the caller's subject digest is a SHA-256 and cannot be compared to it (§6.1 rule 12).`,
    );
  }
  if (!equalBytes(tstInfo.hashedMessage, subjectDigest)) {
    refuse("messageImprint.hashedMessage is not the subject digest (§6.1 rule 12).");
  }

  // --- Rule 4: signedAttrs ------------------------------------------------
  const { signedAttrs } = signerInfo;
  if (signedAttrs === undefined) refuse("SignerInfo carries no signedAttrs (§6.1 rule 4).");
  const contentTypeAttribute = singleAttributeValue(
    signedAttrs,
    OID_CONTENT_TYPE_ATTRIBUTE,
    "contentType",
  );
  if (contentTypeAttribute === undefined) {
    refuse("signedAttrs carries no contentType attribute (§6.1 rule 4).");
  }
  if (readDerOid(contentTypeAttribute) !== OID_ID_CT_TST_INFO) {
    refuse("The contentType attribute is not id-ct-TSTInfo (§6.1 rule 4).");
  }
  const messageDigestAttribute = singleAttributeValue(
    signedAttrs,
    OID_MESSAGE_DIGEST_ATTRIBUTE,
    "messageDigest",
  );
  if (messageDigestAttribute === undefined) {
    refuse("signedAttrs carries no messageDigest attribute (§6.1 rule 4).");
  }
  const expectedEContentDigest = digestUnder(
    signerInfo.digestAlgorithm.oid,
    signedData.eContent,
    "SignerInfo.digestAlgorithm",
  );
  if (
    !equalBytes(
      expect(messageDigestAttribute, DER_TAG.OCTET_STRING, "messageDigest value").content,
      expectedEContentDigest,
    )
  ) {
    refuse("The messageDigest attribute is not the digest of eContent (§6.1 rule 4).");
  }

  // --- Rule 6: SigningCertificateV2 binds an embedded certificate ---------
  const signingCertificateV2 = singleAttributeValue(
    signedAttrs,
    OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE,
    "SigningCertificateV2",
  );
  if (signingCertificateV2 === undefined) {
    // The v1 `SigningCertificate` attribute is never consulted: it may travel
    // alongside v2 in conformant production output, and it can never stand in
    // for it (ESSCertID is SHA-1 by definition).
    refuse("signedAttrs carries no SigningCertificateV2 attribute (§6.1 rule 6).");
  }
  const essCertIdV2 = readSigningCertificateV2(signingCertificateV2);
  const signerCertificateDer = signedData.certificates.find((certificateDer) =>
    equalBytes(
      digestUnder(essCertIdV2.hashAlgorithmOid, certificateDer, "ESSCertIDv2.hashAlgorithm"),
      essCertIdV2.certHash,
    ));
  if (signerCertificateDer === undefined) {
    refuse("SigningCertificateV2 names no certificate embedded in the token (§6.1 rule 6).");
  }

  const certificate: AnchorCertificateFacts = ports.certificateReader.readCertificate(
    signerCertificateDer,
  );

  // --- Rule 7: sid names the certificate rule 6 identified ----------------
  if (!sidMatches(signerInfo.sid, certificate.sid)) {
    refuse("SignerInfo.sid does not name the certificate SigningCertificateV2 identifies (§6.1 rule 7).");
  }

  // --- Rule 9: extended key usage is exactly id-kp-timeStamping -----------
  // Extension criticality is a recorded gap (§16): the certificate port does
  // not surface criticality flags, so the sole-usage half is checked and the
  // critical half is not -- named rather than papered over.
  const usages = certificate.extendedKeyUsageOids;
  if (usages.length !== 1 || usages[0] !== OID_ID_KP_TIME_STAMPING) {
    refuse(
      `The signer certificate's extended key usage is [${usages.join(", ")}], not exactly id-kp-timeStamping (§6.1 rule 9).`,
    );
  }

  // --- Rule 10: the tsa field, when present -------------------------------
  if (
    tstInfo.tsaGeneralName !== undefined
    && !certificate.subjectNames.some((name) => equalBytes(name, tstInfo.tsaGeneralName!))
  ) {
    refuse("TSTInfo.tsa is not among the signer certificate's subject names (§6.1 rule 10).");
  }

  // --- Rule 11: genTime inside the certificate's validity window ----------
  const genTime = derGeneralizedTimeToRfc3339(tstInfo.genTimeDer);
  const afterNotBefore = compareCalendarStrictRfc3339Instants(genTime, certificate.notBefore);
  const beforeNotAfter = compareCalendarStrictRfc3339Instants(genTime, certificate.notAfter);
  if (afterNotBefore === undefined || beforeNotAfter === undefined) {
    refuse("The signer certificate's validity bounds are not calendar-strict RFC 3339 instants.");
  }
  if (afterNotBefore < 0 || beforeNotAfter > 0) {
    refuse(
      `genTime ${genTime} is outside the signer certificate's validity window ${certificate.notBefore}..${certificate.notAfter} (§6.1 rule 11).`,
    );
  }

  // --- Rule 8: the signature covers the signedAttrs SET OF re-encoding -----
  const signedBytes = retagDerElement(signedAttrs, DER_TAG.SET);
  const verified = ports.signatureVerifier.verifySignature({
    algorithmOid: signerInfo.signatureAlgorithm.oid,
    // Always the SignerInfo digestAlgorithm: for bare `rsaEncryption` it is the
    // only statement of the hash anywhere in the token, and leaving it to a
    // platform default would make rule 5's floor bind by accident.
    digestAlgorithmOid: signerInfo.digestAlgorithm.oid,
    ...(signerInfo.signatureAlgorithm.parameters === undefined
      ? {}
      : { parameters: signerInfo.signatureAlgorithm.parameters }),
    spkiDer: certificate.subjectPublicKeyInfoDer,
    message: signedBytes,
    signature: signerInfo.signature.content,
  });
  if (!verified) refuse("The SignerInfo signature does not verify over signedAttrs (§6.1 rule 8).");

  // --- Rules 1-12 hold: `present`, plus `verified` if the chain reaches a
  // --- root the caller supplied ------------------------------------------
  const facts: Rfc3161AnchorFacts = {
    genTime,
    policyOid: tstInfo.policyOid,
    serialNumber: tstInfo.serialNumberHex,
    signerCertificateSha256: bytesToHex(sha256(signerCertificateDer)),
    signatureAlgorithmOid: signerInfo.signatureAlgorithm.oid,
    ...(tstInfo.accuracy === undefined ? {} : { accuracy: tstInfo.accuracy }),
  };

  const trustAnchorsDer = input.trust?.trustAnchorsDer ?? [];
  if (trustAnchorsDer.length > 0) {
    const chainVerified = verifyChainQuietly(ports.chainVerifier, {
      // Leaf first: the certificate rule 6 identified, then everything else the
      // token carried as archival convenience.
      certificateChainDer: [
        signerCertificateDer,
        ...signedData.certificates.filter((der) => der !== signerCertificateDer),
      ],
      trustAnchorsDer,
      atTime: genTime,
    });
    if (chainVerified) {
      return {
        status: "verified",
        profile: RFC3161_TSA_ANCHOR_PROFILE,
        timeBasis: "authority-time",
        time: genTime,
        facts,
      };
    }
  }
  return {
    status: "present",
    profile: RFC3161_TSA_ANCHOR_PROFILE,
    timeBasis: "authority-time",
    facts,
  };
}

/**
 * A chain that does not reach the caller's roots is not a broken proof: rules
 * 1-12 held, and which authorities a reader accepts is that reader's policy
 * (§4.2). A port that throws is treated the same way -- an operator's chain
 * verifier failing must not turn into an accusation against the token.
 */
function verifyChainQuietly(
  chainVerifier: AnchorChainVerifier,
  input: Parameters<AnchorChainVerifier["verifyCertificateChain"]>[0],
): boolean {
  try {
    return chainVerifier.verifyCertificateChain(input);
  } catch {
    return false;
  }
}
