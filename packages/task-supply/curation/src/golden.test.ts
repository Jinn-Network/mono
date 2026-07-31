import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectCuration, foldCuration } from "./projection.js";
import { parseCurationProjection, serializeCurationProjection } from "./serialize.js";
import type { CurationObservation } from "./observation.js";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

const observations = JSON.parse(read("observations-golden.json")) as CurationObservation[];
const golden = read("projection-golden.json");

describe("golden projection", () => {
  it("re-derives byte-for-byte from the fixture observations", () => {
    expect(serializeCurationProjection(projectCuration(observations))).toBe(golden);
  });

  it("re-derives byte-for-byte from the reversed fixture observations", () => {
    expect(serializeCurationProjection(projectCuration([...observations].reverse()))).toBe(golden);
  });

  it("re-derives byte-for-byte through an incremental fold", () => {
    const half = Math.floor(observations.length / 2);
    const folded = foldCuration(projectCuration(observations.slice(0, half)), observations.slice(half));
    expect(serializeCurationProjection(folded)).toBe(golden);
  });

  it("parses back into a projection that re-serializes identically", () => {
    expect(serializeCurationProjection(parseCurationProjection(golden))).toBe(golden);
  });
});
