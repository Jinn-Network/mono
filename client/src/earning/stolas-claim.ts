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

import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import type { PublicClient } from 'viem';
import type { WalletClient } from 'viem';
import type { ServiceState, ServiceStep, StakingMode } from './types.js';
import { STOLAS_DISTRIBUTOR_ABI } from './contracts.js';
import { JINN_STAKING_ABI } from './jinn-rewards.js';
import {
  isRecoverableTransactionError,
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
} from '../tx-retry.js';
import { TransientError } from '../types/errors.js';
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
  /** Services where pending reward was non-zero and a claim tx was attempted (send path). */
  claimAttempted: number;
  failedRecoverable: number;
  /** Non-recoverable send errors, bad/missing receipts, etc. */
  failedPermanent: number;
  claims: Array<{
    serviceId: number;
    stakingProxy: string;
    txHash: string;
    amountWei: string;
  }>;
}

/**
 * Injectable retry-function dependencies for {@link tickStolasDistributorClaims}.
 * Defaults to the production implementations from `tx-retry.ts`.
 */
export interface StolasClaimRetryDeps {
  sendTx: typeof viemSendTransactionWithRetry;
  waitForReceipt: typeof waitForTransactionReceiptWithRetry;
}

/**
 * For each fleet service with pending staking rewards, submit distributor.claim([proxy],[id]).
 * Errors on individual services are logged and swallowed so the daemon loop stays healthy.
 */
export async function tickStolasDistributorClaims(
  publicClient: PublicClient,
  masterWallet: WalletClient,
  options: {
    distributorAddress: string | undefined;
    stakingMode: StakingMode;
    targets: StolasClaimTarget[];
    /**
     * When true (CLI), all claim sends failing recoverably surfaces {@link TransientError};
     * any permanent/receipt failure surfaces a normal Error. Daemon callers omit this.
     */
    strict?: boolean;
    /** Injectable retry deps — defaults to production implementations. */
    retryDeps?: StolasClaimRetryDeps;
  },
): Promise<StolasClaimTickResult> {
  const { sendTx = viemSendTransactionWithRetry, waitForReceipt = waitForTransactionReceiptWithRetry } =
    options.retryDeps ?? {};

  const result: StolasClaimTickResult = {
    attempted: 0,
    submitted: 0,
    skippedNoPending: 0,
    skippedNoDistributor: false,
    skippedWrongMode: false,
    claimAttempted: 0,
    failedRecoverable: 0,
    failedPermanent: 0,
    claims: [],
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

  for (const { stakingProxy, serviceId } of options.targets) {
    result.attempted += 1;
    try {
      const pending = await publicClient.readContract({
        address: getAddress(stakingProxy) as Address,
        abi: JINN_STAKING_ABI,
        functionName: 'calculateStakingReward',
        args: [BigInt(serviceId)],
      });
      if (pending === 0n) {
        result.skippedNoPending += 1;
        continue;
      }

      result.claimAttempted += 1;
      const data = encodeFunctionData({
        abi: STOLAS_DISTRIBUTOR_ABI,
        functionName: 'claim',
        args: [[getAddress(stakingProxy) as Address], [BigInt(serviceId)]],
      }) as Hex;
      const txHash = await sendTx(masterWallet, publicClient, {
        account: masterWallet.account!,
        to: getAddress(distributor) as Address,
        data,
        gas: 1_200_000n,
      });
      const receipt = await waitForReceipt(publicClient, txHash as Hex);
      if (receipt.status !== 'success') {
        result.failedPermanent += 1;
        console.error(
          `[reward-claim] claim tx failed for service ${serviceId} (hash=${txHash})`,
        );
        continue;
      }
      result.submitted += 1;
      result.claims.push({
        serviceId,
        stakingProxy: getAddress(stakingProxy),
        txHash: String(txHash),
        amountWei: pending.toString(),
      });
      console.log(
        `[reward-claim] Submitted distributor.claim for service ${serviceId} (~${pending.toString()} wei pending before tx)`,
      );
    } catch (err) {
      if (isRecoverableTransactionError(err)) {
        result.failedRecoverable += 1;
      } else {
        result.failedPermanent += 1;
      }
      console.error(
        `[reward-claim] Skipped service ${serviceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (options.strict) {
    const totalFailed = result.failedRecoverable + result.failedPermanent;
    if (result.submitted === 0 && totalFailed > 0 && result.failedPermanent === 0) {
      throw new TransientError(
        `Distributor claim: all ${totalFailed} failed service check(s) / claim attempt(s) hit recoverable errors.`,
      );
    }
    if (result.submitted === 0 && result.failedPermanent > 0) {
      throw new Error(
        `Distributor claim: all ${totalFailed} failed service check(s) / claim attempt(s) were non-recoverable or had bad receipts.`,
      );
    }
  }

  return result;
}
