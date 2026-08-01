// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { PREDICTION_FIXTURES } from "./fixtures.js";
import { brierLoss, parsePredictionResult } from "./parse.js";

describe("parsePredictionResult", () => {
  test.each(PREDICTION_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    "%s reproduces the legacy outcome",
    (_name, fixture) => {
      const outcome = parsePredictionResult({
        resultBytes: fixture.resultBytes,
        snapshot: fixture.snapshot,
        market: fixture.market,
        window: fixture.window,
        consensusProbabilityYes: fixture.consensusProbabilityYes,
      });
      expect(outcome.verdict).toBe(fixture.expect.verdict);
      expect(outcome.integrity).toBe(fixture.expect.integrity);
      expect(outcome.resolved).toBe(fixture.expect.resolved);
      if (fixture.expect.solverBrier === undefined) {
        expect(outcome.scores).toBeUndefined();
      } else {
        expect(outcome.scores).toEqual({
          scoreBasis: "brier-loss.v1",
          solverBrier: fixture.expect.solverBrier,
          consensusBrier: fixture.expect.consensusBrier,
          brierSpread: fixture.expect.brierSpread,
        });
      }
    },
  );

  // NOTE: renamed from the plan's "result.schema"/"result.window" to the real legacy check
  // names "solution.schema"/"solution.window" (prediction-v1-evaluator/index.ts:111,123, per
  // Task 2 finding E4 and fixtures/prediction/README.md §The seven checks). This parser
  // implements 4 of the real 7 checks — see the divergence note atop parse.ts.
  test("every outcome reports all four checks", () => {
    for (const fixture of PREDICTION_FIXTURES) {
      const outcome = parsePredictionResult({
        resultBytes: fixture.resultBytes,
        snapshot: fixture.snapshot,
        market: fixture.market,
        window: fixture.window,
        consensusProbabilityYes: fixture.consensusProbabilityYes,
      });
      expect(outcome.checks.map((check) => check.name)).toEqual([
        "solution.schema",
        "solution.window",
        "market.identity",
        "market.resolution",
      ]);
    }
  });

  test("a failed integrity check is never laundered into inconclusive", () => {
    const outcome = parsePredictionResult({
      resultBytes: new Uint8Array(0),
      snapshot: {
        status: "unresolved",
        marketId: "0x5150",
        conditionId: "0xABCDEF",
        sourceUrl: "https://example.invalid/markets/0x5150",
      },
      market: { marketId: "0x5150", conditionId: "0xABCDEF" },
      window: { startTs: 0, endTs: 1 },
      consensusProbabilityYes: "0.500000",
    });
    expect(outcome.verdict).toBe("fail");
  });

  test("an unrecognizable resolution snapshot fails, never scores", () => {
    const outcome = parsePredictionResult({
      resultBytes: new TextEncoder().encode(JSON.stringify({
        probabilityYes: "0.500000",
        submittedAt: "2026-06-01T00:00:00.000Z",
        modelId: "model-a",
      })),
      snapshot: "not a snapshot",
      market: { marketId: "0x5150", conditionId: "0xABCDEF" },
      window: { startTs: 0, endTs: 4_102_444_800_000 },
      consensusProbabilityYes: "0.500000",
    });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.scores).toBeUndefined();
  });

  // Real venue status values beyond resolved/unresolved (client/src/venues/polymarket/client.ts:73,
  // per Task 2 finding E4 / Task 6 finding E12): a structurally valid snapshot reporting
  // invalid/cancelled/ambiguous must be read (not rejected as unreadable) and fail
  // market.resolution with the real status as detail.
  test.each(["invalid", "cancelled", "ambiguous"] as const)(
    "a structurally valid snapshot with status %s fails market.resolution, not the read itself",
    (status) => {
      const outcome = parsePredictionResult({
        resultBytes: new TextEncoder().encode(JSON.stringify({
          probabilityYes: "0.500000",
          submittedAt: "2026-06-01T00:00:00.000Z",
          modelId: "model-a",
        })),
        snapshot: {
          status,
          marketId: "0x5150",
          conditionId: "0xABCDEF",
          sourceUrl: "https://example.invalid/markets/0x5150",
        },
        market: { marketId: "0x5150", conditionId: "0xABCDEF" },
        window: { startTs: 0, endTs: 4_102_444_800_000 },
        consensusProbabilityYes: "0.500000",
      });
      const resolutionCheck = outcome.checks.find((check) => check.name === "market.resolution");
      expect(resolutionCheck?.status).toBe("fail");
      expect(resolutionCheck?.detail).toBe(`the venue reported ${status}`);
      expect(outcome.verdict).toBe("fail");
      expect(outcome.resolved).toBe(false);
    },
  );
});

describe("brierLoss", () => {
  test("is exact at the endpoints", () => {
    expect(brierLoss("1", 1)).toBe("0.000000");
    expect(brierLoss("0", 1)).toBe("1.000000");
  });

  test("rounds to six fraction digits as a decimal string", () => {
    expect(brierLoss("0.5", 1)).toBe("0.250000");
    expect(brierLoss("0.333333", 0)).toBe("0.111111");
  });
});
