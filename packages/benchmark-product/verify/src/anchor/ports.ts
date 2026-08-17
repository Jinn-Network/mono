// SPDX-License-Identifier: Apache-2.0

/**
 * The three `node:crypto` ports the RFC 3161 anchor rule engine injects
 * (anchor-evidence design §6.1 "Placement").
 *
 * `trust-core` owns the rules and produces the exact bytes a signature must
 * cover; it may not import a platform module, and hand-writing an X.509 parser
 * to make a security decision is the invention §3 exists to prevent. So exactly
 * three primitives cross the boundary here, in the standalone verifier package
 * where `node:crypto` is legal and where a reader who wants to check a claim
 * with no Jinn code at all can see what the verifier actually does.
 *
 * Three implementation facts are load-bearing and easy to get wrong:
 *
 * - **The verification hash never comes from a platform default.** Real
 *   authorities emit bare `rsaEncryption` as the SignerInfo `signatureAlgorithm`
 *   and leave the hash to the SignerInfo `digestAlgorithm` (the committed
 *   DigiCert capture does exactly this). `crypto.verify` falls back to SHA-256
 *   when the algorithm pins no digest, so a conformant SHA-384 token would be
 *   verified under the wrong hash -- and the design's SHA-256-family floor would
 *   bind by accident of that default rather than by rule. The hash is therefore
 *   read from `algorithmOid` when the algorithm names one, and from
 *   `digestAlgorithmOid` when it does not.
 * - **Node's `X509Certificate` does not expose raw issuer, serial, subject, or
 *   extension bytes**, and §6.1 rules 7 and 10 compare *bytes* -- distinguished
 *   names are deliberately kept out of string comparison because DN rendering is
 *   not canonical across implementations. Those four fields are therefore
 *   extracted structurally from the certificate DER through trust-core's reader.
 *   In particular `X509Certificate.serialNumber` is a hex string with the DER
 *   sign octet dropped, which would fail a byte comparison against any
 *   `SignerInfo.sid` naming a serial whose leading octet has the high bit set.
 *   Everything Node *does* expose exactly -- the SubjectPublicKeyInfo export,
 *   the validity dates, the extended key usage list -- comes from Node.
 * - **Extension criticality is not checkable here.** `X509Certificate` surfaces
 *   no criticality flags, so §6.1 rule 9's "sole usage" half is enforced and its
 *   "critical" half is not. The gap is recorded (design §16, issue #2761) rather
 *   than papered over with a hand-rolled extension parser.
 *
 * Every port follows the package's port convention: one object argument, plain
 * data in and out, and a `try`/`catch` that answers `false` rather than
 * throwing -- a platform refusal is an answer, not an exception the rule engine
 * has to interpret.
 */

import { X509Certificate, constants, createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  DER_TAG,
  OID_ECDSA_WITH_SHA256,
  OID_ECDSA_WITH_SHA384,
  OID_ECDSA_WITH_SHA512,
  OID_RSASSA_PSS,
  OID_SHA256,
  OID_SHA256_WITH_RSA_ENCRYPTION,
  OID_SHA384,
  OID_SHA384_WITH_RSA_ENCRYPTION,
  OID_SHA512,
  OID_SHA512_WITH_RSA_ENCRYPTION,
  compareCalendarStrictRfc3339Instants,
  decodeDer,
  decodeDerChildren,
  encodeDerElement,
  isCalendarStrictRfc3339,
  readDerOid,
} from "@jinn-network/trust-core";
import type {
  AnchorCertificateFacts,
  AnchorCertificateReader,
  AnchorChainVerifier,
  AnchorSignatureVerifier,
  AnchorSignerIdentifier,
  DerElement,
  Rfc3161AnchorProofVerifierPorts,
} from "@jinn-network/trust-core";

const OID_EXT_SUBJECT_KEY_IDENTIFIER = "2.5.29.14";
const OID_EXT_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_MGF1 = "1.2.840.113549.1.1.8";

const CONTEXT_CONSTRUCTED_0 = 0xa0;
const CONTEXT_CONSTRUCTED_1 = 0xa1;
const CONTEXT_CONSTRUCTED_2 = 0xa2;
const CONTEXT_CONSTRUCTED_3 = 0xa3;
/** `GeneralName ::= CHOICE { ... directoryName [4] Name ... }` -- explicit,
 * because `Name` is itself a CHOICE. */
const GENERAL_NAME_DIRECTORY = 0xa4;

/** Hashes named by the signature algorithm itself. */
const ALGORITHM_HASHES: ReadonlyMap<string, string> = new Map([
  [OID_ECDSA_WITH_SHA256, "sha256"],
  [OID_ECDSA_WITH_SHA384, "sha384"],
  [OID_ECDSA_WITH_SHA512, "sha512"],
  [OID_SHA256_WITH_RSA_ENCRYPTION, "sha256"],
  [OID_SHA384_WITH_RSA_ENCRYPTION, "sha384"],
  [OID_SHA512_WITH_RSA_ENCRYPTION, "sha512"],
]);

