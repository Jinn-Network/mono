/**
 * @jinn-examples/polymarket-forecaster — Path 2 worked example.
 *
 * Wraps a Polymarket-style price fetch into a Jinn restorer impl for
 * `prediction.v0`. Real builders swap `polymarket-client.ts` for the
 * live API + their own calibration model.
 */

import type {
  RestorerImpl,
  ExternalRestorerEnv,
  RestorationContext,
  RestorationOutput,
} from '@jinn-network/restorer-sdk';
import { fetchMarketSnapshot } from './polymarket-client.js';

export default function createRestorer(
  env: ExternalRestorerEnv,
): RestorerImpl {
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ kind, type }) {
      return kind === 'prediction.v0' && type !== 'evaluation';
    },
    async isReady() {
      return env.stub
        ? { ready: false, reason: 'stub mode' }
        : { ready: true };
    },
    async run(ctx: RestorationContext): Promise<RestorationOutput> {
      const marketId =
        (ctx.intent.spec as { marketId?: string } | undefined)?.marketId ??
        ctx.intent.id;
      env.log({
        level: 'info',
        msg: 'polymarket-forecaster.fetch',
        data: { marketId },
      });
      const snapshot = await fetchMarketSnapshot(marketId);
      // Trivial baseline: clip the market price into (0.01, 0.99). Real
      // builders replace this with their forecasting pipeline.
      const probability = Math.max(
        0.01,
        Math.min(0.99, snapshot.yesPrice),
      );
      return {
        venueRef: { name: 'polymarket' },
        gating: {
          probability,
          marketId: snapshot.marketId,
          marketEndTime: snapshot.endTimeIso,
        },
        rationale: [
          {
            message: `Forecast based on market price ${snapshot.yesPrice}`,
          },
        ],
      };
    },
  };
}
