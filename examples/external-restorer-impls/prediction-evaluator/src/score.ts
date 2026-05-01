/**
 * Brier scoring + calibration decomposition.
 *
 * `brier(p, outcome)` is the squared error of a probabilistic forecast.
 * `decomposeBrier(forecasts)` implements Murphy 1973's three-component
 * decomposition:
 *
 *   meanBrier = reliability - resolution + uncertainty
 *
 * - **reliability** — calibration error; lower is better.
 * - **resolution** — how strongly the forecaster discriminates above
 *   base rate; higher is better.
 * - **uncertainty** — variance of the outcome itself; not under the
 *   forecaster's control.
 *
 * We bin forecasts into 10 buckets by predicted probability.
 */

export function brier(p: number, outcome: 0 | 1): number {
  return (p - outcome) ** 2;
}

export interface ScoredForecast {
  p: number;
  outcome: 0 | 1;
}

export interface BrierDecomposition {
  reliability: number;
  resolution: number;
  uncertainty: number;
}

export function decomposeBrier(
  forecasts: readonly ScoredForecast[],
): BrierDecomposition {
  if (forecasts.length === 0) {
    return { reliability: 0, resolution: 0, uncertainty: 0 };
  }

  const baseRate =
    forecasts.reduce((s, f) => s + f.outcome, 0) / forecasts.length;
  const uncertainty = baseRate * (1 - baseRate);

  const buckets = new Map<number, ScoredForecast[]>();
  for (const f of forecasts) {
    const bin = Math.min(9, Math.floor(f.p * 10));
    const list = buckets.get(bin);
    if (list) list.push(f);
    else buckets.set(bin, [f]);
  }

  let reliability = 0;
  let resolution = 0;
  for (const group of buckets.values()) {
    const n = group.length;
    const meanP = group.reduce((s, f) => s + f.p, 0) / n;
    const observedRate = group.reduce((s, f) => s + f.outcome, 0) / n;
    reliability += (n / forecasts.length) * (meanP - observedRate) ** 2;
    resolution += (n / forecasts.length) * (observedRate - baseRate) ** 2;
  }
  return { reliability, resolution, uncertainty };
}
