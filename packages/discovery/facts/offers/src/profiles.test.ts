import {
  assertRecordKindUri,
  cloudEventsFields,
  referenceBearingFields,
} from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import { OFFER_RECORD_KIND } from "./identifiers.js";
import { offerFactsProfile } from "./profiles.js";

describe("offer facts profile (design §12)", () => {
  it("binds the record kind discovery's own grammar accepts", () => {
    expect(() => assertRecordKindUri(OFFER_RECORD_KIND)).not.toThrow();
    expect(offerFactsProfile.kind).toBe(OFFER_RECORD_KIND);
    expect(offerFactsProfile.profile).toBe("https://spec.jinn.network/facts/offer/v1");
  });

  it("names exactly the card the design allows and nothing else", () => {
    expect(offerFactsProfile.fields.map((field) => field.name)).toEqual([
      "offerRecordDigest",
      "subject",
      "priced",
      "rails.rail",
      "rails.amount",
    ]);
  });

  it("carries no gate, no supersedes, and no liveness field", () => {
    const names = new Set(offerFactsProfile.fields.map((field) => field.name));
    for (const absent of ["gate.uri", "supersedes", "live", "withdrawn", "expiresAt"]) {
      expect(names.has(absent), `${absent} must not be a card field`).toBe(false);
    }
  });

  it("declares every field a record fact — an offer has no substrate facts", () => {
    for (const field of offerFactsProfile.fields) expect(field.class).toBe("record");
  });

  it("declares subject reference-bearing so referrers inverts it into 'offers for X'", () => {
    expect(referenceBearingFields(offerFactsProfile)).toEqual(["subject"]);
  });

  it("lifts only the scalar filters into CloudEvents attributes, never the rail arrays", () => {
    expect(
      cloudEventsFields(offerFactsProfile).map((field) => [field.name, field.cloudEvents?.attribute]),
    ).toEqual([
      ["subject", "subject"],
      ["priced", "priced"],
    ]);
  });
});
