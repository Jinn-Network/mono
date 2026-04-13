/**
 * stOLAS ExternalStakingDistributor reward claims for fleet services.
 *
 * The distributor's claim() calls checkpointAndClaim on each staking proxy; the OLAS-style
 * staking implementation reverts on zero reward, so we read calculateStakingReward first and
 * skip sends when pending is zero (no revert loop).
 *
 * TODO(self-bond): rewards are owned by the service Safe; wire Safe-batched staking.claim /
 * checkpointAndClaim when staking_mode is self-bond (not distributor-mediated).
 */

import { Contract, Interface, type JsonRpcProvider, type Signer } from 'ethers';
import type { ServiceState, ServiceStep, StakingMode } from './types.js';
import { STOLAS_DISTRIBUTOR_ABI } from './contracts.js';
import { JINN_STAKING_ABI } from './jinn-rewards.js';
import {
  ethersSendTransactionWithRetry,
  ethersWaitForTransactionHashWithRetry,
} from '../tx-retry.js';

/** Steps where the service is staked and may accrue staking rewards. */
const STEPS_WITH_STAKING_REWARDS: ReadonlySet<ServiceStep> = new Set([
  'staked',
  'mech_deployed',
  'complete',
]);

export interface StolasClaimTarget {
  stakingProxy: string;
  serviceId: number;
}

/**
 * Services that may need distributor.claim (pure filter for tests and tick).
 */
export function listStolasClaimTargets(services: ServiceState[]): StolasClaimTarget[] {
  const out: StolasClaimTarget[] = [];
  for (const s of services) {
    if (!STEPS_WITH_STAKING_REWARDS.has(s.step)) continue;
    if (s.service_id === null || s.staking_address === null) continue;
    out.push({ stakingProxy: s.staking_address, serviceId: s.service_id });
  }
  return out;
}

export interface StolasClaimTickResult {
  attempted: number;
  submitted: number;
  skippedNoPending: number;
  skippedNoDistributor: boolean;
  skippedWrongMode: boolean;
}

/**
 * For each fleet service with pending staking rewards, submit distributor.claim([proxy],[id]).
 * Errors on individual services are logged and swallowed so the daemon loop stays healthy.
 */
export async function tickStolasDistributorClaims(
  provider: JsonRpcProvider,
  masterSigner: Signer,
  options: {
    distributorAddress: string | undefined;
    stakingMode: StakingMode;
    targets: StolasClaimTarget[];
  },
): Promise<StolasClaimTickResult> {
  const result: StolasClaimTickResult = {
    attempted: 0,
    submitted: 0,
    skippedNoPending: 0,
    skippedNoDistributor: false,
    skippedWrongMode: false,
  };

  if (options.stakingMode !== 'standard') {
    result.skippedWrongMode = true;
    return result;
  }

  const distributor = options.distributorAddress;
  if (!distributor) {
    result.skippedNoDistributor = true;
    return result;
  }

  const distributorIface = new Interface(STOLAS_DISTRIBUTOR_ABI);

  for (const { stakingProxy, serviceId } of options.targets) {
    result.attempted += 1;
    try {
      const stakingRead = new Contract(stakingProxy, JINN_STAKING_ABI, provider);
      const pending: bigint = await stakingRead.calculateStakingReward(serviceId);
      if (pending === 0n) {
        result.skippedNoPending += 1;
        continue;
      }

      const data = distributorIface.encodeFunctionData('claim', [[stakingProxy], [BigInt(serviceId)]]);
      const txResponse = await ethersSendTransactionWithRetry(masterSigner, {
        to: distributor,
        data,
        gasLimit: 1_200_000n,
      });
      const receipt = await ethersWaitForTransactionHashWithRetry(
        provider,
        (txResponse as { hash: string }).hash,
        1,
        30000,
      );
      if (!receipt || receipt.status !== 1) {
        console.error(
          `[reward-claim] claim tx failed for service ${serviceId} (hash=${(txResponse as { hash: string }).hash})`,
        );
        continue;
      }
      result.submitted += 1;
      console.log(
        `[reward-claim] Submitted distributor.claim for service ${serviceId} (~${pending.toString()} wei pending before tx)`,
      );
    } catch (err) {
      console.error(
        `[reward-claim] Skipped service ${serviceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return result;
}
