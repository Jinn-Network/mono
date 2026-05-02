/**
 * @jinn-examples/prediction-evaluator — Path 2 worked example.
 *
 * Custom-scoring evaluator for `prediction.v0`. Given a forecaster's
 * output (`forecastProbability`) and the resolved outcome from the
 * oracle, emits a Brier score + the calibration decomposition as
 * informational data.
 *
 * Real builders swap `oracle-stub.ts` for a live oracle and (optionally)
 * accumulate forecasts for `decomposeBrier` over a longer window.
 */

import type {
  Harness,
  ExternalHarnessEnv,
  HarnessContext,
  Solution,
} from '@jinn-network/sdk/harness';
import { brier } from './score.js';
import { fetchResolution } from './oracle-stub.js';

interface PredictionEnvelopeUnderEvaluation {
  forecastProbability: number;
  predictedOutcome?: 0 | 1;
}

export default function createEvaluator(
  env: ExternalHarnessEnv,
): Harness {
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ solverType, role }) {
      return solverType === 'prediction.v0' && role === 'evaluation';
    },
    async isReady() {
      return env.stub
        ? { ready: false, reason: 'stub mode' }
        : { ready: true };
    },
    async run(ctx: HarnessContext): Promise<Solution> {
      const restoration = (ctx.task.spec as Record<string, unknown> | undefined)
        ?.restorationUnderEvaluation as
        | PredictionEnvelopeUnderEvaluation
        | undefined;
      if (!restoration || typeof restoration.forecastProbability !== 'number') {
        env.log({ level: 'error', msg: 'evaluator.no-restoration' });
        return {
          venueRef: { name: env.implName },
          gating: {
            score: null,
            scoringRule: 'brier.v1',
            error: 'missing restoration to score',
          },
          verdictPayload: {
            score: null,
            scoringRule: 'brier.v1',
            error: 'missing restoration',
          },
        };
      }
      const oracle = await fetchResolution(ctx.task.id);
      const score = brier(
        restoration.forecastProbability,
        oracle.resolvedOutcome,
      );
      env.log({
        level: 'info',
        msg: 'evaluator.scored',
        data: {
          taskId: ctx.task.id,
          score,
          outcome: oracle.resolvedOutcome,
        },
      });
      return {
        venueRef: { name: env.implName },
        gating: {
          score,
          scoringRule: 'brier.v1',
          resolvedOutcome: oracle.resolvedOutcome,
        },
        verdictPayload: {
          score,
          scoringRule: 'brier.v1',
          resolvedOutcome: oracle.resolvedOutcome,
          resolvedAt: oracle.resolvedAt,
        },
        informational: {
          forecastProbability: restoration.forecastProbability,
        },
      };
    },
  };
}

export { brier, decomposeBrier } from './score.js';
export type { ScoredForecast, BrierDecomposition } from './score.js';
