import { assertRecordKindUri, referenceBearingFields, cloudEventsFields } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import { ENVIRONMENT_RECORD_KIND } from "./identifiers.js";
import { environmentFactsProfile } from "./profiles.js";

describe("environment facts profile (design §4.4)", () => {
  it("binds the record kind discovery's own grammar accepts", () => {
    expect(() => assertRecordKindUri(ENVIRONMENT_RECORD_KIND)).not.toThrow();
    expect(environmentFactsProfile.kind).toBe(ENVIRONMENT_RECORD_KIND);
    expect(environmentFactsProfile.profile).toBe("https://spec.jinn.network/facts/environment/v1");
  });

  it("names exactly the fields the design requires", () => {
    expect(environmentFactsProfile.fields.map((field) => field.name).sort()).toEqual([
      "build.reproducibilityTier",
      "environmentRecordDigest",
      "image.manifestDigest",
      "image.platform",
      "source.commit",
      "source.repo",
    ]);
  });

  it("declares every field a record fact — an environment record has no substrate facts", () => {
    for (const field of environmentFactsProfile.fields) expect(field.class).toBe("record");
  });

  it("declares image.manifestDigest reference-bearing so referrers inverts it", () => {
    expect(referenceBearingFields(environmentFactsProfile)).toEqual(["image.manifestDigest"]);
  });

  it("lifts the filterable fields into CloudEvents attributes", () => {
    expect(
      cloudEventsFields(environmentFactsProfile).map((field) => [field.name, field.cloudEvents?.attribute]),
    ).toEqual([
      ["source.repo", "repo"],
      ["source.commit", "commit"],
      ["image.manifestDigest", "image"],
      ["image.platform", "platform"],
      ["build.reproducibilityTier", "tier"],
    ]);
  });
});
