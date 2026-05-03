/**
 * Availability checks for prediction.v1.
 *
 * §6.7 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
import type { Check } from '../types.js';
import type { SpanningResult } from '../../../../venues/chainlink/client.js';

export async function checkOracleReachable<T>(
  fetch: () => Promise<T>,
): Promise<Check> {
  try {
    await fetch();
    return { name: 'availability.oracle_reachable', status: 'PASS' };
  } catch (err) {
    return {
      name: 'availability.oracle_reachable',
      status: 'FAIL',
      detail: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export function checkOracleRoundCoversResolveTs(
  result: Pick<SpanningResult, 'spanning'>,
): Check {
  return {
    name: 'availability.oracle_round_covers_resolve_ts',
    status: result.spanning ? 'PASS' : 'SKIP',
    detail: result.spanning
      ? undefined
      : 'No Chainlink round with updatedAt > resolveTs yet; retry later.',
  };
}
