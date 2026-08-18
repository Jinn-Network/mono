// SPDX-License-Identifier: Apache-2.0

/**
 * OBJECT IDENTIFIER codec and the named OIDs the RFC 3161 profile pins
 * (anchor-evidence design §6.1).
 *
 * OIDs travel as dotted strings everywhere above this module -- they are what
 * the extracted facts report and what the injected crypto ports receive -- so
 * the codec is byte-exact in both directions and refuses every non-minimal
 * encoding rather than normalizing it. Arcs are accumulated as bigints: a
 * subidentifier is unbounded, and a `number` accumulator would silently lose
 * precision above 2^53 on an adversarial encoding.
 */

import { conformanceFailure, invalidInput } from "../errors.js";
import { DER_TAG } from "./der.js";
import type { DerElement } from "./der.js";

// --- CMS / RFC 3161 structure -------------------------------------------

export const OID_ID_SIGNED_DATA = "1.2.840.113549.1.7.2";
export const OID_ID_CT_TST_INFO = "1.2.840.113549.1.9.16.1.4";

// --- Signed attributes --------------------------------------------------

export const OID_CONTENT_TYPE_ATTRIBUTE = "1.2.840.113549.1.9.3";
export const OID_MESSAGE_DIGEST_ATTRIBUTE = "1.2.840.113549.1.9.4";
/** RFC 2634 ESSCertID -- SHA-1 by definition, so §6.1 rule 6 refuses it. */
export const OID_SIGNING_CERTIFICATE_ATTRIBUTE = "1.2.840.113549.1.9.16.2.12";
/** RFC 5035/5816 ESSCertIDv2 -- the attribute §6.1 rule 6 requires. */
export const OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE = "1.2.840.113549.1.9.16.2.47";

// --- Extended key usage --------------------------------------------------

export const OID_ID_KP_TIME_STAMPING = "1.3.6.1.5.5.7.3.8";

// --- Digest algorithms ---------------------------------------------------

export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
export const OID_SHA384 = "2.16.840.1.101.3.4.2.2";
export const OID_SHA512 = "2.16.840.1.101.3.4.2.3";

// --- Signature algorithms ------------------------------------------------

export const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
export const OID_ECDSA_WITH_SHA384 = "1.2.840.10045.4.3.3";
export const OID_ECDSA_WITH_SHA512 = "1.2.840.10045.4.3.4";
export const OID_SHA256_WITH_RSA_ENCRYPTION = "1.2.840.113549.1.1.11";
export const OID_SHA384_WITH_RSA_ENCRYPTION = "1.2.840.113549.1.1.12";
export const OID_SHA512_WITH_RSA_ENCRYPTION = "1.2.840.113549.1.1.13";
export const OID_RSASSA_PSS = "1.2.840.113549.1.1.10";
/** Bare rsaEncryption, which real timestamp authorities emit as the SignerInfo
 * `signatureAlgorithm`, leaving the hash to the SignerInfo digest algorithm. */
export const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";

// --- Pinned allowlists (§6.1 rule 5) -------------------------------------

/**
 * The SHA-256-family floor, applied at every layer a digest can appear:
 * `messageImprint.hashAlgorithm` and the SignerInfo digest algorithm. SHA-1 and
 * weaker are refused everywhere, not only in the imprint -- a producer-side
 * adversary with a SHA-1 anywhere in the CMS layer can mount practical
 * collision substitutions, and refusing costs nothing.
 */
export const ALLOWED_IMPRINT_DIGEST_OIDS: readonly string[] = [OID_SHA256, OID_SHA384, OID_SHA512];
export const ALLOWED_SIGNERINFO_DIGEST_OIDS: readonly string[] = [
  OID_SHA256,
  OID_SHA384,
  OID_SHA512,
];

/**
 * Admitted SignerInfo signature algorithms.
 *
 * `rsaEncryption` is admitted deliberately: captured production tokens from
 * several public authorities carry `signatureAlgorithm = rsaEncryption` with
 * the hash supplied by the SignerInfo `digestAlgorithm`, which
 * `ALLOWED_SIGNERINFO_DIGEST_OIDS` already floors at the SHA-256 family -- so
 * the floor is preserved, and refusing the bare OID would reject conformant
 * production output over a spelling. RSASSA-PSS likewise carries its digest in
 * the algorithm parameters, which is why the crypto port takes `parameters`.
 *
 * Membership here is therefore necessary but never sufficient. For RSASSA-PSS
 * the rule engine MUST parse `RSASSA-PSS-params` and floor its `hashAlgorithm`
 * against `ALLOWED_SIGNERINFO_DIGEST_OIDS`, carrying `saltLength` and
 * `trailerField` to the port alongside it: the OID names the scheme, not the
 * hash, so a PSS signature over SHA-1 would otherwise sail through an allowlist
 * check that admits the OID. For bare `rsaEncryption` the same floor binds
 * through the SignerInfo `digestAlgorithm`, which reaches the port as
 * `digestAlgorithmOid` and never as a platform default.
 */
