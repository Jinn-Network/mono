import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldCuration, projectCuration } from "./projection.js";
import { CurationInputError } from "./observation.js";
import type { CurationObservation } from "./observation.js";

const observations = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/observations-bucket.json", import.meta.url)), "utf8"),
) as CurationObservation[];

describe("foldCuration", () => {
  it("with no previous projection equals projectCuration", () => {
    expect(foldCuration(undefined, observations)).toEqual(projectCuration(observations));
  });

  it("folding in two batches equals projecting the union", () => {
    const first = observations.slice(0, 3);
    const rest = observations.slice(3);
    expect(foldCuration(projectCuration(first), rest)).toEqual(projectCuration(observations));
  });

  it("is associative across three batches", () => {
    const [a, b, c] = [observations.slice(0, 2), observations.slice(2, 5), observations.slice(5)];
    const stepwise = foldCuration(foldCuration(projectCuration(a), b), c);
    expect(stepwise).toEqual(projectCuration(observations));
  });

  it("is idempotent under at-least-once redelivery", () => {
    const once = projectCuration(observations);
    expect(foldCuration(once, observations)).toEqual(once);
    expect(foldCuration(once, [...observations, ...observations])).toEqual(once);
  });

  it("round-trips a projection unchanged when nothing new arrives", () => {
    const projection = projectCuration(observations);
    expect(foldCuration(projection, [])).toEqual(projection);
  });

  it("recovers the fail and inconclusive counters from a previous projection", () => {
    const seedBatch = observations.filter((o) => o.benchmarkRun === undefined).slice(0, 3);
    const tail = observations.filter((o) => o.benchmarkRun === undefined).slice(3);
    const folded = foldCuration(projectCuration(seedBatch), tail).rows[0];
    const direct = projectCuration([...seedBatch, ...tail]).rows[0];
    expect(folded).toEqual(direct);
  });

  it("opens a new bucket row mid-fold", () => {
    const organic = observations.filter((o) => o.benchmarkRun === undefined);
    const pinned = observations.filter((o) => o.benchmarkRun !== undefined);
    const folded = foldCuration(projectCuration(organic), pinned);
    expect(folded.rows.map((r) => r.bucket)).toEqual(["benchmark", "organic"]);
    expect(folded).toEqual(projectCuration(observations));
  });

  // A previous projection is an input, not a trusted intermediate. Folding an invalid row
  // forward would publish a rate with no attribution-preserving inputs behind it.
  it("rejects a previous projection whose rows violate the row invariant", () => {
    const bareRate = {
      rows: [
        {
          taskDigest: "not-a-digest",
          bucket: "organic",
          attempts: 0,
          verdicts: 1_000_000,
          passRate: { num: 999_999, den: 1_000_000 },
          window: { first: "2026-07-31T00:00:00Z", last: "2026-07-31T01:00:00Z" },
          inputRefs: [],
        },
      ],
    };
    expect(() => foldCuration(bareRate as never, [])).toThrow(CurationInputError);
  });

  it("rejects a previous projection whose counters contradict its inputRefs", () => {
    const previous = projectCuration(observations);
    const tampered = {
      rows: previous.rows.map((row) => ({ ...row, inputRefs: row.inputRefs.slice(1) })),
    };
    expect(() => foldCuration(tampered as never, [])).toThrow(CurationInputError);
  });
});
