import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldPolicyOutcomes, projectPolicyOutcomes } from "./projection.js";
import { parsePolicyOutcomesProjection, serializePolicyOutcomesProjection } from "./serialize.js";
import type { PolicyOutcomeObservation } from "./observation.js";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

const observations = JSON.parse(read("observations-golden.json")) as PolicyOutcomeObservation[];
const golden = read("projection-golden.json");

describe("golden projection: two tuples x two buckets", () => {
  it("re-derives byte-for-byte from the fixture observations", () => {
    expect(serializePolicyOutcomesProjection(projectPolicyOutcomes(observations))).toBe(golden);
  });

  it("re-derives byte-for-byte from the reversed fixture observations", () => {
    expect(serializePolicyOutcomesProjection(projectPolicyOutcomes([...observations].reverse())))
      .toBe(golden);
  });

  it("re-derives byte-for-byte through an incremental fold", () => {
    const half = Math.floor(observations.length / 2);
    const folded = foldPolicyOutcomes(
      projectPolicyOutcomes(observations.slice(0, half)),
      observations.slice(half),
    );
    expect(serializePolicyOutcomesProjection(folded)).toBe(golden);
  });

  it("parses back into a projection that re-serializes identically", () => {
    expect(serializePolicyOutcomesProjection(parsePolicyOutcomesProjection(golden))).toBe(golden);
  });

  it("emits exactly one row per (tupleDigest, bucket) -- two tuples x two buckets = four rows", () => {
    const rows = projectPolicyOutcomes(observations).rows;
    expect(rows).toHaveLength(4);
    const digests = new Set(rows.map((r) => r.tupleDigest));
    expect(digests.size).toBe(2);
    const buckets = new Set(rows.map((r) => r.bucket));
    expect(buckets).toEqual(new Set(["benchmark", "organic"]));
  });

  it("pools observations from different subject tasks into the same tuple row", () => {
    // Row shape has no taskDigest -- policy-outcomes pools by TREATMENT, not by task, unlike
    // task-curation. The fixture deliberately mixes two distinct taskDigests per tuple.
    const alphaOrganic = projectPolicyOutcomes(observations).rows.find(
      (r) => r.bucket === "organic" && r.axes.harness && (r.axes.harness as { id: string }).id === "claude-code",
    )!;
    expect(alphaOrganic.verdicts).toBe(3);
    expect("taskDigest" in alphaOrganic).toBe(false);
  });
});
