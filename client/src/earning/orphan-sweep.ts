/**
 * Best-effort recovery of ETH from a service Safe / agent EOA when bootstrap abandons
 * a persisted Safe (reconcile clear or stale standard-mode state).
 *
 * ERC-20 balances on the old Safe are not swept yet — see TODO below.
 */

import { encodeFunctionData, formatEther, getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { executeSafeTxDirect } from './safe-adapter.js';
import type { ServiceState } from './types.js';
import { createJinnWalletClient, type JinnOnchainNetwork } from './viem-clients.js';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { PublicClient } from 'viem';
import {
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
} from '../tx-retry.js';
import { ERC20_ABI } from './contracts.js';

function isZeroishAddress(addr: string | null | undefined): boolean {
  if (!addr) return true;
  try {
    return getAddress(addr) === getAddress(zeroAddress);
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

/** An ERC-20 token to sweep from the abandoned Safe. */
export interface Erc20SweepToken {
  /** Checksummed token contract address. */
  address: string;
  /** Human-readable symbol for log messages. */
  symbol: string;
}

export interface SweepOrphanedServiceFundsParams {
  rpcUrl: string;
  network: JinnOnchainNetwork;
  publicClient: PublicClient;
  masterAddress: string;
  masterAccount: PrivateKeyAccount;
  serviceIndex: number;
  agentPrivateKey: Hex;
  agentAddress: string;
  abandonedSafeAddress: string;
  minAgentReserveWei: bigint;
  /**
   * ERC-20 tokens to sweep from the abandoned Safe (e.g. OLAS bond).
   * Each token with a non-zero balance on the Safe will be transferred
   * to `masterAddress` via Safe.execTransaction. If omitted, no ERC-20
   * sweep is attempted.
   */
  erc20Tokens?: Erc20SweepToken[];
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
    network,
    publicClient,
    masterNorm,
    masterAccount,
    serviceIndex,
    agentPrivateKey,
    agentAddress,
    abandonedSafeAddress,
    minAgentReserveWei,
  } = params;

  const code = await publicClient.getCode({ address: getAddress(abandonedSafeAddress) as Address });
  const safeBal = await publicClient.getBalance({ address: getAddress(abandonedSafeAddress) as Address });

  if (code !== undefined && code !== '0x' && safeBal > 0n) {
    let agentBal = await publicClient.getBalance({ address: getAddress(agentAddress) as Address });
    if (agentBal < minAgentReserveWei) {
      const need = minAgentReserveWei - agentBal;
      const masterBal = await publicClient.getBalance({ address: masterNorm as Address });
      if (masterBal > need) {
        try {
          console.error(
            `[jinn-earning] Service ${serviceIndex}: funding agent ${agentAddress} with ${need} wei so the Safe owner can exec orphan sweep from ${abandonedSafeAddress}.`,
          );
          const masterWallet = createJinnWalletClient(rpcUrl, network, masterAccount);
          const fundHash = await viemSendTransactionWithRetry(masterWallet, publicClient, {
            account: masterAccount,
            to: getAddress(agentAddress) as Address,
            value: need,
          });
          await waitForTransactionReceiptWithRetry(publicClient, fundHash);
          agentBal = await publicClient.getBalance({ address: getAddress(agentAddress) as Address });
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

    agentBal = await publicClient.getBalance({ address: getAddress(agentAddress) as Address });
    if (agentBal >= minAgentReserveWei) {
      try {
        const { hash } = await executeSafeTxDirect({
          rpcUrl,
          signerKey: agentPrivateKey,
          safeAddress: abandonedSafeAddress,
          to: getAddress(masterNorm) as Address,
          value: safeBal,
          data: '0x' as Hex,
        });
        const receipt = await waitForTransactionReceiptWithRetry(publicClient, hash as Hex);
        if (receipt.status !== 'success') {
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

  // Sweep ERC-20 tokens (e.g. OLAS bond) from the abandoned Safe.
  const erc20Tokens = params.erc20Tokens ?? [];
  for (const token of erc20Tokens) {
    let tokenAddress: Address;
    try {
      tokenAddress = getAddress(token.address) as Address;
    } catch {
      console.error(
        `[jinn-earning] Service ${serviceIndex}: skipping ERC-20 sweep for invalid address ${token.address} (${token.symbol}).`,
      );
      continue;
    }

    let tokenBalance: bigint;
    try {
      tokenBalance = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [getAddress(abandonedSafeAddress) as Address],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[jinn-earning] Service ${serviceIndex}: could not read ${token.symbol} balance on Safe ${abandonedSafeAddress} (${msg}). Skipping ERC-20 sweep for this token.`,
      );
      continue;
    }

    if (tokenBalance === 0n) {
      continue;
    }

    // Encode transfer(masterAddress, balance) calldata for the inner call.
    const transferData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [getAddress(masterNorm) as Address, tokenBalance],
    }) as Hex;

    try {
      const agentBal = await publicClient.getBalance({ address: getAddress(agentAddress) as Address });
      if (agentBal < minAgentReserveWei) {
        console.error(
          `[jinn-earning] Service ${serviceIndex}: agent EOA lacks gas to sweep ${token.symbol} (${tokenBalance}) from Safe ${abandonedSafeAddress}. Fund agent and re-run bootstrap.`,
        );
        continue;
      }

      const { hash } = await executeSafeTxDirect({
        rpcUrl,
        signerKey: agentPrivateKey,
        safeAddress: abandonedSafeAddress,
        to: tokenAddress,
        value: 0n,
        data: transferData,
      });
      const receipt = await waitForTransactionReceiptWithRetry(publicClient, hash as Hex);
      if (receipt.status !== 'success') {
        console.error(
          `[jinn-earning] Service ${serviceIndex}: ERC-20 sweep tx for ${token.symbol} failed or timed out (safe=${abandonedSafeAddress}, tx=${hash}). Re-run bootstrap to retry.`,
        );
      } else {
        console.error(
          `[jinn-earning] Service ${serviceIndex}: swept ${tokenBalance} ${token.symbol} from orphan Safe ${abandonedSafeAddress} to master (tx: ${hash}).`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[jinn-earning] Service ${serviceIndex}: ERC-20 sweep failed for ${token.symbol} on Safe ${abandonedSafeAddress} (${msg}). Re-run bootstrap to retry or transfer manually to master ${masterNorm}.`,
      );
    }
  }

  const agentAccount = privateKeyToAccount(agentPrivateKey);
  const agentWallet = createJinnWalletClient(rpcUrl, network, agentAccount);
  const finalAgentBal = await publicClient.getBalance({ address: getAddress(agentAddress) as Address });
  const transferable =
    finalAgentBal > minAgentReserveWei ? finalAgentBal - minAgentReserveWei : 0n;
  if (transferable > 0n) {
    try {
      const txHash = await viemSendTransactionWithRetry(agentWallet, publicClient, {
        account: agentAccount,
        to: getAddress(masterNorm) as Address,
        value: transferable,
      });
      const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash);
      if (receipt.status !== 'success') {
        console.error(
          `[jinn-earning] Service ${serviceIndex}: agent EOA sweep tx failed (tx=${txHash}). Re-run bootstrap to retry.`,
        );
      } else {
        console.error(
          `[jinn-earning] Service ${serviceIndex}: swept ${transferable} wei from agent ${agentAddress} to master (tx: ${txHash}).`,
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
