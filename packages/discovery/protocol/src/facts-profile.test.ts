import { describe, expect, it } from "vitest";

import { RECORD_DISCOVERY_VERSION, RECORD_KINDS } from "./identifiers.js";
import { sealJson } from "./sealing.js";
import {
  cloudEventsFields,
  parseFactsProfile,
  referenceBearingFields,
  type FactsProfileDocument,
} from "./facts-profile.js";

// Facts-profile contract (design §12, plan Task 6): the protocol package
// owns the declarative shape every `discovery/facts/*` leaf's documents
// conform to. Fields self-label record-vs-substrate class, reference-bearing
// status (§8 referrers inversion), and CloudEvents liftability (§9.1).

function baseProfile(fields: FactsProfileDocument["fields"]): FactsProfileDocument {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    kind: RECORD_KINDS.submission,
    profile: "https://jinn.network/records/submission/facts-profile/1.0",
    fields,
  };
}

describe("parseFactsProfile", () => {
  it("accepts a substrate-class field alongside record-class fields", () => {
    const profile = baseProfile([
      { name: "taskDigest", class: "record", referenceBearing: true },
      { name: "escrowTerms", class: "substrate" },
    ]);
    expect(parseFactsProfile(profile)).toEqual(profile);
  });

  it("rejects a cloudEvents.attribute that violates CloudEvents attribute-naming rules", () => {
    const uppercase = baseProfile([
      { name: "taskDigest", class: "record", cloudEvents: { attribute: "TaskDigest", scalar: "string" } },
    ]);
    expect(() => parseFactsProfile(uppercase)).toThrow();

    const tooLong = baseProfile([
      {
        name: "taskDigest",
        class: "record",
        cloudEvents: { attribute: "a".repeat(21), scalar: "string" },
      },
    ]);
    expect(() => parseFactsProfile(tooLong)).toThrow();

    const withHyphen = baseProfile([
      { name: "taskDigest", class: "record", cloudEvents: { attribute: "task-digest", scalar: "string" } },
    ]);
    expect(() => parseFactsProfile(withHyphen)).toThrow();
  });

  it("accepts a conforming cloudEvents attribute name", () => {
    const profile = baseProfile([
      { name: "taskDigest", class: "record", cloudEvents: { attribute: "taskdigest", scalar: "string" } },
    ]);
    expect(parseFactsProfile(profile)).toEqual(profile);
  });
});

describe("referenceBearingFields", () => {
  it("returns only the flagged fields' names", () => {
    const profile = baseProfile([
      { name: "taskDigest", class: "record", referenceBearing: true },
      { name: "requesterIri", class: "record" },
      { name: "deadline", class: "record", referenceBearing: false },
    ]);
    expect(referenceBearingFields(profile)).toEqual(["taskDigest"]);
  });

  it("returns an empty array when no field is reference-bearing", () => {
    const profile = baseProfile([{ name: "deadline", class: "record" }]);
    expect(referenceBearingFields(profile)).toEqual([]);
  });
});

describe("cloudEventsFields", () => {
  it("returns only the fields declaring a cloudEvents mapping", () => {
    const liftable = { name: "taskDigest", class: "record" as const, cloudEvents: { attribute: "taskdigest", scalar: "string" as const } };
    const notLiftable = { name: "deadline", class: "record" as const };
    const profile = baseProfile([liftable, notLiftable]);
    expect(cloudEventsFields(profile)).toEqual([liftable]);
  });
});

describe("sealed facts-profile documents", () => {
  it("seal to the same digest regardless of input key order", () => {
    const a = baseProfile([{ name: "taskDigest", class: "record", referenceBearing: true }]);
    const b = {
      fields: a.fields,
      profile: a.profile,
      kind: a.kind,
      protocol: a.protocol,
    };
    expect(sealJson(a).digest).toBe(sealJson(b).digest);
  });
});
