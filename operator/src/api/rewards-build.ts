/**
 * Rewards response assembler.
 *
 * Contract: spec/2026-04-14-client-surface.md §2.2 (rewards verb).
 */

import type { GatheredStatusRaw } from './status-build.js';
import { isStakedLikeServiceStep, type ServiceState } from '../earning/types.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';

export interface RewardsV1ServiceEntry {
  index: number;
  pending: string;
  claimed: string;
  asset: 'OLAS';
  lastClaimAt: string | null;
  lastClaimTxHash: string | null;
}

export interface RewardsV1Response {
  schemaVersion: 1;
  generatedAt: string;
  readState: 'ready' | 'error';
  totalPending: string;
  totalClaimed: string;
  lastClaimAt: string | null;
  lastClaimTickAt: string | null;
  nextCheckpointAt: string | null;
  error?: string;
  services: RewardsV1ServiceEntry[];
}

function addWei(a: string, b: string): string {
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return a;
  }
}

function latestClaim(
  claimedByService: Record<number, { total: string; lastAt: string; lastTxHash: string }>,
): string | null {
  let latest: string | null = null;
  for (const row of Object.values(claimedByService)) {
    if (!latest || row.lastAt > latest) latest = row.lastAt;
  }
  return latest;
}

export function assembleRewardsV1(raw: GatheredStatusRaw): RewardsV1Response {
  const readState = raw.pendingStakingRewardsError ? 'error' : 'ready';
  const total = readState === 'ready' ? (raw.pendingStakingRewardsWei ?? '0') : '0';
  const list = raw.fleet?.services ?? [];
  const pendingByService = raw.pendingByService ?? {};
  const claimedByService = raw.claimedByService ?? {};
  const pendingByKeys = Object.keys(pendingByService);
  let legacyPendingIndex: number | null = null;
  if (pendingByKeys.length === 0 && list.length > 0) {
    try {
      if (total !== '0' && BigInt(total) > 0n) {
        const s = list.find(svc => isStakedLikeServiceStep(svc.step)) ?? list[0];
        if (s) legacyPendingIndex = displayFleetServiceIndex(s);
      }
    } catch {
      /* ignore */
    }
  }

  let totalClaimed = '0';
  const services = list.map((svc) => {
    const index = displayFleetServiceIndex(svc);
    const stakedLike = isStakedLikeServiceStep(svc.step);
    const claim = claimedByService[index];
    const claimed = claim?.total ?? '0';
    totalClaimed = addWei(totalClaimed, claimed);
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
      asset: 'OLAS' as const,
      lastClaimAt: claim?.lastAt ?? null,
      lastClaimTxHash: claim?.lastTxHash ?? null,
    };
  });

  const lastClaimAt = latestClaim(claimedByService);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readState,
    totalPending: total,
    totalClaimed,
    lastClaimAt,
    lastClaimTickAt: raw.lastRewardClaimTickAt,
    nextCheckpointAt: raw.nextCheckpointAt ?? null,
    ...(raw.pendingStakingRewardsError ? { error: raw.pendingStakingRewardsError } : {}),
    services,
  };
}
