// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  EnvironmentVerificationPredicateSchema,
  type EnvironmentVerificationPredicate,
} from "./predicate.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

const CONTROLS = {
  network: "none",
  seeds: { PYTHONHASHSEED: "0" },
  order: "default",
  parallelism: 1,
  locale: "C.UTF-8",
  tz: "UTC",
} as const;

const VERIFIER = {
  id: "https://example.test/verifier",
  version: "0.1.0",
  digest: `sha256:${HEX_B}`,
} as const;

const WINDOW = {
  startedAt: "2026-07-31T09:00:00.000Z",
  endedAt: "2026-07-31T09:25:00.000Z",
} as const;

function stable(): EnvironmentVerificationPredicate {
  return {
    protocol: "https://spec.jinn.network/environment-verification/protocol/v1",
    result: "stable",
    window: WINDOW,
    runs: {
      count: 5,
      outcomeSetDigest: `sha256:${HEX_A}`,
      perRun: Array.from({ length: 5 }, () => ({
        outcomeSetDigest: `sha256:${HEX_A}`,
        wallSeconds: 292,
      })),
    },
    baseline: {
      passing: 412,
      failing: 3,
      skipped: 9,
      outcomes: { name: "outcomes", mediaType: "application/json", digest: { sha256: HEX_A } },
    },
    controls: CONTROLS,
    runtime: { minSeconds: 288, maxSeconds: 301, timeoutSeconds: 1800 },
    verifier: VERIFIER,
  } as EnvironmentVerificationPredicate;
}

describe("environment verification predicate", () => {
  it("accepts a well-formed stable predicate", () => {
    expect(EnvironmentVerificationPredicateSchema.safeParse(stable()).success).toBe(true);
  });

  it("refuses a stable result whose per-run digests diverge", () => {
    const predicate = stable();
    const perRun = [...predicate.runs!.perRun];
    perRun[2] = { outcomeSetDigest: `sha256:${HEX_B}`, wallSeconds: 300 };
    const result = EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      runs: { ...predicate.runs!, perRun },
    });
    expect(result.success).toBe(false);
  });

  it("refuses a stable result carrying a failure block", () => {
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...stable(),
      failure: { stage: "compare", reason: "outcome-set-divergence" },
    }).success).toBe(false);
  });

  it("requires runs and baseline exactly when result is not error", () => {
    const { runs: _runs, ...withoutRuns } = stable();
    expect(EnvironmentVerificationPredicateSchema.safeParse(withoutRuns).success).toBe(false);

    const errorPredicate = {
      protocol: "https://spec.jinn.network/environment-verification/protocol/v1",
      result: "error",
      window: WINDOW,
      controls: CONTROLS,
      runtime: { timeoutSeconds: 1800 },
      verifier: VERIFIER,
      failure: { stage: "acquire", reason: "image-unresolvable" },
    };
    expect(EnvironmentVerificationPredicateSchema.safeParse(errorPredicate).success).toBe(true);
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...errorPredicate,
      runs: stable().runs,
    }).success).toBe(false);
  });

  it("requires an unstable result to carry compare-stage divergence evidence", () => {
    const predicate = stable();
    const perRun = [...predicate.runs!.perRun];
    perRun[2] = { outcomeSetDigest: `sha256:${HEX_B}`, wallSeconds: 300 };
    const unstable = {
      ...predicate,
      result: "unstable" as const,
      runs: { ...predicate.runs!, perRun },
      failure: {
        stage: "compare" as const,
        reason: "outcome-set-divergence" as const,
        divergence: {
          referenceRunIndex: 0,
          referenceOutcomeSetDigest: `sha256:${HEX_A}`,
          divergentRuns: [{
            index: 2,
            outcomeSetDigest: `sha256:${HEX_B}`,
            outcomes: { name: "outcomes", digest: { sha256: HEX_B } },
          }],
        },
      },
    };
    expect(EnvironmentVerificationPredicateSchema.safeParse(unstable).success).toBe(true);
    const { divergence: _divergence, ...withoutDivergence } = unstable.failure;
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...unstable,
      failure: withoutDivergence,
    }).success).toBe(false);
  });

  it("refuses K below the profile minimum, omitted controls, and a bare-hex scalar", () => {
    const predicate = stable();
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      runs: { ...predicate.runs!, count: 4, perRun: predicate.runs!.perRun.slice(0, 4) },
    }).success).toBe(false);

    const { controls: _controls, ...withoutControls } = predicate;
    expect(EnvironmentVerificationPredicateSchema.safeParse(withoutControls).success).toBe(false);

    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      runs: { ...predicate.runs!, outcomeSetDigest: HEX_A },
    }).success).toBe(false);
  });

  it("binds the baseline descriptor to the canonical outcome-set digest", () => {
    const predicate = stable();
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      baseline: { ...predicate.baseline!, outcomes: { name: "outcomes", digest: { sha256: HEX_B } } },
    }).success).toBe(false);
  });

  it("refuses a window that ends before it starts and a non-UTC timestamp", () => {
    const predicate = stable();
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      window: { startedAt: WINDOW.endedAt, endedAt: WINDOW.startedAt },
    }).success).toBe(false);
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      window: { startedAt: "2026-07-31T09:00:00+02:00", endedAt: WINDOW.endedAt },
    }).success).toBe(false);
  });
});
