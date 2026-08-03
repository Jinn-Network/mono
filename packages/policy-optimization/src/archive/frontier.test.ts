// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { frontier, frontierMembers } from "./frontier.js";
import { PRODUCT_FRONTIER_DIMENSIONS, type FrontierEntry } from "./types.js";

const QUALITY_ONLY = [{ key: "quality", direction: "maximize" }] as const;

function entry(tupleDigest: string, values: Record<string, string>): FrontierEntry {
  return { tupleDigest, values };
}

const members = (entries: readonly FrontierEntry[], dimensions = PRODUCT_FRONTIER_DIMENSIONS) =>
  frontierMembers(frontier(entries, dimensions));

describe("frontier", () => {
  it("keeps the non-dominated entries and drops the dominated one", () => {
    // `cheap` wins on cost and latency, `good` wins on quality; `worse` loses on all three.
    const result = members([
      entry("sha256:good", { quality: "0.90", cost: "5.00", latency: "900" }),
      entry("sha256:cheap", { quality: "0.70", cost: "1.00", latency: "100" }),
      entry("sha256:worse", { quality: "0.60", cost: "6.00", latency: "1000" }),
    ]);
    expect(result).toEqual(["sha256:cheap", "sha256:good"]);
  });

  it("returns a set, not a ranking", () => {
    const result = frontier([
      entry("sha256:a", { quality: "0.90", cost: "1.00", latency: "100" }),
      entry("sha256:b", { quality: "0.10", cost: "9.00", latency: "900" }),
    ], PRODUCT_FRONTIER_DIMENSIONS);
    expect(result).toBeInstanceOf(Set);
    expect(result.has("sha256:a")).toBe(true);
    expect(result.has("sha256:b")).toBe(false);
  });

  it("keeps both entries of an exact tie — neither dominates the other", () => {
    expect(members([
      entry("sha256:a", { quality: "0.80", cost: "2.00", latency: "200" }),
      entry("sha256:b", { quality: "0.80", cost: "2.00", latency: "200" }),
    ])).toEqual(["sha256:a", "sha256:b"]);
  });

  // "At least as good everywhere, strictly better somewhere" — equal everywhere is not domination.
  it("keeps an entry that ties on every dimension but one and wins that one", () => {
    expect(members([
      entry("sha256:a", { quality: "0.80", cost: "2.00", latency: "200" }),
      entry("sha256:b", { quality: "0.80", cost: "2.00", latency: "199" }),
    ])).toEqual(["sha256:b"]);
  });

  it("compares decimals exactly rather than by string or by float", () => {
    // "0.10" and "0.1" are the same number and different strings; "0.30" beats "0.3" nowhere.
    expect(members([
      entry("sha256:a", { quality: "0.30" }),
      entry("sha256:b", { quality: "0.3" }),
    ], QUALITY_ONLY)).toEqual(["sha256:a", "sha256:b"]);
    // The float trap: 0.1 + 0.2 !== 0.3 in IEEE 754, but these are compared as scaled integers.
    expect(members([
      entry("sha256:a", { quality: "0.30000000000000004" }),
      entry("sha256:b", { quality: "0.3" }),
    ], QUALITY_ONLY)).toEqual(["sha256:a"]);
  });

  it("respects each dimension's direction", () => {
    expect(members([
      entry("sha256:slow", { latency: "900" }),
      entry("sha256:fast", { latency: "100" }),
    ], [{ key: "latency", direction: "minimize" }])).toEqual(["sha256:fast"]);
    expect(members([
      entry("sha256:slow", { latency: "900" }),
      entry("sha256:fast", { latency: "100" }),
    ], [{ key: "latency", direction: "maximize" }])).toEqual(["sha256:slow"]);
  });

  it("is empty on no entries and whole on one", () => {
    expect(members([])).toEqual([]);
    expect(members([entry("sha256:only", { quality: "0.5", cost: "1", latency: "1" })]))
      .toEqual(["sha256:only"]);
  });

  it("refuses an entry missing a declared dimension", () => {
    expect(() => members([
      entry("sha256:a", { quality: "0.9", cost: "1", latency: "1" }),
      entry("sha256:b", { quality: "0.8", cost: "1" }),
    ])).toThrow(expect.objectContaining({ category: "archive-derivation" }));
  });

  it("refuses a value it cannot order exactly", () => {
    expect(() => members([
      entry("sha256:a", { quality: "0.9" }),
      entry("sha256:b", { quality: "not-a-decimal" }),
    ], QUALITY_ONLY)).toThrow(expect.objectContaining({ category: "archive-derivation" }));
  });

  it("refuses no dimensions, a duplicate dimension, and a duplicate tuple digest", () => {
    expect(() => frontier([], []))
      .toThrow(expect.objectContaining({ category: "archive-derivation" }));
    expect(() => frontier([], [
      { key: "quality", direction: "maximize" },
      { key: "quality", direction: "minimize" },
    ])).toThrow(expect.objectContaining({ category: "archive-derivation" }));
    expect(() => members([
      entry("sha256:a", { quality: "0.9" }),
      entry("sha256:a", { quality: "0.8" }),
    ], QUALITY_ONLY)).toThrow(expect.objectContaining({ category: "archive-derivation" }));
  });

  it("does not depend on input order", () => {
    const entries = [
      entry("sha256:good", { quality: "0.90", cost: "5.00", latency: "900" }),
      entry("sha256:cheap", { quality: "0.70", cost: "1.00", latency: "100" }),
      entry("sha256:worse", { quality: "0.60", cost: "6.00", latency: "1000" }),
    ];
    expect(members(entries)).toEqual(members([...entries].reverse()));
  });
});
