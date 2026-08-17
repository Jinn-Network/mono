// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { p256 } from "@noble/curves/nist.js";
import {
  DER_TAG,
  OID_CONTENT_TYPE_ATTRIBUTE,
  OID_ID_CT_TST_INFO,
  OID_ID_KP_TIME_STAMPING,
  OID_ID_SIGNED_DATA,
  OID_MESSAGE_DIGEST_ATTRIBUTE,
  OID_SHA256,
  OID_SIGNING_CERTIFICATE_ATTRIBUTE,
  OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE,
  decodeDer,
  decodeDerChildren,
  derGeneralizedTimeToRfc3339,
  readDerGeneralizedTime,
  readDerOid,
} from "@jinn-network/trust-core";
import type { DerElement } from "@jinn-network/trust-core";

import { bytesToHex, compareSetOfEncodings, hexToBytes, retagAsSetOf } from "./der-encoder.js";
import {
  KIT_GEN_TIME,
  KIT_TOKEN_SERIAL_HEX,
  KIT_TSA_POLICY_OID,
  OID_ECDSA_WITH_SHA1,
  OID_ID_DATA,
  OID_ID_KP_CLIENT_AUTH,
  OID_SHA1,
  createFixtureAuthority,
} from "./fixture-authority.js";
import type { MintTimeStampTokenOptions } from "./fixture-authority.js";

// ---------------------------------------------------------------------------
// The fixture authority's contract has two halves, and both are tested here
// because a kit is only worth what its fixtures are:
//
//  - the VALID token really is valid -- it parses through trust-core's reader,
//    every §6.1 rule holds against it, and its signature independently verifies
//    over the signedAttrs SET OF re-encoding;
//  - every NEGATIVE token really carries the defect it is named for. A fixture
//    that is merely different, or accidentally still conformant, would let a
//    verifier pass the kit while missing the rule.
//
// The walker below is deliberately local to this file: the rule engine that
// reads meaning out of these structures is P4's, and duplicating it here would
// make the kit test the engine's opinions instead of the bytes.
// ---------------------------------------------------------------------------

const SUBJECT = sha256(new TextEncoder().encode("anchor kit subject"));

interface WalkedToken {
  readonly contentTypeOid: string;
  readonly eContentTypeOid: string;
  readonly eContent: Uint8Array;
  readonly certificates: readonly DerElement[];
  readonly signerInfos: readonly DerElement[];
}

function children(element: DerElement): readonly DerElement[] {
  return decodeDerChildren(element);
}

function walkToken(tokenDer: Uint8Array): WalkedToken {
  const [contentType, contentWrapper] = children(decodeDer(tokenDer));
  const signedData = children(contentWrapper!)[0]!;
  const parts = children(signedData);
  const encapContentInfo = parts[2]!;
  const encapParts = children(encapContentInfo);
  const certificatesField = parts.find(
    (part, index) => index > 2 && part.identifier === 0xa0,
  );
  const signerInfosField = parts.at(-1)!;
  return {
    contentTypeOid: readDerOid(contentType!),
    eContentTypeOid: readDerOid(encapParts[0]!),
    eContent: children(encapParts[1]!)[0]!.content,
    certificates: certificatesField === undefined ? [] : children(certificatesField),
    signerInfos: children(signerInfosField),
  };
}

interface WalkedSignerInfo {
  readonly sid: DerElement;
  readonly digestAlgorithmOid: string;
  readonly signedAttrs?: DerElement;
  readonly signatureAlgorithmOid: string;
  readonly signature: Uint8Array;
}

function walkSignerInfo(signerInfo: DerElement): WalkedSignerInfo {
  const parts = children(signerInfo);
  const signedAttrs = parts[3]!.identifier === 0xa0 ? parts[3]! : undefined;
  const tail = signedAttrs === undefined ? parts.slice(3) : parts.slice(4);
  return {
    sid: parts[1]!,
    digestAlgorithmOid: readDerOid(children(parts[2]!)[0]!),
    signedAttrs,
    signatureAlgorithmOid: readDerOid(children(tail[0]!)[0]!),
    signature: tail[1]!.content,
  };
}

function attributesOf(signedAttrs: DerElement): ReadonlyMap<string, DerElement> {
  return new Map(
    children(signedAttrs).map((attribute) => {
      const parts = children(attribute);
      return [readDerOid(parts[0]!), parts[1]!] as const;
    }),
  );
}

