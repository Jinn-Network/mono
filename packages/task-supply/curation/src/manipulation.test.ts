import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectCuration } from "./projection.js";
import type { CurationObservation } from "./observation.js";

const observations = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/observations-manipulation.json", import.meta.url)), "utf8"),
) as CurationObservation[];

const isSybil = (o: CurationObservation): boolean => o.attribution.startsWith("urn:jinn:agent:sybil-");

describe("design F6 -- manipulation is visible in the inputs, and the rate is re-derivable", () => {
  it("derivation 1: the published projection carries the manipulated rate WITH its inputs", () => {
    const [row] = projectCuration(observations).rows;
    expect(row.passRate).toEqual({ num: 10, den: 12 });
    expect(row.verdicts).toBe(12);
    expect(row.attempts).toBe(12);
    const announced = new Set(row.inputRefs.map((r) => r.announcementId));
    for (const sybil of observations.filter(isSybil)) {
      expect(announced.has(sybil.ref.announcementId)).toBe(true);
    }
    expect(row.inputRefs).toHaveLength(12);
  });

  it("derivation 2: a consumer excluding the cohort re-derives a different rate", () => {
    const [row] = projectCuration(observations.filter((o) => !isSybil(o))).rows;
    expect(row.passRate).toEqual({ num: 2, den: 4 });
    expect(row.verdicts).toBe(4);
    const announced = new Set(row.inputRefs.map((r) => r.announcementId));
    for (const sybil of observations.filter(isSybil)) {
      expect(announced.has(sybil.ref.announcementId)).toBe(false);
    }
  });

  it("the two derivations disagree -- which is the whole point of publishing the inputs", () => {
    const manipulated = projectCuration(observations).rows[0].passRate;
    const filtered = projectCuration(observations.filter((o) => !isSybil(o))).rows[0].passRate;
    expect(manipulated.num * filtered.den).not.toBe(filtered.num * manipulated.den);
  });

  it("every row's inputRefs account for every verdict it counted", () => {
    for (const row of projectCuration(observations).rows) {
      expect(row.inputRefs).toHaveLength(row.verdicts);
      expect(new Set(row.inputRefs.map((r) => r.attemptUri)).size).toBe(row.attempts);
    }
  });
});
