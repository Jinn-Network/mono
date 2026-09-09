// SPDX-License-Identifier: Apache-2.0

/**
 * The conformance kit run against the trust-core RFC 3161 rule engine on the
 * real `node:crypto` ports (design §11, §6.1).
 *
 * This is placement two of two, and the only one that can carry the **captured
 * production tokens**: one of them is RSA-signed, and the pure `@noble/curves`
 * ports the kit's own placement uses cannot verify RSA. Everything the kit mints
 * runs here too, so the same eighty-odd rule outcomes are asserted twice over
 * two independent port implementations -- a rule that passed only because of
 * something one platform did would disagree with the other.
 *
 * The captured tokens enter on the **no-trust-material** path, which is the
 * honest one: neither authority's root is committed, so the outcome the design
 * defines is `present` -- internally consistent, time basis not evaluated
 * (§4.3). Their expected facts come from the kit's own capture-provenance
 * record, and the same tokens are additionally asserted `invalid` against an
 * unrelated subject digest, which is the binding rule seen from the caller's
 * side.
 *
 * `@jinn-network/trust-testing` is a devDependency: `tsconfig.build.json`
 * excludes `src/**\/*.test.ts`, so nothing the kit provides reaches the
 * published `dist/`.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  RFC3161_TSA_ANCHOR_PROFILE,
  createRfc3161AnchorProofVerifier,
  decodeDer,
  decodeDerChildren,
} from "@jinn-network/trust-core";
import type { Rfc3161AnchorTrustMaterial } from "@jinn-network/trust-core";
import { describeAnchorProofVerifierContract } from "@jinn-network/trust-testing";
import type { AnchorKitFixtures, RealTokenInput } from "@jinn-network/trust-testing";

import { anchorCertificateReader, nodeCryptoAnchorPorts } from "./ports.js";

const require = createRequire(import.meta.url);

/** The kit publishes its committed fixture bytes through `./fixtures/*`; the
 * path is resolved through the package's own exports rather than guessed. */
function capturedToken(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(require.resolve(`@jinn-network/trust-testing/fixtures/anchor-kit-v1/${name}`)),
  );
}

/** `capture-provenance.md` is the record these facts come from. Every one of
 * them is extracted from the token by the rule engine, never asserted by it. */
const REAL_TOKENS: readonly RealTokenInput[] = [
  {
    name: "DigiCert (RSA)",
    tokenDer: capturedToken("token-digicert.der"),
    subjectSha256: "47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c",
    facts: {
      genTime: "2026-08-17T20:37:55Z",
      policyOid: "2.16.840.1.114412.7.1",
      serialNumber: "00ce28e208030db02ff8ca617585729ed5",
      // Bare `rsaEncryption`: the hash lives in the SignerInfo digestAlgorithm,
      // which is the whole reason the signature port takes `digestAlgorithmOid`.
      signatureAlgorithmOid: "1.2.840.113549.1.1.1",
      signerCertificateSha256:
        "4aa03fa22cd75c84c55c938f828e676b9caecab33fe36d269aa334f146110a33",
    },
  },
  {
    name: "SSL.com (ECDSA)",
    tokenDer: capturedToken("token-sslcom.der"),
    subjectSha256: "47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c",
    facts: {
      genTime: "2026-08-17T20:37:56Z",
      policyOid: "1.3.6.1.4.1.38064.1.3.6.1",
      serialNumber: "5628fa1ed557b610",
      signatureAlgorithmOid: "1.2.840.10045.4.3.2",
      signerCertificateSha256:
        "542af9a16a8d722e661149788ae994c18a9aaee5a65cb344a2549af96c79c78b",
    },
  },
];

describeAnchorProofVerifierContract<Rfc3161AnchorTrustMaterial>(
  RFC3161_TSA_ANCHOR_PROFILE,
  (kit: AnchorKitFixtures) => ({
    verifier: createRfc3161AnchorProofVerifier(nodeCryptoAnchorPorts),
    // Verifier-side, and only ever the kit's own root: the captured authorities'
    // roots are not committed and never will be.
    trust: { trustAnchorsDer: [kit.authority.certificateDer] },
  }),
  { realTokens: REAL_TOKENS },
);

/** The first certificate in a token's `certificates` set -- for both captures
 * the signer certificate, as `certReq` guarantees. Walked with the same reader
 * the rule engine uses; this file has no business owning a second one. */
function signerCertificateOf(tokenDer: Uint8Array): Uint8Array {
  // ContentInfo -> content [0] -> SignedData -> certificates [0] -> first.
  const contentInfo = decodeDerChildren(decodeDer(tokenDer));
  const signedData = decodeDerChildren(decodeDerChildren(contentInfo[1]!)[0]!);
  const certificates = signedData.slice(3).find((element) => element.identifier === 0xa0)!;
  return decodeDerChildren(certificates)[0]!.bytes;
}

describe("the node:crypto ports on captured production certificates", () => {
  test.each(REAL_TOKENS.map((token) => [token.name, token] as const))(
    "%s: reports both identifier forms, sole timestamping usage, and RFC 3339 validity",
    (_name, token) => {
      const facts = anchorCertificateReader.readCertificate(signerCertificateOf(token.tokenDer));
      expect(facts.extendedKeyUsageOids).toEqual(["1.3.6.1.5.5.7.3.8"]);
      expect(facts.notBefore).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(facts.notAfter).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(facts.sid.map((form) => form.kind))
        .toEqual(["issuerAndSerialNumber", "subjectKeyIdentifier"]);
      // The SubjectPublicKeyInfo Node exports is DER, and it is what the
      // signature port verifies under.
      expect(facts.subjectPublicKeyInfoDer[0]).toBe(0x30);
      expect(facts.subjectNames.length).toBeGreaterThan(0);
    },
  );

  test("a real chain never verifies against an empty root set", () => {
    // The default configuration: a verifier ships with no roots, so even a
    // perfectly good production chain stays `present` (§8 step 3).
    expect(nodeCryptoAnchorPorts.chainVerifier.verifyCertificateChain({
      certificateChainDer: REAL_TOKENS.map((token) => signerCertificateOf(token.tokenDer)),
      trustAnchorsDer: [],
      atTime: "2026-08-17T20:37:56Z",
    })).toBe(false);
  });
});