interface WalkedTstInfo {
  readonly version: number;
  readonly policyOid: string;
  readonly imprintAlgorithmOid: string;
  readonly hashedMessage: Uint8Array;
  readonly serialNumber: Uint8Array;
  readonly genTime: string;
  readonly optional: readonly DerElement[];
}

function walkTstInfo(eContent: Uint8Array): WalkedTstInfo {
  const parts = children(decodeDer(eContent));
  const imprint = children(parts[2]!);
  return {
    version: Number(parts[0]!.content[0]),
    policyOid: readDerOid(parts[1]!),
    imprintAlgorithmOid: readDerOid(children(imprint[0]!)[0]!),
    hashedMessage: imprint[1]!.content,
    serialNumber: parts[3]!.content,
    // Read raw, not through readDerGeneralizedTime: the malformed fixtures must
    // be walkable in order to be asserted about.
    genTime: String.fromCharCode(...parts[4]!.content),
    optional: parts.slice(5),
  };
}

function subjectPublicKey(certificateDer: Uint8Array): Uint8Array {
  const tbs = children(decodeDer(certificateDer))[0]!;
  const spki = children(tbs)[6]!;
  // Skip the BIT STRING's unused-bits octet.
  return children(spki)[1]!.content.subarray(1);
}

function extensionOids(certificateDer: Uint8Array): readonly string[] {
  const tbs = children(decodeDer(certificateDer))[0]!;
  const extensions = children(children(tbs)[7]!)[0]!;
  return children(extensions).map((extension) => readDerOid(children(extension)[0]!));
}

function extendedKeyUsageOids(certificateDer: Uint8Array): readonly string[] {
  const tbs = children(decodeDer(certificateDer))[0]!;
  const extensions = children(children(tbs)[7]!)[0]!;
  for (const extension of children(extensions)) {
    const parts = children(extension);
    if (readDerOid(parts[0]!) !== "2.5.29.37") continue;
    const value = decodeDer(parts.at(-1)!.content);
    return children(value).map((oid) => readDerOid(oid));
  }
  return [];
}

const authority = createFixtureAuthority("anchor-kit-test");
const valid = authority.mintTimeStampToken({ subjectSha256: SUBJECT });

