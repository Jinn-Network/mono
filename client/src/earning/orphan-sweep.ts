/**
 * Best-effort recovery of ETH from a service Safe / agent EOA when bootstrap abandons
 * a persisted Safe (reconcile clear or stale standard-mode state).
 *
 * ERC-20 balances on the old Safe are not swept yet — see TODO below.
 */

import { Wallet, formatEther, getAddress, ZeroAddress } from 'ethers';
import type { HDNodeWallet, JsonRpcProvider } from 'ethers';
import { executeSafeTxDirect } from './safe-adapter.js';
import type { ServiceState } from './types.js';
import {
  ethersSendTransactionWithRetry,
  ethersWaitForTransactionHashWithRetry,
} from '../tx-retry.js';

function isZeroishAddress(addr: string | null | undefined): boolean {
  if (!addr) return true;
  try {
    return getAddress(addr) === getAddress(ZeroAddress);
  } catch {
    return true;
  }
}

/**
 * If reconcile (or similar) will drop or replace `safe_address`, return the on-chain
 * address that will no longer be tracked so we can sweep it first.
 */
export function previousSafeBeingAbandoned(
  svc: ServiceState,
  patch: Partial<ServiceState>,
): string | null {
  const prev = svc.safe_address;
  if (!prev || isZeroishAddress(prev)) return null;
  let prevNorm: string;
  try {
    prevNorm = getAddress(prev);
  } catch {
    return null;
  }

  if (patch.safe_address === null) return prevNorm;

  if (patch.safe_address !== undefined && patch.safe_address !== null) {
    try {
      const nextNorm = getAddress(patch.safe_address);
      if (nextNorm !== prevNorm) return prevNorm;
    } catch {
      return prevNorm;
    }
  }

  return null;
}

export interface SweepOrphanedServiceFundsParams {
  rpcUrl: string;
  provider: JsonRpcProvider;
  masterAddress: string;
  masterSigner: HDNodeWallet;
  serviceIndex: number;
  agentPrivateKey: string;
  agentAddress: string;
  abandonedSafeAddress: string;
  minAgentReserveWei: bigint;
}

/**
 * Sweep ETH from an abandoned deployed Safe (via Safe.execTransaction) and excess
 * agent EOA ETH to the master. Never throws; logs actionable errors on failure.
 */
export async function sweepOrphanedServiceFunds(
  params: SweepOrphanedServiceFundsParams,
): Promise<void> {
  const { serviceIndex, masterAddress } = params;

  let masterNorm: string;
  try {
    masterNorm = getAddress(masterAddress);
  } catch {
    console.error(
      `[jinn-earning] Service ${serviceIndex}: orphan sweep skipped — invalid master_address.`,
    );
    return;
  }

  try {
    await runOrphanSweepBody({
      ...params,
      masterNorm,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[jinn-earning] Service ${serviceIndex}: orphan sweep aborted (${msg}). Fix RPC connectivity or retry bootstrap later.`,
    );
  }
}

interface OrphanSweepBodyParams extends SweepOrphanedServiceFundsParams {
  masterNorm: string;
}

async function runOrphanSweepBody(params: OrphanSweepBodyParams): Promise<void> {
  const {
    rpcUrl,
    provider,
    masterNorm,
    masterSigner,
    serviceIndex,
    agentPrivateKey,
    agentAddress,
    abandonedSafeAddress,
    minAgentReserveWei,
  } = params;

  const code = await provider.getCode(abandonedSafeAddress);
  const safeBal = await provider.getBalance(abandonedSafeAddress);

  if (code !== '0x' && safeBal > 0n) {
    let agentBal = await provider.getBalance(agentAddress);
    if (agentBal < minAgentReserveWei) {
      const need = minAgentReserveWei - agentBal;
      const masterBal = await provider.getBalance(masterNorm);
      if (masterBal > need) {
        try {
          console.error(
            `[jinn-earning] Service ${serviceIndex}: funding agent ${agentAddress} with ${need} wei so the Safe owner can exec orphan sweep from ${abandonedSafeAddress}.`,
          );
          const fundTx = await ethersSendTransactionWithRetry(
            masterSigner.connect(provider),
            { to: agentAddress, value: need },
          );
          await ethersWaitForTransactionHashWithRetry(
            provider,
            fundTx.hash,
            1,
            30000,
          );
          agentBal = await provider.getBalance(agentAddress);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(
            `[jinn-earning] Service ${serviceIndex}: could not fund agent for orphan Safe sweep (${abandonedSafeAddress} holds ${safeBal} wei). ${msg} — send at least ${formatEther(need)} ETH to the agent EOA, then re-run bootstrap.`,
          );
        }
      } else {
        console.error(
          `[jinn-earning] Service ${serviceIndex}: orphan Safe ${abandonedSafeAddress} holds ${safeBal} wei but master and agent lack gas to sweep. Fund master or agent, then re-run bootstrap.`,
        );
      }
    }

    agentBal = await provider.getBalance(agentAddress);
    if (agentBal >= minAgentReserveWei) {
      try {
        const { hash } = await executeSafeTxDirect({
          rpcUrl,
          signerKey: agentPrivateKey,
          safeAddress: abandonedSafeAddress,
          to: masterNorm,
          value: safeBal,
          data: '0x',
        });
        const receipt = await ethersWaitForTransactionHashWithRetry(
          provider,
          hash,
          1,
          30000,
        );
        if (!receipt || receipt.status !== 1) {
          console.error(
            `[jinn-earning] Service ${serviceIndex}: orphan Safe sweep tx failed or timed out (safe=${abandonedSafeAddress}, tx=${hash}). Re-run bootstrap to retry.`,
          );
        } else {
          console.error(
            `[jinn-earning] Service ${serviceIndex}: swept ${safeBal} wei from orphan Safe ${abandonedSafeAddress} to master (tx: ${hash}).`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[jinn-earning] Service ${serviceIndex}: orphan Safe sweep failed for ${abandonedSafeAddress} (${msg}). Ensure the agent EOA is still a Safe owner and re-run bootstrap, or move funds manually to master ${masterNorm}.`,
        );
      }
    }
  }

  // TODO: sweep ERC-20 (e.g. OLAS) from abandoned Safe via Safe.execTransaction(transfer).

  const agentConnected = new Wallet(agentPrivateKey, provider);
  const finalAgentBal = await provider.getBalance(agentAddress);
  const transferable =
    finalAgentBal > minAgentReserveWei ? finalAgentBal - minAgentReserveWei : 0n;
  if (transferable > 0n) {
    try {
      const tx = await ethersSendTransactionWithRetry(agentConnected, {
        to: masterNorm,
        value: transferable,
      });
      const receipt = await ethersWaitForTransactionHashWithRetry(
        provider,
        tx.hash,
        1,
        30000,
      );
      if (!receipt || receipt.status !== 1) {
        console.error(
          `[jinn-earning] Service ${serviceIndex}: agent EOA sweep tx failed (tx=${tx.hash}). Re-run bootstrap to retry.`,
        );
      } else {
        console.error(
          `[jinn-earning] Service ${serviceIndex}: swept ${transferable} wei from agent ${agentAddress} to master (tx: ${tx.hash}).`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[jinn-earning] Service ${serviceIndex}: agent EOA sweep failed (${msg}). Re-run bootstrap to retry or send manually to master ${masterNorm}.`,
      );
    }
  }
}

