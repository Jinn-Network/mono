import { describe, expect, test } from "vitest";

import { TrustCoreError } from "../errors.js";
import { DER_TAG, decodeDer } from "./der.js";
import {
  ALLOWED_IMPRINT_DIGEST_OIDS,
  ALLOWED_SIGNATURE_ALGORITHM_OIDS,
  ALLOWED_SIGNERINFO_DIGEST_OIDS,
  OID_CONTENT_TYPE_ATTRIBUTE,
  OID_ECDSA_WITH_SHA256,
  OID_ECDSA_WITH_SHA384,
  OID_ECDSA_WITH_SHA512,
  OID_ID_CT_TST_INFO,
  OID_ID_KP_TIME_STAMPING,
  OID_ID_SIGNED_DATA,
  OID_MESSAGE_DIGEST_ATTRIBUTE,
  OID_RSA_ENCRYPTION,
  OID_RSASSA_PSS,
  OID_SHA256,
  OID_SHA256_WITH_RSA_ENCRYPTION,
  OID_SHA384,
  OID_SHA384_WITH_RSA_ENCRYPTION,
  OID_SHA512,
  OID_SHA512_WITH_RSA_ENCRYPTION,
  OID_SIGNING_CERTIFICATE_ATTRIBUTE,
  OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE,
  decodeOid,
  encodeOid,
  readDerOid,
} from "./oids.js";

const NAMED_OIDS = [
  OID_ID_SIGNED_DATA,
  OID_ID_CT_TST_INFO,
  OID_CONTENT_TYPE_ATTRIBUTE,
  OID_MESSAGE_DIGEST_ATTRIBUTE,
  OID_SIGNING_CERTIFICATE_ATTRIBUTE,
  OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE,
  OID_ID_KP_TIME_STAMPING,
  OID_SHA256,
  OID_SHA384,
  OID_SHA512,
  OID_ECDSA_WITH_SHA256,
  OID_ECDSA_WITH_SHA384,
  OID_ECDSA_WITH_SHA512,
  OID_SHA256_WITH_RSA_ENCRYPTION,
  OID_SHA384_WITH_RSA_ENCRYPTION,
  OID_SHA512_WITH_RSA_ENCRYPTION,
  OID_RSASSA_PSS,
  OID_RSA_ENCRYPTION,
] as const;

function code(run: () => unknown): string {
  try {
    run();
  } catch (cause) {
    return cause instanceof TrustCoreError ? cause.code : `not-a-TrustCoreError:${String(cause)}`;
  }
  return "no-throw";
}

describe("OID codec", () => {
  test.each(NAMED_OIDS)("round-trips %s", (oid) => {
    expect(decodeOid(encodeOid(oid))).toBe(oid);
  });

  test("encodes the known byte sequences", () => {
    expect(encodeOid(OID_ID_SIGNED_DATA))
      .toEqual(Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]));
    expect(encodeOid(OID_SHA256))
      .toEqual(Uint8Array.from([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]));
    expect(encodeOid(OID_ID_KP_TIME_STAMPING))
      .toEqual(Uint8Array.from([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08]));
  });

  test("decodes each root arc form", () => {
    expect(decodeOid(Uint8Array.from([0x00]))).toBe("0.0");
    expect(decodeOid(Uint8Array.from([0x27]))).toBe("0.39");
    expect(decodeOid(Uint8Array.from([0x28]))).toBe("1.0");
    expect(decodeOid(Uint8Array.from([0x50]))).toBe("2.0");
  });

  test("round-trips an arc beyond the safe-integer range", () => {
    const huge = "1.2.18446744073709551616";
    expect(decodeOid(encodeOid(huge))).toBe(huge);
  });

  test("refuses malformed OID content", () => {
    // Empty content.
    expect(() => decodeOid(new Uint8Array(0))).toThrow(/empty/i);
    // Final octet still sets the continuation bit.
    expect(() => decodeOid(Uint8Array.from([0x2a, 0x86]))).toThrow(/truncat/i);
    // Non-minimal subidentifier (leading 0x80).
    expect(() => decodeOid(Uint8Array.from([0x2a, 0x80, 0x01]))).toThrow(/minimal/i);
    expect(code(() => decodeOid(new Uint8Array(0)))).toBe("CONFORMANCE_FAILURE");
  });

  test("refuses malformed dotted strings", () => {
    for (const value of ["", "1", "3.0", "1.40", "1.2.", "1.2.x", "1.02.3", "1.-2", "1.2.3 "]) {
      expect(code(() => encodeOid(value))).toBe("INVALID_INPUT");
    }
    expect(encodeOid("2.999")).toEqual(Uint8Array.from([0x88, 0x37]));
  });

  test("reads an OBJECT IDENTIFIER element and refuses other tags", () => {
    const content = encodeOid(OID_ID_CT_TST_INFO);
    const element = decodeDer(
      Uint8Array.from([DER_TAG.OBJECT_IDENTIFIER, content.length, ...content]),
    );
    expect(readDerOid(element)).toBe(OID_ID_CT_TST_INFO);
    expect(() => readDerOid(decodeDer(Uint8Array.from([DER_TAG.NULL, 0x00]))))
      .toThrow(/OBJECT IDENTIFIER/);
  });
});

describe("pinned algorithm allowlists (design §6.1 rule 5)", () => {
  test("admits the SHA-256 family and nothing weaker as digest algorithms", () => {
    for (const allowlist of [ALLOWED_IMPRINT_DIGEST_OIDS, ALLOWED_SIGNERINFO_DIGEST_OIDS]) {
      expect([...allowlist].sort()).toEqual([OID_SHA256, OID_SHA384, OID_SHA512].sort());
      // SHA-1 (1.3.14.3.2.26) and MD5 (1.2.840.113549.2.5) are refused everywhere.
      expect(allowlist).not.toContain("1.3.14.3.2.26");
      expect(allowlist).not.toContain("1.2.840.113549.2.5");
    }
  });

  test("admits exactly the pinned signature algorithms", () => {
    expect([...ALLOWED_SIGNATURE_ALGORITHM_OIDS].sort()).toEqual([
      OID_ECDSA_WITH_SHA256,
      OID_ECDSA_WITH_SHA384,
      OID_ECDSA_WITH_SHA512,
      OID_SHA256_WITH_RSA_ENCRYPTION,
      OID_SHA384_WITH_RSA_ENCRYPTION,
      OID_SHA512_WITH_RSA_ENCRYPTION,
      OID_RSASSA_PSS,
      OID_RSA_ENCRYPTION,
    ].sort());
    // sha1WithRSAEncryption and ecdsa-with-SHA1 never appear.
    expect(ALLOWED_SIGNATURE_ALGORITHM_OIDS).not.toContain("1.2.840.113549.1.1.5");
    expect(ALLOWED_SIGNATURE_ALGORITHM_OIDS).not.toContain("1.2.840.10045.4.1");
  });
});
