import {
  assertRecordKindUri,
  cloudEventsFields,
  referenceBearingFields,
} from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  INFORMATION_WORLD_KIND,
} from "./identifiers.js";
import {
  chainEnvironmentFactsProfile,
  cryptoEnvironmentFactsProfile,
  informationWorldFactsProfile,
} from "./profiles.js";

describe("chain-environment facts profile (CF4)", () => {
  it("binds a record kind discovery's own grammar accepts", () => {
    expect(() => assertRecordKindUri(CHAIN_ENVIRONMENT_KIND)).not.toThrow();
    expect(chainEnvironmentFactsProfile.kind).toBe(CHAIN_ENVIRONMENT_KIND);
    expect(chainEnvironmentFactsProfile.profile).toBe("https://spec.jinn.network/facts/chain-environment/v1");
  });

  it("names exactly the fields the leaf declares", () => {
    expect(chainEnvironmentFactsProfile.fields.map((field) => field.name).sort()).toEqual([
      "chainEnvironmentRecordDigest",
      "runtime.family",
      "runtime.image.manifestDigest",
      "runtime.version",
      "stateMaterialization.closureClass",
      "stateMaterialization.fidelityClass",
      "stateMaterialization.stateArtifactDigest",
    ]);
  });

  it("declares every field a record fact — a chain environment record has no substrate facts", () => {
    for (const field of chainEnvironmentFactsProfile.fields) expect(field.class).toBe("record");
  });

  it("declares the image and the state artifact reference-bearing so referrers inverts them", () => {
    expect(referenceBearingFields(chainEnvironmentFactsProfile).sort()).toEqual([
      "runtime.image.manifestDigest",
      "stateMaterialization.stateArtifactDigest",
    ]);
  });

  it("lifts the filterable fields into CloudEvents attributes", () => {
    expect(
      cloudEventsFields(chainEnvironmentFactsProfile).map((field) => [field.name, field.cloudEvents?.attribute]),
    ).toEqual([
      ["runtime.family", "family"],
      ["runtime.version", "rtversion"],
      ["runtime.image.manifestDigest", "image"],
      ["stateMaterialization.closureClass", "closure"],
      ["stateMaterialization.fidelityClass", "fidelity"],
      ["stateMaterialization.stateArtifactDigest", "artifact"],
    ]);
  });
});

describe("crypto-environment facts profile", () => {
  it("binds the composite kind", () => {
    expect(() => assertRecordKindUri(CRYPTO_ENVIRONMENT_KIND)).not.toThrow();
    expect(cryptoEnvironmentFactsProfile.kind).toBe(CRYPTO_ENVIRONMENT_KIND);
    expect(cryptoEnvironmentFactsProfile.profile).toBe("https://spec.jinn.network/facts/crypto-environment/v1");
  });

  it("names exactly the fields the leaf declares", () => {
    expect(cryptoEnvironmentFactsProfile.fields.map((field) => field.name).sort()).toEqual([
      "chainWorld.digest",
      "composition.requestBudget.maxRequests",
      "cryptoEnvironmentRecordDigest",
      "informationWorldCount",
    ]);
  });

  it("declares the chain-world digest reference-bearing: it is a record-to-record edge", () => {
    expect(referenceBearingFields(cryptoEnvironmentFactsProfile)).toEqual(["chainWorld.digest"]);
  });
});

describe("information world facts profile", () => {
  it("declares the kind and the fields the card projects", () => {
    expect(informationWorldFactsProfile.kind).toBe(INFORMATION_WORLD_KIND);
    expect(informationWorldFactsProfile.fields.map((field) => field.name).sort()).toEqual([
      "capture.fidelity",
      "corpus.entryCount",
      "corpus.originCount",
      "informationWorldRecordDigest",
      "requestKeyPolicy.version",
    ]);
  });

  it("no field is reference-bearing: a corpus body is not an announceable record", () => {
    expect(informationWorldFactsProfile.fields.some((field) => field.referenceBearing)).toBe(false);
  });
});