export const ALLOWED_SIGNATURE_ALGORITHM_OIDS: readonly string[] = [
  OID_ECDSA_WITH_SHA256,
  OID_ECDSA_WITH_SHA384,
  OID_ECDSA_WITH_SHA512,
  OID_SHA256_WITH_RSA_ENCRYPTION,
  OID_SHA384_WITH_RSA_ENCRYPTION,
  OID_SHA512_WITH_RSA_ENCRYPTION,
  OID_RSASSA_PSS,
  OID_RSA_ENCRYPTION,
];

// --- Codec ---------------------------------------------------------------

const ARC_PATTERN = /^(?:0|[1-9][0-9]*)$/;

/** Decodes OBJECT IDENTIFIER content octets to their dotted-string form. */
export function decodeOid(content: Uint8Array): string {
  if (!(content instanceof Uint8Array)) invalidInput("OID content must be a Uint8Array.");
  if (content.length === 0) {
    conformanceFailure("OBJECT IDENTIFIER content must not be empty.");
  }
  const subidentifiers: bigint[] = [];
  let value = 0n;
  let started = false;
  for (let index = 0; index < content.length; index += 1) {
    const octet = content[index]!;
    if (!started && octet === 0x80) {
      conformanceFailure(
        `OID subidentifier at octet ${index} has a leading 0x80; DER subidentifiers are minimal.`,
      );
    }
    started = true;
    value = (value << 7n) | BigInt(octet & 0x7f);
    if ((octet & 0x80) === 0) {
      subidentifiers.push(value);
      value = 0n;
      started = false;
    }
  }
  if (started) {
    conformanceFailure(
      "OID content is truncated: the final octet must clear the continuation bit.",
    );
  }
  const first = subidentifiers[0]!;
  const root = first < 40n ? 0n : first < 80n ? 1n : 2n;
  return [root, first - root * 40n, ...subidentifiers.slice(1)]
    .map((arc) => arc.toString())
    .join(".");
}

/** Encodes a dotted-string OID to its OBJECT IDENTIFIER content octets. */
export function encodeOid(dotted: string): Uint8Array {
  if (typeof dotted !== "string") invalidInput("An OID must be a dotted string.");
  const parts = dotted.split(".");
  if (parts.length < 2) invalidInput(`OID "${dotted}" must have at least two arcs.`);
  const arcs = parts.map((part) => {
    if (!ARC_PATTERN.test(part)) {
      invalidInput(`OID "${dotted}" has a non-canonical arc "${part}".`);
    }
    return BigInt(part);
  });
  const root = arcs[0]!;
  if (root > 2n) invalidInput(`OID "${dotted}" must start with arc 0, 1, or 2.`);
  if (root < 2n && arcs[1]! > 39n) {
    invalidInput(`OID "${dotted}" must have a second arc of at most 39 under root ${root}.`);
  }
  const subidentifiers = [root * 40n + arcs[1]!, ...arcs.slice(2)];
  const octets: number[] = [];
  for (const subidentifier of subidentifiers) {
    octets.push(...encodeBase128(subidentifier));
  }
  return Uint8Array.from(octets);
}

/** Reads an OBJECT IDENTIFIER element, refusing any other tag. */
export function readDerOid(element: DerElement): string {
  if (element.identifier !== DER_TAG.OBJECT_IDENTIFIER) {
    conformanceFailure(
      `Expected an OBJECT IDENTIFIER (0x06), found identifier 0x${element.identifier.toString(16)}.`,
    );
  }
  return decodeOid(element.content);
}

function encodeBase128(value: bigint): readonly number[] {
  const octets = [Number(value & 0x7fn)];
  for (let rest = value >> 7n; rest > 0n; rest >>= 7n) {
    octets.unshift(Number(rest & 0x7fn) | 0x80);
  }
  return octets;
}
