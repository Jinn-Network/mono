import type { Hono } from 'hono';
import type { Store } from '../store/store.js';
import {
  gatherGatheredStatusRaw,
  sumPendingStakingRewards,
  type StatusGatherConfig,
} from './gather-status.js';
import { getCachedGatheredStatus } from './gathered-status-cache.js';
import { assembleRewardsV1 } from './rewards-build.js';

export interface RewardsRoutesDeps {
  store: Store;
  getStatus: () => StatusGatherConfig | undefined;
  gatherRaw?: typeof gatherGatheredStatusRaw;
  sumPending?: typeof sumPendingStakingRewards;
  assemble?: typeof assembleRewardsV1;
}

export function addRewardsRoutes(app: Hono, deps: RewardsRoutesDeps): void {
  const sumPending = deps.sumPending ?? sumPendingStakingRewards;
  const assemble = deps.assemble ?? assembleRewardsV1;

  app.get('/v1/rewards', async (c) => {
    try {
      const status = deps.getStatus();
      // Share the ~3s TTL cache with /v1/status and /v1/notifications (issue #2408 review
      // finding F3) on the true production path. An explicit `gatherRaw` override (tests only)
      // always bypasses the cache so callers get deterministic per-call behavior.
      const raw = deps.gatherRaw
        ? await deps.gatherRaw(deps.store, status)
        : (await getCachedGatheredStatus(deps.store, status)).raw;

      if (status && raw.fleet) {
        if (raw.rpc.ok) {
          const pending = await sumPending(status.rpcUrl, status.network, raw.fleet);
          if ('sum' in pending) {
            raw.pendingStakingRewardsWei = pending.sum;
            raw.pendingByService = pending.pendingByService;
            if (pending.nextCheckpointAt) raw.nextCheckpointAt = pending.nextCheckpointAt;
          } else {
            raw.pendingStakingRewardsError = pending.error;
          }
        } else {
          raw.pendingStakingRewardsError = raw.rpc.error ?? 'RPC unavailable';
        }
      }

      return c.json(assemble(raw));
    } catch (err) {
      return c.json(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          readState: 'error',
          totalPending: '0',
          totalClaimed: '0',
          lastClaimAt: null,
          lastClaimTickAt: null,
          nextCheckpointAt: null,
          error: err instanceof Error ? err.message : String(err),
          services: [],
        },
        500,
      );
    }
  });
}
