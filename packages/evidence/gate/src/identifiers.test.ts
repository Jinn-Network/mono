import { describe, expect, test } from "vitest";

import {
  DELIVERY_STATEMENT_RECORD_KIND,
  DELIVERY_STATEMENT_RECORD_MEDIA_TYPE,
  DELIVERY_STATEMENT_RECORD_SCHEMA_ID,
  DELIVERY_STATEMENT_TRUST_SCOPE,
} from "./identifiers.js";

// Mirror of discovery's record-kind URI grammar (DR-2026-08-04): one origin,
// `https://spec.jinn.network`, and one version form, `v<major>`. Mirrored rather than
// imported because this package does not depend on discovery; the reference
// implementation is packages/discovery/protocol/src/grammar.ts.
const RECORD_KIND_GRAMMAR =
  /^https:\/\/spec\.jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/v[1-9]\d*$/;

describe("identifiers", () => {
  test("the record kind is the exact string this issue pins", () => {
    expect(DELIVERY_STATEMENT_RECORD_KIND).toBe(
      "https://spec.jinn.network/records/delivery-statement/v1",
    );
  });

  test("the record kind conforms to the platform record-kind URI grammar", () => {
    expect(DELIVERY_STATEMENT_RECORD_KIND).toMatch(RECORD_KIND_GRAMMAR);
  });

  test("the mirrored grammar rejects the version spellings the platform retired", () => {
    for (const rejected of [
      "https://spec.jinn.network/records/delivery-statement/1.0",
      "https://spec.jinn.network/records/delivery-statement/v0",
      "https://spec.jinn.network/records/Delivery-Statement/v1",
      "https://spec.jinn.network/records/delivery-statement/v1/facts/v1",
      "https://evil.jinn.network/records/delivery-statement/v1",
    ]) {
      expect(rejected).not.toMatch(RECORD_KIND_GRAMMAR);
    }
  });

  test("the media type is the vendor-tree string, and is the DSSE payloadType", () => {
    expect(DELIVERY_STATEMENT_RECORD_MEDIA_TYPE).toBe(
      "application/vnd.jinn.delivery-statement.v1+json",
    );
  });

  test("the schema id is an independent schemas/<kind>/v<major> identifier", () => {
    expect(DELIVERY_STATEMENT_RECORD_SCHEMA_ID).toBe(
      "https://spec.jinn.network/schemas/delivery-statement/v1",
    );
    expect(
      DELIVERY_STATEMENT_RECORD_SCHEMA_ID.startsWith(DELIVERY_STATEMENT_RECORD_KIND),
    ).toBe(false);
  });

  test("the trust scope is its own, not the offers scope", () => {
    expect(DELIVERY_STATEMENT_TRUST_SCOPE).toBe(
      "https://spec.jinn.network/trust-scopes/delivery-statements/v1",
    );
    expect(DELIVERY_STATEMENT_TRUST_SCOPE).not.toBe(
      "https://spec.jinn.network/trust-scopes/offers/v1",
    );
  });
});
