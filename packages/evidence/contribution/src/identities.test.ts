// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
  compareCodeUnitStrings,
  createContributionReceiptFingerprint,
  fingerprintContributionRecord,
} from "./identities.js";
import type { ContributionReceipt } from "./types.js";

describe("compareCodeUnitStrings", () => {
  test("orders lexicographically by UTF-16 code unit, not numeric collation", () => {
    expect(compareCodeUnitStrings("10", "9")).toBeLessThan(0);
    expect(compareCodeUnitStrings("2", "10")).toBeGreaterThan(0);
  });

  test("returns zero for identical strings", () => {
    expect(compareCodeUnitStrings("same", "same")).toBe(0);
  });
});

describe("fingerprintContributionRecord", () => {
  test("is stable regardless of key insertion order", () => {
    const first = fingerprintContributionRecord({ a: 1, b: 2 });
    const second = fingerprintContributionRecord({ b: 2, a: 1 });
    expect(first).toBe(second);
  });

  test("differs when content differs", () => {
    const first = fingerprintContributionRecord({ a: 1 });
    const second = fingerprintContributionRecord({ a: 2 });
    expect(first).not.toBe(second);
  });
});

describe("createContributionReceiptFingerprint", () => {
  function receipt(
    destinations: ContributionReceipt["destinations"],
  ): ContributionReceipt {
    return {
      schemaVersion: 1,
      requestId: "request-1",
      status: "publishing",
      previewFingerprint: `sha256:${"a".repeat(64)}`,
      destinations,
      generatedAt: "2026-07-28T00:00:00Z",
    };
  }

  test("is independent of destination array order", () => {
    const first = receipt([
      { destination: "https://b.example", status: "published", deactivated: false },
      { destination: "https://a.example", status: "published", deactivated: false },
    ]);
    const second = receipt([
      { destination: "https://a.example", status: "published", deactivated: false },
      { destination: "https://b.example", status: "published", deactivated: false },
    ]);
    expect(createContributionReceiptFingerprint(first))
      .toBe(createContributionReceiptFingerprint(second));
  });

  test("changes when a destination outcome changes", () => {
    const first = receipt([
      { destination: "https://a.example", status: "published", deactivated: false },
    ]);
    const second = receipt([
      { destination: "https://a.example", status: "publishing", deactivated: false },
    ]);
    expect(createContributionReceiptFingerprint(first))
      .not.toBe(createContributionReceiptFingerprint(second));
  });
});
