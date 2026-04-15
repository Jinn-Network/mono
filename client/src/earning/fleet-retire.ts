/**
 * Retire one standard (distributor-managed) fleet service: distributor.unstakeAndWithdraw,
 * then drop the row from local fleet JSON.
 */

import { encodeFunctionData, getAddress, pad, type Address, type Hex } from 'viem';
import type { PublicClient } from 'viem';
import type { WalletClient } from 'viem';
import { STOLAS_DISTRIBUTOR_ABI } from './contracts.js';
import type { FleetStateStore } from './store.js';
import type { FleetState, ServiceState, StakingMode } from './types.js';
import {
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
} from '../tx-retry.js';

export interface RetireFleetServiceParams {
  publicClient: PublicClient;
  masterWallet: WalletClient;
  distributorAddress: string | undefined;
  fleetStore: FleetStateStore;
  chain: 'base' | 'base-sepolia';
  serviceIndex: number;
}

export interface RetireFleetServiceResult {
  ok: boolean;
  txHash?: string;
  message: string;
}

/**
 * Unstake + terminate + unbond via ExternalStakingDistributor, then remove the service from disk.
 * Self-bond mode is not supported here (return ok: false).
 */
export async function retireFleetServiceOnChain(
  params: RetireFleetServiceParams,
): Promise<RetireFleetServiceResult> {
  const { publicClient, masterWallet, distributorAddress, fleetStore, chain, serviceIndex } = params;
  const state: FleetState = await fleetStore.load(chain);
  const stakingMode: StakingMode = state.staking_mode;
  if (stakingMode !== 'standard') {
    return {
      ok: false,
      message: `fleet retire is only implemented for staking_mode=standard (got ${stakingMode}).`,
    };
  }
  if (!distributorAddress) {
    return {
      ok: false,
      message: 'No distributor address in chain config; cannot call unstakeAndWithdraw.',
    };
  }

  const svc = state.services.find(s => s.index === serviceIndex);
  if (!svc) {
    return { ok: true, message: `Service index ${serviceIndex} not in fleet state (already removed).` };
  }

  if (svc.service_id === null || !svc.staking_address) {
    return {
      ok: false,
      message: `Service ${serviceIndex} is missing service_id or staking_address; cannot retire on-chain.`,
    };
  }

  const stakingProxy = getAddress(svc.staking_address) as Address;
  const operation = pad(stakingProxy as Hex, { size: 32 });
  const data = encodeFunctionData({
    abi: STOLAS_DISTRIBUTOR_ABI,
    functionName: 'unstakeAndWithdraw',
    args: [stakingProxy, BigInt(svc.service_id), operation],
  }) as Hex;

  try {
    const txHash = await viemSendTransactionWithRetry(masterWallet, publicClient, {
      account: masterWallet.account!,
      to: getAddress(distributorAddress) as Address,
      data,
      gas: 2_500_000n,
    });
    const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash as Hex);
    if (receipt.status !== 'success') {
      return {
        ok: false,
        message: `unstakeAndWithdraw tx failed or timed out (hash=${txHash}).`,
      };
    }
    await fleetStore.removeService(serviceIndex);
    return {
      ok: true,
      txHash,
      message: `Retired service ${serviceIndex} (service_id=${svc.service_id}).`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}

/** Read-only: whether the service row exists in fleet JSON. */
export function findFleetService(state: FleetState, serviceIndex: number): ServiceState | undefined {
  return state.services.find(s => s.index === serviceIndex);
}