/** Hashes named by a digest AlgorithmIdentifier. */
const DIGEST_HASHES: ReadonlyMap<string, string> = new Map([
  [OID_SHA256, "sha256"],
  [OID_SHA384, "sha384"],
  [OID_SHA512, "sha512"],
]);

/** Which key type each admitted signature algorithm requires. A token naming an
 * RSA algorithm over an EC key is a confusion this refuses outright. */
const ALGORITHM_KEY_TYPES: ReadonlyMap<string, readonly string[]> = new Map([
  [OID_ECDSA_WITH_SHA256, ["ec"]],
  [OID_ECDSA_WITH_SHA384, ["ec"]],
  [OID_ECDSA_WITH_SHA512, ["ec"]],
  [OID_SHA256_WITH_RSA_ENCRYPTION, ["rsa"]],
  [OID_SHA384_WITH_RSA_ENCRYPTION, ["rsa"]],
  [OID_SHA512_WITH_RSA_ENCRYPTION, ["rsa"]],
  [OID_RSASSA_PSS, ["rsa", "rsa-pss"]],
]);

/** Bare `rsaEncryption` names no hash at all: the SignerInfo digest algorithm
 * is the only statement of it anywhere in the token. */
const RSA_KEY_TYPES: readonly string[] = ["rsa", "rsa-pss"];

