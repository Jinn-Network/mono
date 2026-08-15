// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  EXTRACTION_FAILURE_DISPOSITIONS,
  EXTRACTION_FAILURE_REASONS,
  EXTRACTION_STAGES,
  classifyExtractionFailure,
  stageForExtractionFailure,
} from "./failures.js";

describe("the extraction failure taxonomy", () => {
  it("classifies every reason, exactly once, into the five dispositions", () => {
    for (const reason of EXTRACTION_FAILURE_REASONS) {
      expect(EXTRACTION_FAILURE_DISPOSITIONS).toContain(classifyExtractionFailure(reason));
      expect(EXTRACTION_STAGES).toContain(stageForExtractionFailure(reason));
    }
    expect(new Set(EXTRACTION_FAILURE_REASONS).size).toBe(EXTRACTION_FAILURE_REASONS.length);
  });

  it("retries only infrastructure; archive-unavailable is not an infrastructure retry", () => {
    // A provider that cannot serve the anchor will not serve it on the next attempt
    // either; that is a fact about the archive, and the loop must surface it rather
    // than burn the budget rediscovering it.
    expect(classifyExtractionFailure("archive-unreachable")).toBe("archive-unavailable");
    expect(classifyExtractionFailure("archive-anchor-pruned")).toBe("archive-unavailable");
    expect(classifyExtractionFailure("runtime-failure")).toBe("infrastructure");
    expect(classifyExtractionFailure("artifact-store-failure")).toBe("infrastructure");
  });

  it("keeps the two non-convergence shapes distinct", () => {
    // Exhausting the bound and diverging with nothing to widen on are different
    // findings: the first says "the bound was too small", the second says "the
    // divergence is not a slice problem". Collapsing them would send the author
    // to raise a bound that cannot help.
    expect(classifyExtractionFailure("widen-bound-exhausted")).toBe("non-convergent");
    expect(classifyExtractionFailure("divergence-unexplained")).toBe("non-convergent");
    expect(classifyExtractionFailure("baseline-unstable")).toBe("non-convergent");
    expect(stageForExtractionFailure("baseline-unstable")).toBe("baseline");
    expect(stageForExtractionFailure("widen-bound-exhausted")).toBe("reverify");
  });

  it("puts budget exhaustion and coverage gaps under policy, never retry", () => {
    expect(classifyExtractionFailure("archive-budget-exhausted")).toBe("policy");
    expect(classifyExtractionFailure("coverage-incomplete")).toBe("policy");
    expect(classifyExtractionFailure("harvest-empty")).toBe("policy");
    expect(classifyExtractionFailure("archive-self-disagreement")).toBe("provider-disagreement");
    expect(classifyExtractionFailure("archive-root-mismatch")).toBe("provider-disagreement");
  });
});
