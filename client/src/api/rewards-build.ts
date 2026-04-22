/**
 * Rewards response assembler.
 *
 * Contract: spec/2026-04-14-client-surface.md §2.2 (rewards verb).
 */

import type { GatheredStatusRaw } from './status-build.js';
import type { ServiceState } from '../earning/types.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';

const STAKED_LIKE_STEPS = new Set([
  'staked',
  'mech_deployed',
  'complete',
  'service_staked',
]);

export interface RewardsV1ServiceEntry {
  index: number;
  pending: string;
  claimed: string;
  asset: 'reward';
}

export interface RewardsV1Response {
  schemaVersion: 1;
  generatedAt: string;
  lastClaimAt: string | null;
  nextCheckpointAt: string | null;
  services: RewardsV1ServiceEntry[];
}

export function assembleRewardsV1(raw: GatheredStatusRaw): RewardsV1Response {
  const total = raw.pendingStakingRewardsWei ?? '0';
  const list = raw.fleet?.services ?? [];
  const pendingByService = raw.pendingByService ?? {};
  const claimedByService = raw.claimedByService ?? {};
  const pendingByKeys = Object.keys(pendingByService);
  let legacyPendingIndex: number | null = null;
  if (pendingByKeys.length === 0 && list.length > 0) {
    try {
      if (total !== '0' && BigInt(total) > 0n) {
        const s = list.find(svc => STAKED_LIKE_STEPS.has(svc.step)) ?? list[0];
        if (s) legacyPendingIndex = displayFleetServiceIndex(s);
      }
    } catch {
      /* ignore */
    }
  }

  const services = list.map((svc) => {
    const index = displayFleetServiceIndex(svc);
    const stakedLike = STAKED_LIKE_STEPS.has(svc.step);
    const claimed = claimedByService[index]?.total ?? '0';
    return {
      index,
      pending: stakedLike
        ? (pendingByService[index] ??
            (list.length === 1
              ? total
              : legacyPendingIndex === index
                ? total
                : '0'))
        : '0',
      claimed,
      asset: 'reward' as const,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    lastClaimAt: raw.lastRewardClaimTickAt,
    nextCheckpointAt: raw.nextCheckpointAt ?? null,
    services,
  };
}
