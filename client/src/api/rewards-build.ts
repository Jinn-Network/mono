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
  const firstStakedIdx = list.findIndex(s => STAKED_LIKE_STEPS.has(s.step));
  const rewardIdx = firstStakedIdx >= 0 ? firstStakedIdx : 0;

  const services = list.map((svc, i) => {
    const stakedLike = STAKED_LIKE_STEPS.has(svc.step);
    const pending =
      firstStakedIdx < 0
        ? i === 0
          ? total
          : '0'
        : stakedLike && i === rewardIdx
          ? total
          : '0';
    return {
      index: displayFleetServiceIndex(svc),
      pending,
      claimed: '0',
      asset: 'reward' as const,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    lastClaimAt: raw.lastRewardClaimTickAt,
    nextCheckpointAt: null,
    services,
  };
}
