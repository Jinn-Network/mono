// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  OID_ECDSA_WITH_SHA256,
  OID_ID_CT_TST_INFO,
  OID_ID_SIGNED_DATA,
  OID_RSA_ENCRYPTION,
  OID_SHA256,
  decodeDer,
  decodeDerChildren,
  derGeneralizedTimeToRfc3339,
  readDerGeneralizedTime,
  readDerOid,
} from "@jinn-network/trust-core";
import type { DerElement } from "@jinn-network/trust-core";

import { bytesToHex } from "./der-encoder.js";
import {
  KIT_SUBJECT_SHA256,
  anchorProofContractCases,
  createAnchorKitFixtures,
} from "./conformance.js";

// ---------------------------------------------------------------------------
// The committed bytes (design §11): two captured production tokens, and the
// canonical kit-minted token the cross-validation transcript describes.
//
// The captured tokens prove the reader handles production output -- output no
// builder in this kit could synthesize. The assertions below are structural
// only: nothing here verifies a signature or chains a certificate, because
// neither authority's root is committed and the verifier ships with none.
//
// Filesystem access is confined to this test file. The builders and the
// conformance suite stay pure, so a consumer that wants the captured tokens in
// its own run passes them in through `realTokens` rather than reaching for a
// path.
// ---------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL("../../fixtures/anchor-kit-v1/", import.meta.url));

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURES}${name}`));
}

function children(element: DerElement): readonly DerElement[] {
  return decodeDerChildren(element);
}

interface WalkedToken {
  readonly contentTypeOid: string;
  readonly eContentTypeOid: string;
  readonly eContent: Uint8Array;
  readonly signerInfo: DerElement;
  readonly certificateCount: number;
}

function walkToken(tokenDer: Uint8Array): WalkedToken {
  const [contentType, wrapper] = children(decodeDer(tokenDer));
  const parts = children(children(wrapper!)[0]!);
  const encapParts = children(parts[2]!);
  const certificates = parts.find((part, index) => index > 2 && part.identifier === 0xa0);
  return {
    contentTypeOid: readDerOid(contentType!),
    eContentTypeOid: readDerOid(encapParts[0]!),
    eContent: children(encapParts[1]!)[0]!.content,
    signerInfo: children(parts.at(-1)!)[0]!,
    certificateCount: certificates === undefined ? 0 : children(certificates).length,
  };
}

function signatureAlgorithmOid(signerInfo: DerElement): string {
  const parts = children(signerInfo);
  const tail = parts[3]!.identifier === 0xa0 ? parts.slice(4) : parts.slice(3);
  return readDerOid(children(tail[0]!)[0]!);
}

interface WalkedImprint {
  readonly algorithmOid: string;
  readonly hashedMessage: string;
  readonly genTime: string;
  readonly policyOid: string;
}

function walkTstInfo(eContent: Uint8Array): WalkedImprint {
  const parts = children(decodeDer(eContent));
  const imprint = children(parts[2]!);
  return {
    algorithmOid: readDerOid(children(imprint[0]!)[0]!),
    hashedMessage: bytesToHex(imprint[1]!.content),
    genTime: readDerGeneralizedTime(parts[4]!),
    policyOid: readDerOid(parts[1]!),
  };
}

const CAPTURES = [
  {
    name: "DigiCert (RSA)",
    file: "token-digicert.der",
    signatureAlgorithmOid: OID_RSA_ENCRYPTION,
    policyOid: "2.16.840.1.114412.7.1",
    genTime: "2026-08-17T20:37:55Z",
  },
  {
    name: "SSL.com (ECDSA)",
    file: "token-sslcom.der",
    signatureAlgorithmOid: OID_ECDSA_WITH_SHA256,
    policyOid: "1.3.6.1.4.1.38064.1.3.6.1",
    genTime: "2026-08-17T20:37:56Z",
  },
] as const;

describe.each(CAPTURES)("the captured $name token", (capture) => {
  const tokenDer = fixture(capture.file);

  test("parses under the definite-length DER reader", () => {
    const token = walkToken(tokenDer);
    expect(token.contentTypeOid).toBe(OID_ID_SIGNED_DATA);
    expect(token.eContentTypeOid).toBe(OID_ID_CT_TST_INFO);
    // certReq was set, so the signer certificate travels in the token.
    expect(token.certificateCount).toBeGreaterThan(0);
  });

  test("its message imprint is the kit subject digest, under SHA-256", () => {
    const tstInfo = walkTstInfo(walkToken(tokenDer).eContent);
    expect(tstInfo.algorithmOid).toBe(OID_SHA256);
    expect(tstInfo.hashedMessage).toBe(KIT_SUBJECT_SHA256);
  });

  test("its SignerInfo signature algorithm is the one the capture record states", () => {
    expect(signatureAlgorithmOid(walkToken(tokenDer).signerInfo))
      .toBe(capture.signatureAlgorithmOid);
  });

  test("its genTime and policy match the capture record, through the pinned transform", () => {
    const tstInfo = walkTstInfo(walkToken(tokenDer).eContent);
    expect(derGeneralizedTimeToRfc3339(tstInfo.genTime)).toBe(capture.genTime);
    expect(tstInfo.policyOid).toBe(capture.policyOid);
  });
});

describe("the two captures are independent of each other", () => {
  test("different authorities, different policies, different signature families", () => {
    const [first, second] = CAPTURES.map((capture) => walkToken(fixture(capture.file)));
    expect(bytesToHex(first!.eContent)).not.toBe(bytesToHex(second!.eContent));
    expect(signatureAlgorithmOid(first!.signerInfo))
      .not.toBe(signatureAlgorithmOid(second!.signerInfo));
  });

  test("one RSA and one ECDSA capture, as §11 requires", () => {
    const algorithms = CAPTURES.map((capture) =>
      signatureAlgorithmOid(walkToken(fixture(capture.file)).signerInfo));
    expect(algorithms).toContain(OID_RSA_ENCRYPTION);
    expect(algorithms).toContain(OID_ECDSA_WITH_SHA256);
  });
});

describe("the canonical kit-minted token", () => {
  test("is byte-identical to what the builders mint today", () => {
    // The one assertion that keeps `cross-validation.md` describing bytes that
    // exist. If this fails, a builder changed: the committed fixture is
    // append-only, so the resolution is a new fixture plus a dated erratum and a
    // fresh transcript -- never an edit to either.
    const kit = createAnchorKitFixtures();
    const minted = kit.authority.mintTimeStampToken({ subjectSha256: kit.subjectSha256 });
    expect(bytesToHex(fixture("kit-token-canonical.der"))).toBe(bytesToHex(minted.tokenDer));
  });

  test("is the token the cross-validation transcript names", () => {
    expect(bytesToHex(sha256(fixture("kit-token-canonical.der"))))
      .toBe("726e33332520537276ca8d0fe20d5b25ccd0eeb4b95cf3bfce06d4924673c8c0");
  });

  test("carries the same subject digest as the captured tokens", () => {
    const tstInfo = walkTstInfo(walkToken(fixture("kit-token-canonical.der")).eContent);
    expect(tstInfo.hashedMessage).toBe(KIT_SUBJECT_SHA256);
    expect(derGeneralizedTimeToRfc3339(tstInfo.genTime)).toBe("2026-08-17T12:00:00Z");
  });
});

describe("the captured tokens as conformance-suite input", () => {
  test("they enter the suite as present-only cases, never verified", () => {
    const kit = createAnchorKitFixtures();
    const cases = anchorProofContractCases(kit, {
      realTokens: CAPTURES.map((capture) => ({
        name: capture.name,
        tokenDer: fixture(capture.file),
        subjectSha256: KIT_SUBJECT_SHA256,
        facts: { genTime: capture.genTime, policyOid: capture.policyOid },
      })),
    });
    const captured = cases.filter((testCase) => testCase.family === "§11 captured real tokens");
    expect(captured.length).toBe(CAPTURES.length);
    for (const testCase of captured) {
      expect(testCase.expected.status).toBe("present");
      expect(testCase.trustMaterial).toBe("none");
    }
  });
});
