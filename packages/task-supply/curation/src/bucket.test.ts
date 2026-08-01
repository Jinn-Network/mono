import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectCuration } from "./projection.js";
import type { CurationObservation } from "./observation.js";

const observations = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/observations-bucket.json", import.meta.url)), "utf8"),
) as CurationObservation[];

describe("bucket axis", () => {
  it("emits one row per (task, bucket), benchmark first by row order", () => {
    const rows = projectCuration(observations).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.bucket)).toEqual(["benchmark", "organic"]);
    expect(new Set(rows.map((r) => r.taskDigest)).size).toBe(1);
  });

  it("keeps benchmark-pinned attempts out of the organic observed pass rate", () => {
    const rows = projectCuration(observations).rows;
    const organic = rows.find((r) => r.bucket === "organic")!;
    const benchmark = rows.find((r) => r.bucket === "benchmark")!;
    expect(organic.passRate).toEqual({ num: 2, den: 4 });
    expect(benchmark.passRate).toEqual({ num: 3, den: 4 });
  });

  it("buckets on the presence of the judged delivery's benchrun attribute", () => {
    const rows = projectCuration(observations).rows;
    const benchmark = rows.find((r) => r.bucket === "benchmark")!;
    const benchmarkRefs = new Set(benchmark.inputRefs.map((r) => r.announcementId));
    for (const observation of observations) {
      const isPinned = observation.benchmarkRun !== undefined;
      expect(benchmarkRefs.has(observation.ref.announcementId)).toBe(isPinned);
    }
  });

  it("keeps each bucket's window independent", () => {
    const rows = projectCuration(observations).rows;
    const organic = rows.find((r) => r.bucket === "organic")!;
    const benchmark = rows.find((r) => r.bucket === "benchmark")!;
    expect(organic.window).not.toEqual(benchmark.window);
  });
});
