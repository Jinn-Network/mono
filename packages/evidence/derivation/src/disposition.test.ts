// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { applyDerivationDispositions } from "./disposition.js";
import { baselinePolicyValue } from "./fixtures.js";
import type {
  ConfidenceBand,
  DerivationFinding,
  DerivationSurface,
} from "./types.js";

const surface: DerivationSurface = {
  surfaceId: "artifact:test:text",
  sourceEntityId: "test",
  role: "other",
  mediaType: "text/plain",
  codec: "text",
  location: "",
  text: "one ada@example.invalid three",
};

const finding = (
  dispositionClass: string,
  start = 4,
  end = 23,
  confidence: ConfidenceBand = "HIGH",
): DerivationFinding => ({
  class: dispositionClass,
  confidence,
  surfaceId: surface.surfaceId,
  start,
  end,
  evidence: ["shape"],
  detector: {
    id: "test",
    version: "1",
    implementationDigest: `sha256:${"a".repeat(64)}`,
    reproducibility: "byte-stable",
  },
});

describe("disposition", () => {
  test("applies exact policy stubs without offset drift", () => {
    const result = applyDerivationDispositions(
      surface,
      [finding("email")],
      baselinePolicyValue(),
    );
    expect(result).toMatchObject({
      status: "redacted",
      text: "one [REDACTED_EMAIL] three",
    });
  });

  test("returns review findings without transformed text", () => {
    const policy = baselinePolicyValue();
    (policy as { dispositions: typeof policy.dispositions }).dispositions = [
      {
        class: "email",
        minimumConfidence: "LOW",
        disposition: "review",
      },
    ];
    expect(
      applyDerivationDispositions(surface, [finding("email")], policy),
    ).toMatchObject({ status: "review-required" });
  });

  test("withhold-record dominates redaction", () => {
    const policy = baselinePolicyValue();
    (policy as { dispositions: typeof policy.dispositions }).dispositions = [
      ...policy.dispositions,
      {
        class: "catastrophic",
        minimumConfidence: "LOW",
        disposition: "withhold-record",
      },
    ];
    expect(
      applyDerivationDispositions(
        surface,
        [finding("email"), finding("catastrophic", 0, 3)],
        policy,
      ),
    ).toEqual({
      status: "withhold-record",
      reasons: [{ code: "finding-withheld-record" }],
    });
  });

  test("fails closed when no policy disposition matches", () => {
    expect(
      applyDerivationDispositions(
        surface,
        [finding("unconfigured")],
        baselinePolicyValue(),
      ),
    ).toEqual({
      status: "withhold-record",
      reasons: [{ code: "finding-disposition-unavailable" }],
    });
  });

  test.each([
    ["ascending", ["VERY_LOW", "LOW", "HIGH"]],
    ["descending", ["HIGH", "LOW", "VERY_LOW"]],
  ] as const)(
    "selects the highest applicable confidence floor in %s policy order",
    (_name, order) => {
      const rows = {
        VERY_LOW: {
          class: "email",
          minimumConfidence: "VERY_LOW" as const,
          disposition: "retain" as const,
        },
        LOW: {
          class: "email",
          minimumConfidence: "LOW" as const,
          disposition: "retain" as const,
        },
        HIGH: {
          class: "email",
          minimumConfidence: "HIGH" as const,
          disposition: "withhold-record" as const,
        },
      };
      const policy = baselinePolicyValue();
      (policy as { dispositions: typeof policy.dispositions }).dispositions =
        order.map((confidence) => rows[confidence]);
      expect(
        applyDerivationDispositions(
          surface,
          [finding("email", 4, 23, "HIGH")],
          policy,
        ),
      ).toEqual({
        status: "withhold-record",
        reasons: [{ code: "finding-withheld-record" }],
      });
    },
  );

  test.each([
    ["LOW", "redacted"],
    ["HIGH", "review-required"],
    ["VERY_HIGH", "withhold-record"],
  ] as const)(
    "applies the highest eligible disposition ladder row at %s",
    (confidence, expectedStatus) => {
      const policy = baselinePolicyValue();
      (policy as { dispositions: typeof policy.dispositions }).dispositions = [
        {
          class: "email",
          minimumConfidence: "VERY_LOW",
          disposition: "redact",
        },
        {
          class: "email",
          minimumConfidence: "MEDIUM",
          disposition: "review",
        },
        {
          class: "email",
          minimumConfidence: "VERY_HIGH",
          disposition: "withhold-record",
        },
      ];
      expect(
        applyDerivationDispositions(
          surface,
          [finding("email", 4, 23, confidence)],
          policy,
        ).status,
      ).toBe(expectedStatus);
    },
  );
});
