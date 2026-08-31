import { recordDigest } from "@jinn-network/record-discovery-protocol";
import { ENVIRONMENT_RECORD_KIND, sealEnvironmentRecord } from "@jinn-network/environment-record";
import { describe, expect, it } from "vitest";

import {
  ENVIRONMENTS_FACTS_RECOMPUTE,
  ENVIRONMENTS_FACTS_RECOMPUTE_V2,
  environmentRecompute,
  environmentRecomputeV2,
} from "./recompute.js";

const MANIFEST = `sha256:${"1".repeat(64)}`;

const document = {
  kind: ENVIRONMENT_RECORD_KIND,
  source: {
    repo: "example-org/example-lib",
    repoUrl: "https://github.com/example-org/example-lib",
    commit: "0".repeat(39) + "1",
  },
  image: { manifestDigest: MANIFEST, platform: "linux/amd64" },
  workspace: "/testbed",
  invocations: { test: [{ bin: "make", args: ["test"] }] },
  parser: { id: "pytest-text", version: "1.0.0", digest: `sha256:${"3".repeat(64)}` },
  build: { reproducibilityTier: 0 },
  rights: { sourceLicense: "Apache-2.0" },
};

const noReferences = { fetch: async () => undefined };

describe("environment record-fact recompute", () => {
  it("recomputes every fact from the record's own sealed bytes", async () => {
    const bytes = sealEnvironmentRecord(document);
    expect(await environmentRecompute(bytes, noReferences)).toEqual({
      environmentRecordDigest: recordDigest(bytes),
      "source.repo": "example-org/example-lib",
      "source.commit": "0".repeat(39) + "1",
      "image.manifestDigest": MANIFEST,
      "image.platform": "linux/amd64",
      "build.reproducibilityTier": 0,
    });
  });

  it("emits no facts for bytes that are not an environment record", async () => {
    expect(await environmentRecompute(new TextEncoder().encode('{"a":1}'), noReferences)).toEqual({});
  });

  it("emits no facts for re-canonicalized bytes", async () => {
    const pretty = new TextEncoder().encode(JSON.stringify(document, null, 2));
    expect(await environmentRecompute(pretty, noReferences)).toEqual({});
  });

  it("registers under the environment record kind and nothing else", () => {
    expect(ENVIRONMENTS_FACTS_RECOMPUTE.get(ENVIRONMENT_RECORD_KIND)).toBe(environmentRecompute);
    expect(ENVIRONMENTS_FACTS_RECOMPUTE.get("https://spec.jinn.network/records/benchmark/v1")).toBeUndefined();
  });
});

describe("environment v2 record-fact recompute", () => {
  it("recomputes v1's facts plus the parser edge, omitting the components this record has not", async () => {
    const bytes = sealEnvironmentRecord(document);
    expect(await environmentRecomputeV2(bytes, noReferences)).toEqual({
      environmentRecordDigest: recordDigest(bytes),
      "source.repo": "example-org/example-lib",
      "source.commit": "0".repeat(39) + "1",
      "image.manifestDigest": MANIFEST,
      "image.platform": "linux/amd64",
      "parser.digest": `sha256:${"3".repeat(64)}`,
      "build.reproducibilityTier": 0,
    });
  });

  it("names the multi-arch index and the build recipe when the record pins them", async () => {
    const bytes = sealEnvironmentRecord({
      ...document,
      image: { ...document.image, indexDigest: `sha256:${"4".repeat(64)}` },
      build: {
        reproducibilityTier: 1,
        recipe: { digest: { sha256: "5".repeat(64) } },
        dependencyPinning: { mechanism: "lockfile" },
      },
    });
    const facts = await environmentRecomputeV2(bytes, noReferences);
    expect(facts["image.indexDigest"]).toBe(`sha256:${"4".repeat(64)}`);
    expect(facts["build.recipeDigest"]).toBe(`sha256:${"5".repeat(64)}`);
  });

  it("treats a recipe that pins nothing by digest as no edge at all", async () => {
    const bytes = sealEnvironmentRecord({
      ...document,
      build: {
        reproducibilityTier: 1,
        recipe: { uri: "https://example.test/recipe" },
        dependencyPinning: { mechanism: "lockfile" },
      },
    });
    const facts = await environmentRecomputeV2(bytes, noReferences);
    expect(Object.hasOwn(facts, "build.recipeDigest")).toBe(false);
  });

  it("emits no facts for bytes that are not an environment record", async () => {
    expect(await environmentRecomputeV2(new TextEncoder().encode('{"a":1}'), noReferences)).toEqual({});
  });

  it("registers under the environment record kind and nothing else", () => {
    expect(ENVIRONMENTS_FACTS_RECOMPUTE_V2.get(ENVIRONMENT_RECORD_KIND)).toBe(environmentRecomputeV2);
    expect(ENVIRONMENTS_FACTS_RECOMPUTE_V2.get("https://spec.jinn.network/records/benchmark/v1")).toBeUndefined();
    expect(ENVIRONMENTS_FACTS_RECOMPUTE.get(ENVIRONMENT_RECORD_KIND)).toBe(environmentRecompute);
  });
});