function children(element: DerElement): readonly DerElement[] {
  return decodeDerChildren(element);
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

interface PssParameters {
  readonly hashName: string;
  readonly saltLength: number;
}

/**
 * `RSASSA-PSS-params ::= SEQUENCE { hashAlgorithm [0] DEFAULT sha1,
 * maskGenAlgorithm [1] DEFAULT mgf1SHA1, saltLength [2] DEFAULT 20,
 * trailerField [3] DEFAULT 1 }`, all tags explicit.
 *
 * The rule engine has already floored `hashAlgorithm` against the SHA-256
 * family; this reads the same bytes for the salt length Node needs. The MGF1
 * hash must match the signature hash, because `crypto.verify` uses one hash for
 * both -- a token that used different ones would otherwise be verified under
 * parameters it did not declare. `trailerField` has exactly one admitted value.
 */
function readPssParameters(parameters: Uint8Array | undefined): PssParameters | undefined {
  if (parameters === undefined) return undefined;
  const parts = children(decodeDer(parameters));
  const tagged = (identifier: number): DerElement | undefined =>
    parts.find((part) => part.identifier === identifier);

  const hashAlgorithm = tagged(CONTEXT_CONSTRUCTED_0);
  if (hashAlgorithm === undefined) return undefined;
  const hashName = DIGEST_HASHES.get(readDerOid(children(children(hashAlgorithm)[0]!)[0]!));
  if (hashName === undefined) return undefined;

  const maskGenAlgorithm = tagged(CONTEXT_CONSTRUCTED_1);
  if (maskGenAlgorithm !== undefined) {
    const mgf = children(children(maskGenAlgorithm)[0]!);
    if (readDerOid(mgf[0]!) !== OID_MGF1) return undefined;
    if (DIGEST_HASHES.get(readDerOid(children(mgf[1]!)[0]!)) !== hashName) return undefined;
  } else {
    // An absent maskGenAlgorithm defaults to MGF1-SHA-1, which cannot pair with
    // a SHA-256-family signature hash.
    return undefined;
  }

  const saltLengthElement = tagged(CONTEXT_CONSTRUCTED_2);
  const saltLength = saltLengthElement === undefined
    ? 20
    : readSmallInteger(children(saltLengthElement)[0]!);

  const trailerFieldElement = tagged(CONTEXT_CONSTRUCTED_3);
  if (trailerFieldElement !== undefined && readSmallInteger(children(trailerFieldElement)[0]!) !== 1) {
    return undefined;
  }
  return { hashName, saltLength };
}

function readSmallInteger(element: DerElement): number {
  if (element.identifier !== DER_TAG.INTEGER || element.content.length > 4) {
    throw new Error("Expected a small DER INTEGER.");
  }
  let value = 0;
  for (const octet of element.content) value = value * 256 + octet;
  return value;
}

export const anchorSignatureVerifier: AnchorSignatureVerifier = {
  verifySignature(input) {
    try {
      const key = createPublicKey({
        key: Buffer.from(input.spkiDer),
        format: "der",
        type: "spki",
      });
      const message = Buffer.from(input.message);
      const signature = Buffer.from(input.signature);

      if (input.algorithmOid === OID_RSASSA_PSS) {
        const parameters = readPssParameters(input.parameters);
        if (parameters === undefined || !isKeyType(key, RSA_KEY_TYPES)) return false;
        return verify(
          parameters.hashName,
          message,
          { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: parameters.saltLength },
          signature,
        );
      }

      // The algorithm's own digest when it names one; otherwise the SignerInfo
      // digest algorithm. Never a platform default.
      const named = ALGORITHM_HASHES.get(input.algorithmOid);
      const hashName = named ?? DIGEST_HASHES.get(input.digestAlgorithmOid);
      if (hashName === undefined) return false;
      const keyTypes = ALGORITHM_KEY_TYPES.get(input.algorithmOid) ?? RSA_KEY_TYPES;
      if (!isKeyType(key, keyTypes)) return false;
      return verify(hashName, message, key, signature);
    } catch {
      return false;
    }
  },
};

function isKeyType(key: KeyObject, admitted: readonly string[]): boolean {
  return key.asymmetricKeyType !== undefined && admitted.includes(key.asymmetricKeyType);
}

// ---------------------------------------------------------------------------
// Certificate reading
// ---------------------------------------------------------------------------

interface StructuralFields {
  readonly issuerDer: Uint8Array;
  readonly serialNumber: Uint8Array;
  readonly subjectDer: Uint8Array;
  readonly extensions: readonly DerElement[];
}

/**
 * The four fields Node does not expose as bytes, read straight out of the
 * certificate DER: `TBSCertificate ::= SEQUENCE { version [0] EXPLICIT DEFAULT
 * v1, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo,
 * ..., extensions [3] EXPLICIT OPTIONAL }`.
 */
function readStructuralFields(certificateDer: Uint8Array): StructuralFields {
  const tbs = children(children(decodeDer(certificateDer))[0]!);
  const offset = tbs[0]!.identifier === CONTEXT_CONSTRUCTED_0 ? 1 : 0;
  const extensionsWrapper = tbs.slice(offset + 6).find(
    (element) => element.identifier === CONTEXT_CONSTRUCTED_3,
  );
  return {
    serialNumber: tbs[offset]!.content,
    issuerDer: tbs[offset + 2]!.bytes,
    subjectDer: tbs[offset + 4]!.bytes,
    extensions: extensionsWrapper === undefined ? [] : children(children(extensionsWrapper)[0]!),
  };
}

/** `Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE,
 * extnValue OCTET STRING }` -- the DER inside `extnValue`. */
function extensionValue(extensions: readonly DerElement[], oid: string): Uint8Array | undefined {
  for (const extension of extensions) {
    const parts = children(extension);
    if (readDerOid(parts[0]!) === oid) return parts.at(-1)!.content;
  }
  return undefined;
}

/** Calendar-strict RFC 3339 UTC at second precision -- the spelling every other
 * trust instant uses, so one comparator judges them all. `toISOString` would add
 * a `.000` fraction that says nothing the seconds do not. */
function toRfc3339(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

export const anchorCertificateReader: AnchorCertificateReader = {
  readCertificate(certificateDer: Uint8Array): AnchorCertificateFacts {
    const certificate = new X509Certificate(Buffer.from(certificateDer));
    const structural = readStructuralFields(certificateDer);
    const subjectKeyIdentifier = extensionValue(
      structural.extensions,
      OID_EXT_SUBJECT_KEY_IDENTIFIER,
    );
    const subjectAltName = extensionValue(structural.extensions, OID_EXT_SUBJECT_ALT_NAME);

    const sid: AnchorSignerIdentifier[] = [
      {
        kind: "issuerAndSerialNumber",
        issuerDer: structural.issuerDer,
        serialNumber: structural.serialNumber,
      },
    ];
    if (subjectKeyIdentifier !== undefined) {
      sid.push({
        kind: "subjectKeyIdentifier",
        keyIdentifier: decodeDer(subjectKeyIdentifier).content,
      });
    }

    return {
      subjectPublicKeyInfoDer: new Uint8Array(
        certificate.publicKey.export({ format: "der", type: "spki" }),
      ),
      notBefore: toRfc3339(certificate.validFromDate),
      notAfter: toRfc3339(certificate.validToDate),
      // Node names the extended-key-usage OID array `keyUsage`; the key-usage
      // bit string is `X509Certificate.keyUsage`'s neighbour and is not this.
      extendedKeyUsageOids: certificate.keyUsage ?? [],
      subjectNames: [
        encodeDerElement(GENERAL_NAME_DIRECTORY, structural.subjectDer),
        ...(subjectAltName === undefined
          ? []
          : children(decodeDer(subjectAltName)).map((element) => element.bytes)),
      ],
      sid,
    };
  },
};

// ---------------------------------------------------------------------------
// Chain validation
// ---------------------------------------------------------------------------

/** No legitimate timestamp chain is deeper than this; the bound stops a cyclic
 * or adversarial certificate set from looping. */
const MAX_CHAIN_DEPTH = 8;

/**
 * Validity at the instant the caller named, judged by the same calendar-strict
 * RFC 3339 comparator every other trust instant goes through.
 *
 * `Date.parse` is deliberately not used. This port is a public export, its
 * `atTime` can arrive from anywhere, and `Date.parse` accepts bare dates
 * (`"2026-08-17"`), reads some spellings as local time, and falls back to
 * implementation-defined parsing for the rest -- three ways for a chain to be
 * validated at an instant nobody named. A string the comparator cannot judge
 * yields `undefined`, which reads here as "cannot validate", never as "valid".
 */
function validAt(certificate: X509Certificate, atTime: string): boolean {
  const notBefore = compareCalendarStrictRfc3339Instants(atTime, toRfc3339(certificate.validFromDate));
  const notAfter = compareCalendarStrictRfc3339Instants(atTime, toRfc3339(certificate.validToDate));
  return notBefore !== undefined && notAfter !== undefined && notBefore >= 0 && notAfter <= 0;
}

export const anchorChainVerifier: AnchorChainVerifier = {
  verifyCertificateChain(input) {
    try {
      // §8 step 3: the verifier ships with no roots, and a chain validated
      // solely against bundle-supplied roots would re-import the self-run
      // problem with extra ceremony. An empty set can never verify.
      if (input.trustAnchorsDer.length === 0) return false;
      if (!isCalendarStrictRfc3339(input.atTime)) return false;

      const anchors = input.trustAnchorsDer.map((der) => new X509Certificate(Buffer.from(der)));
      const anchorFingerprints = new Set(anchors.map((anchor) => anchor.fingerprint256));
      const chain = input.certificateChainDer.map((der) => new X509Certificate(Buffer.from(der)));
      let current = chain[0];
      if (current === undefined) return false;

      const seen = new Set<string>();
      for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
        if (seen.has(current.fingerprint256)) return false;
        seen.add(current.fingerprint256);
        // Validity is judged at the token's own genTime, not at the wall clock:
        // a historical token with an expired-but-then-valid chain must not fail
        // for the wrong reason.
        if (!validAt(current, input.atTime)) return false;

        // A certificate that *is* one of the roots the operator supplied needs
        // no issuance check: the operator trusted those exact bytes, which is
        // what a trust anchor means (RFC 5280 admits a zero-length path). This
        // is also the only way a directly-trusted self-signed timestamping
        // certificate can ever anchor -- such a certificate asserts
        // `digitalSignature` and not `keyCertSign`, so an issuance check against
        // itself refuses it for a reason that does not apply.
        if (anchorFingerprints.has(current.fingerprint256)) return true;

        const leaf = current;
        if (anchors.some((anchor) => issued(leaf, anchor) && validAt(anchor, input.atTime))) return true;
        const issuer = chain.find((candidate) =>
          candidate.fingerprint256 !== leaf.fingerprint256 && issued(leaf, candidate));
        if (issuer === undefined) return false;
        current = issuer;
      }
      return false;
    } catch {
      return false;
    }
  },
};

/**
 * Whether `issuer` may issue `certificate`, and did.
 *
 * `checkIssued` covers name linkage, the authority/subject key identifiers when
 * present, and the issuer's `keyCertSign` key usage -- but **not** basic
 * constraints, so a `CA:FALSE` end-entity certificate that happens to assert
 * `keyCertSign` passes it. That is a measured bypass, not a theoretical one: it
 * would let a leaf be spliced in as an intermediate. `issuer.ca` is therefore
 * required before the name check, and the signature is verified after it,
 * because `checkIssued` proves relationship and not authorship.
 *
 * **Disclosed gaps**, in the style §16 uses for the extension-criticality gap
 * (issue #2761's family): this walk checks issuance, key usage, basic
 * constraints, and validity at the caller's instant. It does **not** check
 * revocation (no CRL or OCSP is fetched -- acquisition never runs at
 * verification time, §4.3), `pathLenConstraint`, or name constraints. A verifier
 * that needs those runs its own path validation over the same carried chain;
 * naming the gap is the honest form, and papering over it with a partial
 * implementation would be worse than either.
 */
function issued(certificate: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return issuer.ca && certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

/** The three ports, ready to inject into `createRfc3161AnchorProofVerifier`. */
export const nodeCryptoAnchorPorts: Rfc3161AnchorProofVerifierPorts = {
  signatureVerifier: anchorSignatureVerifier,
  certificateReader: anchorCertificateReader,
  chainVerifier: anchorChainVerifier,
};
