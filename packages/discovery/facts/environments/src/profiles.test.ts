import { assertRecordKindUri, referenceBearingFields, cloudEventsFields } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import { ENVIRONMENT_RECORD_KIND } from "./identifiers.js";
import { environmentFactsProfile, environmentFactsProfileV2 } from "./profiles.js";

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

describe("environment facts profile v2 (join-edge completeness, design §12 amendment)", () => {
  it("binds the same record kind under the next profile version", () => {
    expect(environmentFactsProfileV2.kind).toBe(ENVIRONMENT_RECORD_KIND);
    expect(environmentFactsProfileV2.profile).toBe("https://spec.jinn.network/facts/environment/v2");
  });

  it("adds the record's remaining digest-pinned components to v1's field set", () => {
    expect(environmentFactsProfileV2.fields.map((field) => field.name).sort()).toEqual([
      "build.recipeDigest",
      "build.reproducibilityTier",
      "environmentRecordDigest",
      "image.indexDigest",
      "image.manifestDigest",
      "image.platform",
      "parser.digest",
      "source.commit",
      "source.repo",
    ]);
  });

  it("declares every component the record pins by digest: image, index, parser, recipe", () => {
    expect(referenceBearingFields(environmentFactsProfileV2)).toEqual([
      "image.manifestDigest",
      "image.indexDigest",
      "parser.digest",
      "build.recipeDigest",
    ]);
  });

  it("leaves v1 untouched", () => {
    expect(referenceBearingFields(environmentFactsProfile)).toEqual(["image.manifestDigest"]);
  });
});
