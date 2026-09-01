import { describe, expect, test } from "vitest";

import {
  OFFER_RECORD_KIND,
  OFFER_RECORD_MEDIA_TYPE,
  OFFER_RECORD_SCHEMA_ID,
  OFFER_TRUST_SCOPE,
} from "./identifiers.js";

// Mirror of discovery's record-kind URI grammar (DR-2026-08-04): one origin,
// `https://spec.jinn.network`, and one version form, `v<major>`. Mirrored rather than
// imported because this package depends on trust-core alone; the reference implementation
// is packages/discovery/protocol/src/grammar.ts.
const RECORD_KIND_GRAMMAR =
  /^https:\/\/spec\.jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/v[1-9]\d*$/;

describe("identifiers", () => {
  test("the record kind is the exact string the design pins", () => {
    expect(OFFER_RECORD_KIND).toBe("https://spec.jinn.network/records/offer/v1");
  });

  test("the record kind conforms to the platform record-kind URI grammar", () => {
    expect(OFFER_RECORD_KIND).toMatch(RECORD_KIND_GRAMMAR);
  });

  test("the mirrored grammar rejects the retired origin and version spellings", () => {
    for (const rejected of [
      "https://jinn.network/records/offer/v1",
      "https://spec.jinn.network/records/offer/1.0",
      "https://spec.jinn.network/records/offer/v0",
      "https://spec.jinn.network/records/Offer/v1",
      "https://spec.jinn.network/records/offer/v1/facts/v1",
      "https://evil.jinn.network/records/offer/v1",
    ]) {
      expect(rejected).not.toMatch(RECORD_KIND_GRAMMAR);
    }
  });

  test("the media type is the vendor-tree string, and is the DSSE payloadType", () => {
    expect(OFFER_RECORD_MEDIA_TYPE).toBe("application/vnd.jinn.offer.v1+json");
  });

  // A record-kind URI must never double as a directory prefix of a served document, so the
  // schema id is an independent identifier rather than one derived from the kind.
  test("the schema id is an independent schemas/<kind>/v<major> identifier", () => {
    expect(OFFER_RECORD_SCHEMA_ID).toBe("https://spec.jinn.network/schemas/offer/v1");
    expect(OFFER_RECORD_SCHEMA_ID.startsWith(OFFER_RECORD_KIND)).toBe(false);
  });

  test("the trust scope is spelled at the spec origin", () => {
    expect(OFFER_TRUST_SCOPE).toBe("https://spec.jinn.network/trust-scopes/offers/v1");
  });
});
