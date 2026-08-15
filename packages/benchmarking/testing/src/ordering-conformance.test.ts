import { describe, expect, test } from "vitest";
import {
  describeOrderingConformance,
  isAnchoredOrderValid,
} from "./ordering-conformance.js";

describeOrderingConformance();

describe("isAnchoredOrderValid exact authority ordering", () => {
  test("detects a sub-millisecond announcement-order violation", () => {
    expect(isAnchoredOrderValid({
      runAnnouncedAt: "2026-07-29T00:00:00.0002Z",
      earliestCellPostAt: "2026-07-29T00:00:00.0001Z",
      violatesOrder: true,
    })).toBe(false);
  });

  test("accepts equal instants expressed under different offsets", () => {
    expect(isAnchoredOrderValid({
      runAnnouncedAt: "2026-07-29T02:30:00.123400+02:30",
      earliestCellPostAt: "2026-07-29T00:00:00.1234Z",
      violatesOrder: false,
    })).toBe(true);
  });
});
