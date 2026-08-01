// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessClosure } from "./closure.js";

const RESOLVED = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`] as const;

function sealed(overrides: Record<string, unknown> = {}) {
  return {
    networkPolicy: {
      egress: "denied", dns: "absent", archiveRpc: "unreachable", forkBackend: "absent",
    },
    egressAttempts: [],
    boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: true },
    resolvedDigests: RESOLVED,
    loadedResources: RESOLVED,
    observationsEqual: true,
    ...overrides,
  } as const;
}

function forkBacked(overrides: Record<string, unknown> = {}) {
  return {
    ...sealed(),
    networkPolicy: {
      egress: "denied", dns: "absent", archiveRpc: "unreachable", forkBackend: "present",
    },
    boundaryProbe: undefined,
    egressAttempts: [{ target: "https://archive.example.test", outcome: "refused" }],
    ...overrides,
  } as const;
}

describe("closure assessment", () => {
  it("names the mode from the instance shape, never from the caller's preference", () => {
    expect(assessClosure(sealed()).mode).toBe("sealed-boundary");
    expect(assessClosure(forkBacked()).mode).toBe("fork-backend-refusal");
  });

  it("accepts a sealed instance on the boundary rule plus cross-run equality", () => {
    const assessment = assessClosure(sealed());
    expect(assessment.closed).toBe(true);
    expect(assessment.reason).toBeUndefined();
    expect(assessment.evidence).toContain("out-of-slice reads are empty");
    expect(assessment.evidence).toContain("cross-run observation equality");
  });

  it("refuses to call a sealed instance closed on absence of errors alone", () => {
    // No boundary probe: nothing was tried, nothing failed, and that is not evidence.
    expect(assessClosure(sealed({ boundaryProbe: undefined })))
      .toMatchObject({ closed: false, reason: "out-of-slice-read-not-empty" });
    expect(assessClosure(sealed({
      boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: false },
    }))).toMatchObject({ closed: false, reason: "out-of-slice-read-not-empty" });
    // Divergent observations are never closure evidence for a sealed instance.
    expect(assessClosure(sealed({ observationsEqual: false })))
      .toMatchObject({ closed: false, reason: "probe-observation-divergence" });
  });

  it("requires a recorded refusal from a fork-backed instance", () => {
    expect(assessClosure(forkBacked({ egressAttempts: [] })))
      .toMatchObject({ closed: false, reason: "fork-backend-fetch-unrefused" });
    expect(assessClosure(forkBacked({
      egressAttempts: [{ target: "https://archive.example.test", outcome: "succeeded" }],
    }))).toMatchObject({ closed: false, reason: "egress-succeeded" });
  });

  it("fails either mode when a resource outside the resolution log was loaded", () => {
    const stray = `sha256:${"9".repeat(64)}`;
    for (const input of [
      sealed({ loadedResources: [...RESOLVED, stray] }),
      forkBacked({ loadedResources: [...RESOLVED, stray] }),
    ]) {
      expect(assessClosure(input)).toMatchObject({
        closed: false,
        reason: "uncommitted-resource-loaded",
      });
    }
  });

  it("fails either mode on a successful egress", () => {
    for (const input of [
      sealed({ egressAttempts: [{ target: "https://x.test", outcome: "succeeded" }] }),
      forkBacked({ egressAttempts: [{ target: "https://x.test", outcome: "succeeded" }] }),
    ]) {
      expect(assessClosure(input)).toMatchObject({ closed: false, reason: "egress-succeeded" });
    }
  });
});