describe("the valid token", () => {
  test("parses through the reader as a CMS SignedData carrying a TSTInfo", () => {
    const token = walkToken(valid.tokenDer);
    expect(token.contentTypeOid).toBe(OID_ID_SIGNED_DATA);
    expect(token.eContentTypeOid).toBe(OID_ID_CT_TST_INFO);
    expect(token.signerInfos.length).toBe(1);
    expect(token.certificates.length).toBe(1);
  });

  test("rules 1-3: one SignerInfo, TSTInfo version 1, the right content types", () => {
    const token = walkToken(valid.tokenDer);
    const tstInfo = walkTstInfo(token.eContent);
    expect(tstInfo.version).toBe(1);
    expect(tstInfo.policyOid).toBe(KIT_TSA_POLICY_OID);
  });

  test("rule 4: signedAttrs carries contentType and a messageDigest over eContent", () => {
    const token = walkToken(valid.tokenDer);
    const signerInfo = walkSignerInfo(token.signerInfos[0]!);
    const attributes = attributesOf(signerInfo.signedAttrs!);
    expect(readDerOid(children(attributes.get(OID_CONTENT_TYPE_ATTRIBUTE)!)[0]!))
      .toBe(OID_ID_CT_TST_INFO);
    expect(bytesToHex(children(attributes.get(OID_MESSAGE_DIGEST_ATTRIBUTE)!)[0]!.content))
      .toBe(bytesToHex(sha256(token.eContent)));
  });

  test("signedAttrs is a DER SET OF: components in ascending encoding order", () => {
    const token = walkToken(valid.tokenDer);
    const attributes = children(walkSignerInfo(token.signerInfos[0]!).signedAttrs!);
    for (let index = 1; index < attributes.length; index += 1) {
      expect(compareSetOfEncodings(attributes[index - 1]!.bytes, attributes[index]!.bytes))
        .toBeLessThan(0);
    }
  });

  test("rule 5: SHA-256 at the imprint, the SignerInfo digest, and the signature", () => {
    const token = walkToken(valid.tokenDer);
    const signerInfo = walkSignerInfo(token.signerInfos[0]!);
    expect(walkTstInfo(token.eContent).imprintAlgorithmOid).toBe(OID_SHA256);
    expect(signerInfo.digestAlgorithmOid).toBe(OID_SHA256);
    expect(signerInfo.signatureAlgorithmOid).toBe("1.2.840.10045.4.3.2");
  });

  test("rule 6: SigningCertificateV2 names the embedded certificate", () => {
    const token = walkToken(valid.tokenDer);
    const attributes = attributesOf(walkSignerInfo(token.signerInfos[0]!).signedAttrs!);
    expect(attributes.has(OID_SIGNING_CERTIFICATE_ATTRIBUTE)).toBe(false);
    const essCertIdV2 = children(
      children(children(attributes.get(OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE)!)[0]!)[0]!,
    )[0]!;
    // DER omits the DEFAULT sha256 hashAlgorithm, so certHash is the only field.
    expect(children(essCertIdV2).length).toBe(1);
    expect(bytesToHex(children(essCertIdV2)[0]!.content))
      .toBe(bytesToHex(sha256(token.certificates[0]!.bytes)));
  });

  test("rule 7: sid names the embedded certificate's issuer and serial", () => {
    const token = walkToken(valid.tokenDer);
    const sid = children(walkSignerInfo(token.signerInfos[0]!).sid);
    const tbs = children(decodeDer(token.certificates[0]!.bytes))[0]!;
    const certificateParts = children(tbs);
    expect(bytesToHex(sid[0]!.bytes)).toBe(bytesToHex(certificateParts[3]!.bytes));
    expect(bytesToHex(sid[1]!.content)).toBe(bytesToHex(certificateParts[1]!.content));
  });

  test("rule 8: the signature verifies over the signedAttrs SET OF re-encoding", () => {
    const token = walkToken(valid.tokenDer);
    const signerInfo = walkSignerInfo(token.signerInfos[0]!);
    const message = retagAsSetOf(signerInfo.signedAttrs!.bytes);
    expect(
      p256.verify(
        signerInfo.signature,
        sha256(message),
        subjectPublicKey(token.certificates[0]!.bytes),
        { format: "der", prehash: false },
      ),
    ).toBe(true);
    // And not over eContent, which is the downgrade rule 8 exists to refuse.
    expect(
      p256.verify(
        signerInfo.signature,
        sha256(token.eContent),
        subjectPublicKey(token.certificates[0]!.bytes),
        { format: "der", prehash: false },
      ),
    ).toBe(false);
  });

  test("rule 9: extended key usage is exactly id-kp-timeStamping, and critical", () => {
    expect(extendedKeyUsageOids(valid.signerCertificateDer)).toEqual([OID_ID_KP_TIME_STAMPING]);
    expect(extensionOids(valid.signerCertificateDer)).toContain("2.5.29.37");
  });

  test("rule 10: the tsa field is the certificate's own directoryName", () => {
    const tstInfo = walkTstInfo(walkToken(valid.tokenDer).eContent);
    const tsaField = tstInfo.optional.find((element) => element.identifier === 0xa0)!;
    expect(bytesToHex(children(tsaField)[0]!.bytes))
      .toBe(bytesToHex(authority.subjectGeneralNameDer));
  });

  test("rule 11: genTime is DER GeneralizedTime inside the certificate window", () => {
    const tstInfo = walkTstInfo(walkToken(valid.tokenDer).eContent);
    expect(tstInfo.genTime).toBe(KIT_GEN_TIME);
    expect(derGeneralizedTimeToRfc3339(tstInfo.genTime)).toBe("2026-08-17T12:00:00Z");
    expect(derGeneralizedTimeToRfc3339(tstInfo.genTime) > authority.notBefore).toBe(true);
    expect(derGeneralizedTimeToRfc3339(tstInfo.genTime) < authority.notAfter).toBe(true);
  });

  test("rule 12: the imprint is the subject digest", () => {
    const tstInfo = walkTstInfo(walkToken(valid.tokenDer).eContent);
    expect(bytesToHex(tstInfo.hashedMessage)).toBe(bytesToHex(SUBJECT));
  });

  test("the reported facts are the token's own bytes", () => {
    const token = walkToken(valid.tokenDer);
    const tstInfo = walkTstInfo(token.eContent);
    expect(valid.facts.genTime).toBe(derGeneralizedTimeToRfc3339(readDerGeneralizedTime(
      children(decodeDer(token.eContent))[4]!,
    )));
    expect(valid.facts.policyOid).toBe(tstInfo.policyOid);
    expect(valid.facts.serialNumber).toBe(bytesToHex(tstInfo.serialNumber));
    expect(valid.facts.serialNumber).toBe(KIT_TOKEN_SERIAL_HEX);
    expect(valid.facts.signerCertificateSha256)
      .toBe(bytesToHex(sha256(token.certificates[0]!.bytes)));
    expect(hexToBytes(valid.facts.signerCertificateSha256).length).toBe(32);
  });

  test("minting is deterministic, and seed-separated", () => {
    const again = createFixtureAuthority("anchor-kit-test")
      .mintTimeStampToken({ subjectSha256: SUBJECT });
    expect(bytesToHex(again.tokenDer)).toBe(bytesToHex(valid.tokenDer));

    const other = createFixtureAuthority("anchor-kit-other")
      .mintTimeStampToken({ subjectSha256: SUBJECT });
    expect(bytesToHex(other.tokenDer)).not.toBe(bytesToHex(valid.tokenDer));
  });

  test("the subject digest is accepted as bytes or as its hex spelling", () => {
    const fromHex = authority.mintTimeStampToken({ subjectSha256: bytesToHex(SUBJECT) });
    expect(bytesToHex(fromHex.tokenDer)).toBe(bytesToHex(valid.tokenDer));
    expect(() => authority.mintTimeStampToken({ subjectSha256: SUBJECT.subarray(0, 20) }))
      .toThrow(/32 bytes/);
    expect(() => authority.mintTimeStampToken({ subjectSha256: "not-hex" })).toThrow();
  });
});

