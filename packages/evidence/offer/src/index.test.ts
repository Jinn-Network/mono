import { describe, expect, test } from "vitest";

import * as root from "./index.js";

describe("the public surface", () => {
  test("exports the record kind, its sealing pair, verification, and supersession", () => {
    for (const name of [
      "OFFER_RECORD_KIND",
      "OFFER_RECORD_MEDIA_TYPE",
      "OFFER_RECORD_SCHEMA_ID",
      "OFFER_TRUST_SCOPE",
      "OfferRecordSchema",
      "sealOffer",
      "sealOfferPayload",
      "parseOfferEnvelope",
      "parseExactOfferPayload",
      "verifyOffer",
      "resolveLiveOffers",
      "isFreeOffer",
      "sortOfferRails",
      "InvalidOfferError",
    ]) {
      expect(Object.hasOwn(root, name), `${name} must be exported`).toBe(true);
    }
  });

  // Signing is required for this kind: an unsigned seal export would be a price anyone
  // could publish for anyone else's bytes.
  test("exposes no unsigned record-sealing entry point", () => {
    expect("sealUnsignedOffer" in root).toBe(false);
    expect("sealUnsignedOfferPayload" in root).toBe(false);
  });

  // The fixture signer and the conformance kit belong to /testing, never the root.
  test("keeps the testing kit out of the production entrypoint", () => {
    expect("describeOfferRecordConformance" in root).toBe(false);
    expect("createFixtureOfferSigner" in root).toBe(false);
    expect("loadGoldenEnvelope" in root).toBe(false);
  });
});
