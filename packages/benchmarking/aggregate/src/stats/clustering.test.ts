import { describe, expect, test } from "vitest";
import { clusterBy } from "./clustering.js";

describe("clusterBy", () => {
  test("groups items sharing a key, preserving encounter order within each cluster", () => {
    const items = ["a1", "b1", "a2", "a3", "b2"];
    const clusters = clusterBy(items, (item) => item[0]!);
    expect([...clusters.keys()].sort()).toEqual(["a", "b"]);
    expect(clusters.get("a")).toEqual(["a1", "a2", "a3"]);
    expect(clusters.get("b")).toEqual(["b1", "b2"]);
  });

  test("an item with a unique key is its own singleton cluster", () => {
    const clusters = clusterBy(["x"], (item) => item);
    expect(clusters.get("x")).toEqual(["x"]);
    expect(clusters.size).toBe(1);
  });

  test("empty input yields an empty map", () => {
    expect(clusterBy([], () => "k").size).toBe(0);
  });
});
