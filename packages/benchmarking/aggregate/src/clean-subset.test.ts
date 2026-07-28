import { describe, expect, test } from "vitest";
import { filterByCutoff } from "./clean-subset.js";

describe("filterByCutoff (design §9.2 clean-subset@1)", () => {
  const timestamps: Record<string, string> = {
    t1: "2026-01-01T00:00:00Z",
    t2: "2026-02-01T00:00:00Z",
    t3: "2026-04-01T00:00:00Z",
    t4: "2026-05-01T00:00:00Z",
  };
  const resolve = (taskDigest: string): string | undefined => timestamps[taskDigest];

  test("keeps items at or after the cutoff (postdates a knowledge cutoff = clean)", () => {
    const result = filterByCutoff(["t1", "t2", "t3", "t4"], "2026-03-01T00:00:00Z", resolve);
    expect(result.kept).toEqual(["t3", "t4"]);
    expect(result.excludedByPredicate).toEqual(["t1", "t2"]);
  });

  test("an item exactly at the cutoff is kept (inclusive lower bound)", () => {
    const result = filterByCutoff(["t2"], "2026-02-01T00:00:00Z", resolve);
    expect(result.kept).toEqual(["t2"]);
  });

  test("an item with no resolvable timestamp is conservatively excluded, never assumed clean", () => {
    const result = filterByCutoff(["missing"], "2026-01-01T00:00:00Z", () => undefined);
    expect(result.kept).toEqual([]);
    expect(result.excludedByPredicate).toEqual(["missing"]);
  });

  test("rejects a malformed cutoff", () => {
    expect(() => filterByCutoff(["t1"], "not-a-date", resolve)).toThrow();
  });
});
