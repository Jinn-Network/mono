import { describe, expect, it } from "vitest";
import { deriveSampleResolution, isSampleForecastPayload } from "./resolution.js";

describe("isSampleForecastPayload", () => {
  it("accepts a well-formed forecast payload", () => {
    expect(isSampleForecastPayload({
      marketId: "sample-market-alpha",
      question: "Will the alpha proposal pass?",
      consensusProbabilityYes: "0.640000",
      observedAt: "2026-01-01T00:00:00Z",
      resolvesAt: "2026-01-08T00:00:00Z",
    })).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(isSampleForecastPayload("not an object")).toBe(false);
    expect(isSampleForecastPayload(undefined)).toBe(false);
    expect(isSampleForecastPayload(null)).toBe(false);
  });

  it("rejects an out-of-range probability", () => {
    expect(isSampleForecastPayload({
      marketId: "m",
      question: "q",
      consensusProbabilityYes: "1.5",
      observedAt: "2026-01-01T00:00:00Z",
      resolvesAt: "2026-01-08T00:00:00Z",
    })).toBe(false);
  });

  it("rejects a non-UTC timestamp", () => {
    expect(isSampleForecastPayload({
      marketId: "m",
      question: "q",
      consensusProbabilityYes: "0.5",
      observedAt: "2026-01-01T00:00:00",
      resolvesAt: "2026-01-08T00:00:00Z",
    })).toBe(false);
  });
});

describe("deriveSampleResolution", () => {
  it("resolves YES when the consensus is >= 0.5", () => {
    const resolution = deriveSampleResolution({
      marketId: "sample-market-alpha",
      question: "Will the alpha proposal pass?",
      consensusProbabilityYes: "0.640000",
      observedAt: "2026-01-01T00:00:00Z",
      resolvesAt: "2026-01-08T00:00:00Z",
    });
    expect(resolution.resolutionSnapshot).toEqual({
      status: "resolved",
      outcome: "YES",
      marketId: "sample-market-alpha",
      conditionId: resolution.market.conditionId,
    });
    expect(resolution.market).toEqual({
      marketId: "sample-market-alpha",
      conditionId: resolution.market.conditionId,
    });
    expect(resolution.consensusProbabilityYes).toBe("0.640000");
    expect(resolution.window).toEqual({
      startTs: Date.parse("2026-01-01T00:00:00Z"),
      endTs: Date.parse("2026-01-08T00:00:00Z"),
    });
  });

  it("resolves NO when the consensus is below 0.5", () => {
    const resolution = deriveSampleResolution({
      marketId: "sample-market-bravo",
      question: "Will the bravo shipment arrive on time?",
      consensusProbabilityYes: "0.320000",
      observedAt: "2026-02-01T00:00:00Z",
      resolvesAt: "2026-02-15T00:00:00Z",
    });
    expect(resolution.resolutionSnapshot.outcome).toBe("NO");
  });

  it("is deterministic: the same market id always derives the same condition id", () => {
    const forecast = {
      marketId: "sample-market-charlie",
      question: "Will the charlie contract renew?",
      consensusProbabilityYes: "1.000000",
      observedAt: "2026-03-01T00:00:00Z",
      resolvesAt: "2026-03-10T00:00:00Z",
    };
    const first = deriveSampleResolution(forecast);
    const second = deriveSampleResolution(forecast);
    expect(first.market.conditionId).toBe(second.market.conditionId);
    expect(first.market.conditionId).toMatch(/^sample-condition-[0-9a-f]{16}$/);
  });

  it("places submittedAt (observedAt) inside the inclusive window", () => {
    const forecast = {
      marketId: "sample-market-alpha",
      question: "q",
      consensusProbabilityYes: "0.5",
      observedAt: "2026-01-01T00:00:00Z",
      resolvesAt: "2026-01-08T00:00:00Z",
    };
    const resolution = deriveSampleResolution(forecast);
    const submittedAt = Date.parse(forecast.observedAt);
    expect(submittedAt).toBeGreaterThanOrEqual(resolution.window.startTs);
    expect(submittedAt).toBeLessThanOrEqual(resolution.window.endTs);
  });
});
