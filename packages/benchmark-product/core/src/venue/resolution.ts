/**
 * SAMPLE-RESOLUTION DATA.
 *
 * The bundled sample benchmark (`../intake/sample.ts`) has no real prediction market behind it —
 * its forecast payloads are fixed literals derived from the platform's golden fixture (spec
 * `docs/superpowers/plans/2026-08-05-benchmark-product-m1-composition-dossier.md` decision 2).
 * For the sample to grade deterministically end to end, the evaluation cell needs a resolution
 * snapshot, a market identity, and a submission window — none of which a real venue would need to
 * invent, because a real venue reads them from an actual market. This module is that deterministic
 * stand-in: every value below is a pure function of the sample Task's own `payload.forecast`, never
 * a real market outcome. It exists solely so the quickstart's evaluation cell has something to
 * grade against; it must never be mistaken for a real resolution source.
 *
 * The derivation: the sample "resolves" YES when the posted consensus was itself >= 0.5 — i.e. the
 * consensus is treated as its own ground truth. This makes the platform's `prediction-v1-baseline`
 * launcher (which echoes the consensus verbatim) score a perfect Brier loss of 0 by construction,
 * which is expected and fine for a quickstart: the interesting comparison is against the bundled
 * `sample-uniform` launcher's fixed 0.5 guess, not against the baseline.
 */

import { createHash } from "node:crypto";

const PROBABILITY = /^(0(\.\d+)?|1(\.0+)?)$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export interface SampleForecastPayload {
  readonly marketId: string;
  readonly question: string;
  readonly consensusProbabilityYes: string;
  readonly observedAt: string;
  readonly resolvesAt: string;
}

export interface SampleResolution {
  readonly resolutionSnapshot: {
    readonly status: "resolved";
    readonly outcome: "YES" | "NO";
    readonly marketId: string;
    readonly conditionId: string;
  };
  readonly market: { readonly marketId: string; readonly conditionId: string };
  readonly window: { readonly startTs: number; readonly endTs: number };
  readonly consensusProbabilityYes: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check for a sample Task's `payload.forecast` — the same shape the golden
 * prediction-forecast fixture (and every sample variation derived from it) carries. */
export function isSampleForecastPayload(value: unknown): value is SampleForecastPayload {
  if (!isObject(value)) return false;
  return typeof value.marketId === "string" && value.marketId.length > 0
    && typeof value.question === "string" && value.question.length > 0
    && typeof value.consensusProbabilityYes === "string" && PROBABILITY.test(value.consensusProbabilityYes)
    && typeof value.observedAt === "string" && UTC.test(value.observedAt) && !Number.isNaN(Date.parse(value.observedAt))
    && typeof value.resolvesAt === "string" && UTC.test(value.resolvesAt) && !Number.isNaN(Date.parse(value.resolvesAt));
}

/** Derives a deterministic condition id from a market id — stable across runs, never random. */
function conditionIdFor(marketId: string): string {
  const digest = createHash("sha256").update(marketId, "utf8").digest("hex");
  return `sample-condition-${digest.slice(0, 16)}`;
}

/**
 * Derives the sample evaluation context deterministically from `payload.forecast`. The window is
 * `[observedAt, resolvesAt]` — inclusive at both ends, matching the prediction evaluator's own
 * inclusive window check (`@jinn-network/task-execution-evaluator-adapters`'s
 * `parsePredictionResult`), which is required because the solver's `submittedAt` is always set to
 * exactly `observedAt` (both `prediction-v1-baseline` and the bundled `sample-uniform` launcher
 * stamp the submission at the task's own `observedAt`, never a wall clock).
 */
export function deriveSampleResolution(forecast: SampleForecastPayload): SampleResolution {
  const conditionId = conditionIdFor(forecast.marketId);
  const outcome: "YES" | "NO" = Number(forecast.consensusProbabilityYes) >= 0.5 ? "YES" : "NO";
  return {
    resolutionSnapshot: {
      status: "resolved",
      outcome,
      marketId: forecast.marketId,
      conditionId,
    },
    market: { marketId: forecast.marketId, conditionId },
    window: {
      startTs: Date.parse(forecast.observedAt),
      endTs: Date.parse(forecast.resolvesAt),
    },
    consensusProbabilityYes: forecast.consensusProbabilityYes,
  };
}
