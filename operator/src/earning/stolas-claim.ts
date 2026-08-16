/**
 * Staking reward claims for fleet services.
 *
 * Two paths depending on staking_mode:
 *
 * standard — delegates to the stOLAS ExternalStakingDistributor.
 *   The distributor's claim() calls checkpointAndClaim on each staking proxy;
 *   the OLAS-style staking implementation reverts on zero reward, so we read
 *   calculateStakingReward first and skip sends when pending is zero (no revert
 *   loop).
 *
 * self-bond — rewards are owned by the service Safe (not the distributor).
 *   The operator must call staking.checkpointAndClaim(serviceId) directly from
 *   the Safe. This path builds and submits a Safe transaction via
 *   executeSafeTxDirect, signed by the agent EOA (1-of-1 Safe owner).
 */

import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import type { PublicClient } from 'viem';
import type { WalletClient } from 'viem';
import type { ServiceState, ServiceStep, StakingMode } from './types.js';
import { STOLAS_DISTRIBUTOR_ABI } from './contracts.js';
import { JINN_STAKING_ABI } from './stolas-staking.js';
import { executeSafeTxDirect } from './safe-adapter.js';
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
  'agent_registered',
  'safe_binding_pending',
  'complete',
]);

export interface StolasClaimTarget {
  stakingProxy: string;
  serviceId: number;
  /**
   * Required for self-bond claims: the service Safe address that owns the
   * staking position and will receive the reward.
   */
  safeAddress?: string;
  /**
   * Required for self-bond claims: the agent EOA private key (1-of-1 Safe
   * owner) that signs and submits the Safe transaction.
   */
  agentPrivateKey?: Hex;
  /** RPC URL forwarded from the fleet config for self-bond Safe execution. */
  rpcUrl?: string;
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
        console.debug(
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
        `[reward-claim] Submitted distributor.claim for service ${serviceId} ` +
        `(~${pending.toString()} wei pre-split — operator share is the curating-agent ` +
        `slot per stOLAS proxy config; collector/protocol route separately)`,
      );
    } catch (err) {
      if (isRecoverableTransactionError(err)) {
        result.failedRecoverable += 1;
      } else {
        result.failedPermanent += 1;
      }
      console.debug(
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

// ---------------------------------------------------------------------------
// Self-bond staking claim (staking_mode: 'self-bond')
// ---------------------------------------------------------------------------

export interface SelfBondClaimTickResult {
  attempted: number;
  submitted: number;
  skippedNoPending: number;
  skippedWrongMode: boolean;
  /** Services skipped due to missing safeAddress / agentPrivateKey / rpcUrl. */
  skippedMissingConfig: number;
  claimAttempted: number;
  failedRecoverable: number;
  failedPermanent: number;
  claims: Array<{
    serviceId: number;
    stakingProxy: string;
    txHash: string;
    amountWei: string;
  }>;
}

/**
 * Injectable Safe execution dependency for {@link tickSelfBondStakingClaims}.
 * Defaults to the production {@link executeSafeTxDirect} helper.
 */
export interface SelfBondClaimDeps {
  executeSafeTx: typeof executeSafeTxDirect;
  waitForReceipt: typeof waitForTransactionReceiptWithRetry;
}

/**
 * For each self-bond service with pending staking rewards, submit
 * staking.checkpointAndClaim(serviceId) from the service Safe via
 * executeSafeTxDirect.
 *
 * In self-bond mode rewards accrue directly to the service Safe (no
 * distributor intermediary). The caller must populate each target's
 * `safeAddress`, `agentPrivateKey`, and `rpcUrl` fields.
 *
 * Errors on individual services are logged and swallowed so the daemon loop
 * stays healthy.
 */
export async function tickSelfBondStakingClaims(
  publicClient: PublicClient,
  options: {
    stakingMode: StakingMode;
    targets: StolasClaimTarget[];
    /**
     * When true (CLI), all claim sends failing recoverably surfaces
     * {@link TransientError}; any permanent failure surfaces a normal Error.
     * Daemon callers omit this.
     */
    strict?: boolean;
    /** Injectable deps — defaults to production implementations. */
    deps?: SelfBondClaimDeps;
  },
): Promise<SelfBondClaimTickResult> {
  const {
    executeSafeTx = executeSafeTxDirect,
    waitForReceipt = waitForTransactionReceiptWithRetry,
  } = options.deps ?? {};

  const result: SelfBondClaimTickResult = {
    attempted: 0,
    submitted: 0,
    skippedNoPending: 0,
    skippedWrongMode: false,
    skippedMissingConfig: 0,
    claimAttempted: 0,
    failedRecoverable: 0,
    failedPermanent: 0,
    claims: [],
  };

  if (options.stakingMode !== 'self-bond') {
    result.skippedWrongMode = true;
    return result;
  }

  for (const target of options.targets) {
    const { stakingProxy, serviceId, safeAddress, agentPrivateKey, rpcUrl } = target;
    result.attempted += 1;

    if (!safeAddress || !agentPrivateKey || !rpcUrl) {
      result.skippedMissingConfig += 1;
      console.debug(
        `[reward-claim] Self-bond: service ${serviceId} skipped — missing safeAddress, agentPrivateKey, or rpcUrl on claim target.`,
      );
      continue;
    }

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

      // Build checkpointAndClaim(serviceId) calldata — the staking contract
      // gates normal claim() with a checkpoint requirement on OLAS-style
      // staking proxies; checkpointAndClaim is safe to call in either case.
      const data = encodeFunctionData({
        abi: JINN_STAKING_ABI,
        functionName: 'checkpointAndClaim',
        args: [BigInt(serviceId)],
      }) as Hex;

      const { hash: txHash } = await executeSafeTx({
        rpcUrl,
        signerKey: agentPrivateKey,
        safeAddress,
        to: getAddress(stakingProxy),
        value: 0n,
        data,
        gasLimit: 500_000n,
      });

      const receipt = await waitForReceipt(publicClient, txHash as Hex);
      if (receipt.status !== 'success') {
        result.failedPermanent += 1;
        console.debug(
          `[reward-claim] Self-bond claim tx failed for service ${serviceId} (hash=${txHash})`,
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
        `[reward-claim] Self-bond: submitted checkpointAndClaim for service ${serviceId} via Safe ${safeAddress} (~${pending.toString()} wei pending before tx)`,
      );
    } catch (err) {
      if (isRecoverableTransactionError(err)) {
        result.failedRecoverable += 1;
      } else {
        result.failedPermanent += 1;
      }
      console.debug(
        `[reward-claim] Self-bond: skipped service ${serviceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (options.strict) {
    const totalFailed = result.failedRecoverable + result.failedPermanent;
    if (result.submitted === 0 && totalFailed > 0 && result.failedPermanent === 0) {
      throw new TransientError(
        `Self-bond claim: all ${totalFailed} failed service check(s) / claim attempt(s) hit recoverable errors.`,
      );
    }
    if (result.submitted === 0 && result.failedPermanent > 0) {
      throw new Error(
        `Self-bond claim: all ${totalFailed} failed service check(s) / claim attempt(s) were non-recoverable or had bad receipts.`,
      );
    }
  }

  return result;
}
