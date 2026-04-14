/**
 * Retire one standard (distributor-managed) fleet service: distributor.unstakeAndWithdraw,
 * then drop the row from local fleet JSON.
 */

import { Interface, JsonRpcProvider, getAddress, zeroPadValue } from 'ethers';
import type { Signer } from 'ethers';
import { STOLAS_DISTRIBUTOR_ABI } from './contracts.js';
import type { FleetStateStore } from './store.js';
import type { FleetState, ServiceState, StakingMode } from './types.js';
import {
  ethersSendTransactionWithRetry,
  ethersWaitForTransactionHashWithRetry,
} from '../tx-retry.js';

export interface RetireFleetServiceParams {
  provider: JsonRpcProvider;
  masterSigner: Signer;
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
  const { provider, masterSigner, distributorAddress, fleetStore, chain, serviceIndex } = params;
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

  const stakingProxy = getAddress(svc.staking_address);
  const iface = new Interface(STOLAS_DISTRIBUTOR_ABI);
  const operation = zeroPadValue(stakingProxy, 32);
  const data = iface.encodeFunctionData('unstakeAndWithdraw', [
    stakingProxy,
    BigInt(svc.service_id),
    operation,
  ]);

  try {
    const txResponse = await ethersSendTransactionWithRetry(masterSigner, {
      to: getAddress(distributorAddress),
      data,
      gasLimit: 2_500_000n,
    });
    const hash = (txResponse as { hash: string }).hash;
    const receipt = await ethersWaitForTransactionHashWithRetry(provider, hash, 1, 120_000);
    if (!receipt || receipt.status !== 1) {
      return {
        ok: false,
        message: `unstakeAndWithdraw tx failed or timed out (hash=${hash}).`,
      };
    }
    await fleetStore.removeService(serviceIndex);
    return {
      ok: true,
      txHash: hash,
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
