// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { comparePlanes, PLANES } from "./planes.js";
import { compareCodeUnitStrings } from "./order.js";

describe("ordering primitives", () => {
  test("compareCodeUnitStrings is a total order without locale sensitivity", () => {
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(compareCodeUnitStrings("b", "a")).toBe(1);
    expect(compareCodeUnitStrings("ä", "b")).toBe(1);
  });

  test("sorting digests is stable and byte-ordered", () => {
    const sorted = ["sha256:b0", "sha256:a1", "sha256:A9"].sort(compareCodeUnitStrings);
    expect(sorted).toEqual(["sha256:A9", "sha256:a1", "sha256:b0"]);
  });

  test("the local plane sorts before the public plane", () => {
    expect(comparePlanes("local", "public")).toBe(-1);
    expect(comparePlanes("public", "local")).toBe(1);
    expect(comparePlanes("local", "local")).toBe(0);
  });

  test("PLANES enumerates both planes in ranking order", () => {
    expect([...PLANES]).toEqual(["local", "public"]);
  });
});