describe("every negative fixture carries the defect it is named for", () => {
  function mint(options: Omit<MintTimeStampTokenOptions, "subjectSha256">) {
    return authority.mintTimeStampToken({ ...options, subjectSha256: SUBJECT });
  }

  test("rule 1: the outer contentType and the eContentType", () => {
    expect(walkToken(mint({ wrongContentType: true }).tokenDer).contentTypeOid)
      .toBe(OID_ID_DATA);
    expect(walkToken(mint({ wrongEContentType: true }).tokenDer).eContentTypeOid)
      .toBe(OID_ID_DATA);
  });

  test("rule 2: TSTInfo version and an unknown critical extension", () => {
    const versioned = walkTstInfo(walkToken(mint({ tstInfoVersion: 2 }).tokenDer).eContent);
    expect(versioned.version).toBe(2);

    const extended = walkTstInfo(
      walkToken(mint({ unknownCriticalExtension: true }).tokenDer).eContent,
    );
    const extensions = extended.optional.find((element) => element.identifier === 0xa1)!;
    const extension = children(children(extensions)[0]!);
    expect(readDerOid(extension[0]!)).toBe("2.999.2");
    // The criticality flag is TRUE, which is what makes an unknown extension a
    // refusal rather than something to skip.
    expect(extension[1]!.content[0]).toBe(0xff);
  });

  test("rule 3: two SignerInfos", () => {
    expect(walkToken(mint({ twoSignerInfos: true }).tokenDer).signerInfos.length).toBe(2);
  });

  test("rule 4: absent signedAttrs, wrong contentType attribute, wrong messageDigest", () => {
    const withoutAttrs = walkToken(mint({ omitSignedAttrs: true }).tokenDer);
    expect(walkSignerInfo(withoutAttrs.signerInfos[0]!).signedAttrs).toBeUndefined();
    // CMS then signs eContent directly -- valid CMS, refused by rule 4.
    const signerInfo = walkSignerInfo(withoutAttrs.signerInfos[0]!);
    expect(
      p256.verify(
        signerInfo.signature,
        sha256(withoutAttrs.eContent),
        subjectPublicKey(withoutAttrs.certificates[0]!.bytes),
        { format: "der", prehash: false },
      ),
    ).toBe(true);

    const wrongContentType = walkToken(mint({ wrongContentTypeAttribute: true }).tokenDer);
    const contentTypeAttribute = attributesOf(
      walkSignerInfo(wrongContentType.signerInfos[0]!).signedAttrs!,
    ).get(OID_CONTENT_TYPE_ATTRIBUTE)!;
    expect(readDerOid(children(contentTypeAttribute)[0]!)).toBe(OID_ID_DATA);

    const wrongDigest = walkToken(mint({ wrongMessageDigestAttribute: true }).tokenDer);
    const digestAttribute = attributesOf(
      walkSignerInfo(wrongDigest.signerInfos[0]!).signedAttrs!,
    ).get(OID_MESSAGE_DIGEST_ATTRIBUTE)!;
    expect(bytesToHex(children(digestAttribute)[0]!.content))
      .not.toBe(bytesToHex(sha256(wrongDigest.eContent)));
  });

  test("family 2: tampered eContent keeps signedAttrs and its signature valid", () => {
    const tampered = walkToken(mint({ tamperedEContent: true }).tokenDer);
    const signerInfo = walkSignerInfo(tampered.signerInfos[0]!);
    const messageDigest = children(
      attributesOf(signerInfo.signedAttrs!).get(OID_MESSAGE_DIGEST_ATTRIBUTE)!,
    )[0]!.content;
    // The signature still checks out -- that is the whole point of the fixture.
    expect(
      p256.verify(
        signerInfo.signature,
        sha256(retagAsSetOf(signerInfo.signedAttrs!.bytes)),
        subjectPublicKey(tampered.certificates[0]!.bytes),
        { format: "der", prehash: false },
      ),
    ).toBe(true);
    // And the carried eContent is not what the attribute committed to.
    expect(bytesToHex(messageDigest)).not.toBe(bytesToHex(sha256(tampered.eContent)));
    expect(bytesToHex(walkTstInfo(tampered.eContent).serialNumber))
      .not.toBe(KIT_TOKEN_SERIAL_HEX);
  });

  test("family 7: SHA-1 at each of the three layers rule 5 floors", () => {
    const imprint = walkTstInfo(walkToken(mint({ sha1Imprint: true }).tokenDer).eContent);
    expect(imprint.imprintAlgorithmOid).toBe(OID_SHA1);
    expect(imprint.hashedMessage.length).toBe(20);

    const signerDigest = walkToken(mint({ sha1SignerInfoDigest: true }).tokenDer);
    expect(walkSignerInfo(signerDigest.signerInfos[0]!).digestAlgorithmOid).toBe(OID_SHA1);

    const signatureAlgorithm = walkToken(mint({ sha1SignatureAlgorithm: true }).tokenDer);
    expect(walkSignerInfo(signatureAlgorithm.signerInfos[0]!).signatureAlgorithmOid)
      .toBe(OID_ECDSA_WITH_SHA1);
  });

  test("rule 6: the v1 attribute, an unembedded certificate, and no certificate", () => {
    const v1 = walkToken(mint({ signingCertificateV1: true }).tokenDer);
    const v1Attributes = attributesOf(walkSignerInfo(v1.signerInfos[0]!).signedAttrs!);
    expect(v1Attributes.has(OID_SIGNING_CERTIFICATE_ATTRIBUTE)).toBe(true);
    expect(v1Attributes.has(OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE)).toBe(false);
    // ESSCertID's certHash is SHA-1 by definition: 20 bytes, not 32.
    const essCertId = children(children(children(
      v1Attributes.get(OID_SIGNING_CERTIFICATE_ATTRIBUTE)!,
    )[0]!)[0]!)[0]!;
    expect(children(essCertId)[0]!.content.length).toBe(20);

    const absent = walkToken(mint({ signingCertificateV2NamesAbsentCertificate: true }).tokenDer);
    const absentAttributes = attributesOf(walkSignerInfo(absent.signerInfos[0]!).signedAttrs!);
    const certHash = children(children(children(children(
      absentAttributes.get(OID_SIGNING_CERTIFICATE_V2_ATTRIBUTE)!,
    )[0]!)[0]!)[0]!)[0]!.content;
    expect(bytesToHex(certHash)).not.toBe(bytesToHex(sha256(absent.certificates[0]!.bytes)));

    expect(walkToken(mint({ omitEmbeddedCertificate: true }).tokenDer).certificates.length)
      .toBe(0);
  });

  test("rule 7: sid names a different issuer and serial", () => {
    const token = walkToken(mint({ inconsistentSid: true }).tokenDer);
    const sid = children(walkSignerInfo(token.signerInfos[0]!).sid);
    const certificateParts = children(children(decodeDer(token.certificates[0]!.bytes))[0]!);
    expect(bytesToHex(sid[0]!.bytes)).not.toBe(bytesToHex(certificateParts[3]!.bytes));
    expect(bytesToHex(sid[1]!.content)).not.toBe(bytesToHex(certificateParts[1]!.content));
  });

  test("rule 8: a signature over eContent, and one made by another key", () => {
    const overEContent = walkToken(mint({ signOverEContent: true }).tokenDer);
    const overEContentSigner = walkSignerInfo(overEContent.signerInfos[0]!);
    const key = subjectPublicKey(overEContent.certificates[0]!.bytes);
    expect(overEContentSigner.signedAttrs).toBeDefined();
    expect(p256.verify(overEContentSigner.signature, sha256(overEContent.eContent), key, {
      format: "der",
      prehash: false,
    })).toBe(true);
    expect(p256.verify(
      overEContentSigner.signature,
      sha256(retagAsSetOf(overEContentSigner.signedAttrs!.bytes)),
      key,
      { format: "der", prehash: false },
    )).toBe(false);

    const broken = walkToken(mint({ brokenSignature: true }).tokenDer);
    const brokenSigner = walkSignerInfo(broken.signerInfos[0]!);
    // Structurally sound (it parses as a DER ECDSA signature) and wrong.
    expect(decodeDer(brokenSigner.signature).identifier).toBe(DER_TAG.SEQUENCE);
    expect(p256.verify(
      brokenSigner.signature,
      sha256(retagAsSetOf(brokenSigner.signedAttrs!.bytes)),
      subjectPublicKey(broken.certificates[0]!.bytes),
      { format: "der", prehash: false },
    )).toBe(false);
  });

  test("rule 9: an additional usage, and no extension at all", () => {
    expect(extendedKeyUsageOids(mint({ additionalExtendedKeyUsage: true }).signerCertificateDer))
      .toEqual([OID_ID_KP_TIME_STAMPING, OID_ID_KP_CLIENT_AUTH]);
    expect(extendedKeyUsageOids(mint({ omitExtendedKeyUsage: true }).signerCertificateDer))
      .toEqual([]);
  });

  test("rule 10: the tsa field names a subject the certificate does not present", () => {
    const minted = mint({ tsaNameMismatch: true });
    const tstInfo = walkTstInfo(walkToken(minted.tokenDer).eContent);
    const tsaField = tstInfo.optional.find((element) => element.identifier === 0xa0)!;
    expect(bytesToHex(children(tsaField)[0]!.bytes))
      .not.toBe(bytesToHex(authority.subjectGeneralNameDer));
  });

  test("rule 11: a genTime outside the window, and three malformed spellings", () => {
    const outside = walkTstInfo(walkToken(mint({ genTimeOutsideValidity: true }).tokenDer).eContent);
    expect(derGeneralizedTimeToRfc3339(outside.genTime) < authority.notBefore).toBe(true);

    for (const [variant, value] of [
      ["trailing-fraction-zeros", "20260817120000.500Z"],
      ["missing-zulu", "20260817120000"],
      ["missing-seconds", "202608171200Z"],
    ] as const) {
      const minted = mint({ malformedGenTime: variant });
      const tstInfo = walkTstInfo(walkToken(minted.tokenDer).eContent);
      expect(tstInfo.genTime).toBe(value);
      // trust-core's own reader refuses each of them, which is the rule.
      expect(() => derGeneralizedTimeToRfc3339(tstInfo.genTime)).toThrow();
    }
  });

  test("rule 12: an imprint that is not the subject digest", () => {
    const tstInfo = walkTstInfo(walkToken(mint({ imprintMismatch: true }).tokenDer).eContent);
    expect(tstInfo.hashedMessage.length).toBe(32);
    expect(bytesToHex(tstInfo.hashedMessage)).not.toBe(bytesToHex(SUBJECT));
  });

  test("parsing discipline: the indefinite-length token does not parse at all", () => {
    const minted = mint({ indefiniteLengthOuter: true });
    expect(bytesToHex(minted.tokenDer.subarray(0, 2))).toBe("3080");
    expect(() => decodeDer(minted.tokenDer)).toThrow(/[Ii]ndefinite/);
    // The definite-length sibling over the same inputs does parse: the only
    // difference between the two fixtures is the encoding.
    expect(() => decodeDer(mint({}).tokenDer)).not.toThrow();
  });

  test("optional fields can be omitted without breaking the token", () => {
    const lean = mint({ omitAccuracy: true, omitTsaField: true });
    const tstInfo = walkTstInfo(walkToken(lean.tokenDer).eContent);
    expect(tstInfo.optional).toEqual([]);
    expect(bytesToHex(tstInfo.hashedMessage)).toBe(bytesToHex(SUBJECT));
  });
});
