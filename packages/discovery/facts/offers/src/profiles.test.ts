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

  it("names the terms the design allows, plus the kind's remaining outbound edge", () => {
    expect(offerFactsProfile.fields.map((field) => field.name)).toEqual([
      "offerRecordDigest",
      "subject",
      "priced",
      "rails.rail",
      "rails.amount",
      "supersedes",
    ]);
  });

  it("carries no gate, no fee, no expiry, and no liveness field", () => {
    const names = new Set(offerFactsProfile.fields.map((field) => field.name));
    for (const absent of ["gate.uri", "fee", "cut", "live", "withdrawn", "expiresAt", "status"]) {
      expect(names.has(absent), `${absent} must not be a card field`).toBe(false);
    }
  });

  it("declares every field a record fact — an offer has no substrate facts", () => {
    for (const field of offerFactsProfile.fields) expect(field.class).toBe("record");
  });

  // The completeness rule (design §12, amendment 2026-08-28) is a MUST on a new profile: this
  // pin is the whole outbound set an offer seals. It is a change-detector authored from the
  // same reading of the schema as the profile, not an independent completeness proof.
  it("declares every digest the offer pins: the subject it prices and the offer it replaces", () => {
    expect(referenceBearingFields(offerFactsProfile)).toEqual(["subject", "supersedes"]);
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
