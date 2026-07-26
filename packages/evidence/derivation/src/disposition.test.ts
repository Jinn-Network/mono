import { describe, expect, test } from "vitest";

import { applyDerivationDispositions } from "./disposition.js";
import { baselinePolicyValue } from "./fixtures.js";
import type { DerivationFinding, DerivationSurface } from "./types.js";

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
): DerivationFinding => ({
  class: dispositionClass,
  confidence: "HIGH",
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

  test("retains exact text when no policy disposition matches", () => {
    expect(
      applyDerivationDispositions(
        surface,
        [finding("unconfigured")],
        baselinePolicyValue(),
      ),
    ).toEqual({ status: "retained", text: surface.text, counts: [] });
  });
});
