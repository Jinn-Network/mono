/**
 * Fund Distributor — Automatic ETH distribution from Master Safe to service addresses
 *
 * Periodically checks ETH balances of all service Safes and agent EOAs,
 * and tops them up from the Master Safe when they fall below the threshold
 * defined in each service's fund_requirements config.
 *
 * Mirrors the middleware's funding_job (manage.py:2312) behavior:
 * - Threshold = 50% of fund_requirements target
 * - Top-up fills to 100% of target
 * - Executes individual Safe execTransaction calls (no Safe SDK dependency)
 */

import { ethers } from 'ethers';
import { promises as fs } from 'fs';
import { join } from 'path';
import { workerLogger } from '../../logging/index.js';
import { getMasterSafe, getMasterPrivateKey, getMasterEOA, getMiddlewarePath } from '../../env/operate-profile.js';
import { verifyAgentKeyAccessible } from '../../env/keystore-verify.js';
import { createRpcProvider } from '../../config/index.js';
import type { ServiceInfo } from '../ServiceConfigReader.js';

const log = workerLogger.child({ component: 'FUND-DISTRIBUTOR' });

/** Safe ABI — same subset used by MechMarketplaceRequester */
const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
];

/** Matches middleware DEFAULT_TOPUP_THRESHOLD */
const TOPUP_THRESHOLD_FRACTION = 0.5;

/** Minimum ETH to keep in Master Safe (don't drain it completely) */
const DEFAULT_RESERVE_WEI = ethers.parseEther('0.002');

/** Minimum ETH to keep in Master EOA (needs gas for Safe txns) */
const EOA_RESERVE_WEI = ethers.parseEther('0.002');

/** Target balance for Master Safe when topping up from Master EOA */
const MASTER_SAFE_TARGET_WEI = ethers.parseEther('0.008');

/** Minimum fund target per address — overrides low config.json values */
const MIN_FUND_TARGET_WEI = ethers.parseEther('0.002');

/** Zero address represents native ETH in fund_requirements */
const ETH_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface FundTransfer {
  to: string;
  label: string;
  amountWei: bigint;
}

export interface FundDistributionResult {
  checked: number;
  funded: FundTransfer[];
  skipped: string[];
  txHash?: string;
  error?: string;
}

interface FundRequirements {
  agent: number; // wei
  safe: number;  // wei
}

/**
 * Read fund_requirements from a service's config.json.
 * ServiceInfo doesn't include this, so we read the raw config.
 */
async function readFundRequirements(serviceConfigId: string): Promise<FundRequirements | null> {
  const middlewarePath = getMiddlewarePath();
  if (!middlewarePath) return null;

  try {
    const configPath = join(middlewarePath, '.operate', 'services', serviceConfigId, 'config.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);
    const homeChain = config.home_chain || 'base';
    const reqs = config.chain_configs?.[homeChain]?.chain_data?.user_params?.fund_requirements?.[ETH_ADDRESS];
    if (reqs && reqs.agent != null && reqs.safe != null) {
      return { agent: Number(reqs.agent), safe: Number(reqs.safe) };
    }
  } catch (err) {
    log.debug({ serviceConfigId, error: (err as Error).message }, 'Could not read fund_requirements');
  }
  return null;
}

/**
 * Check all service addresses and distribute ETH from Master Safe as needed.
 *
 * @param services - All services from ServiceRotator
 * @param rpcUrl - RPC URL for balance queries and transaction submission
 * @param options.reserveWei - Minimum ETH to keep in Master Safe (default 0.002 ETH)
 */
export async function maybeDistributeFunds(
  services: ServiceInfo[],
  rpcUrl: string,
  options?: { reserveWei?: bigint },
): Promise<FundDistributionResult> {
  const result: FundDistributionResult = { checked: 0, funded: [], skipped: [] };
  const reserveWei = options?.reserveWei ?? DEFAULT_RESERVE_WEI;

  const masterSafeAddress = getMasterSafe('base');
  if (!masterSafeAddress) {
    result.error = 'Master Safe address not found';
    log.warn(result.error);
    return result;
  }

  const masterPrivateKey = getMasterPrivateKey();
  if (!masterPrivateKey) {
    result.error = 'Master private key not available (OPERATE_PASSWORD set?)';
    log.warn(result.error);
    return result;
  }

  const provider = createRpcProvider(rpcUrl);
  let masterBalance = await provider.getBalance(masterSafeAddress);

  log.info({
    masterSafe: masterSafeAddress,
    masterBalanceEth: ethers.formatEther(masterBalance),
    serviceCount: services.length,
  }, 'Fund distribution check starting');

  // If Master Safe is low, top it up from Master EOA
  if (masterBalance < MASTER_SAFE_TARGET_WEI) {
    const eoaAddress = getMasterEOA();
    if (eoaAddress && masterPrivateKey) {
      const eoaBalance = await provider.getBalance(eoaAddress);
      const eoaAvailable = eoaBalance > EOA_RESERVE_WEI ? eoaBalance - EOA_RESERVE_WEI : 0n;
      const safeDeficit = MASTER_SAFE_TARGET_WEI - masterBalance;
      const topUpAmount = eoaAvailable < safeDeficit ? eoaAvailable : safeDeficit;

      if (topUpAmount > 0n) {
        log.info({
          from: eoaAddress,
          to: masterSafeAddress,
          ethAmount: ethers.formatEther(topUpAmount),
          eoaBalance: ethers.formatEther(eoaBalance),
        }, 'Topping up Master Safe from Master EOA');

        try {
          const eoaWallet = new ethers.Wallet(masterPrivateKey, provider);
          const tx = await eoaWallet.sendTransaction({
            to: masterSafeAddress,
            value: topUpAmount,
          });
          const receipt = await tx.wait();
          if (receipt && receipt.status === 1) {
            log.info({ txHash: receipt.hash, ethAmount: ethers.formatEther(topUpAmount) },
              'Master Safe topped up from Master EOA');
            masterBalance = await provider.getBalance(masterSafeAddress);
          }
        } catch (err) {
          log.error({ error: (err as Error).message }, 'Failed to top up Master Safe from EOA');
        }
      }
    }
  }

  if (masterBalance <= reserveWei) {
    result.error = `Master Safe balance (${ethers.formatEther(masterBalance)} ETH) at or below reserve (${ethers.formatEther(reserveWei)} ETH)`;
    log.warn(result.error);
    return result;
  }

  const availableWei = masterBalance - reserveWei;
  const agentTransfers: FundTransfer[] = [];
  const safeTransfers: FundTransfer[] = [];

  // OPERATE_PASSWORD needed for key verification
  const operatePassword = process.env.OPERATE_PASSWORD;

  for (const svc of services) {
    if (!svc.serviceSafeAddress || !svc.agentEoaAddress) continue;

    const reqs = await readFundRequirements(svc.serviceConfigId);
    if (!reqs) {
      result.skipped.push(`${svc.serviceConfigId}: no fund_requirements`);
      continue;
    }

    // SAFETY GATE: verify we can access the agent key before sending ETH.
    // Never fund a wallet whose private key we can't prove we hold.
    if (operatePassword) {
      const keyAccessible = verifyAgentKeyAccessible(
        svc.serviceConfigId,
        svc.agentEoaAddress,
        operatePassword,
      );
      if (!keyAccessible) {
        result.skipped.push(
          `Service #${svc.serviceId} (${svc.serviceConfigId}): agent key NOT accessible — refusing to fund`,
        );
        log.warn({ serviceId: svc.serviceId, agentEoa: svc.agentEoaAddress },
          'SAFETY: Skipping service funding — agent key verification failed');
        continue;
      }
    } else {
      log.warn({ serviceId: svc.serviceId },
        'OPERATE_PASSWORD not set — cannot verify agent key, skipping key verification');
    }

    result.checked++;

    // Check agent EOA balance first — agents pay gas for every transaction
    const agentTarget = BigInt(reqs.agent) < MIN_FUND_TARGET_WEI ? MIN_FUND_TARGET_WEI : BigInt(reqs.agent);
    const agentThreshold = agentTarget / 2n;
    const agentBalance = await provider.getBalance(svc.agentEoaAddress);

    if (agentBalance < agentThreshold && agentTarget > 0n) {
      const topUp = agentTarget - agentBalance;
      agentTransfers.push({
        to: svc.agentEoaAddress,
        label: `Service #${svc.serviceId} Agent EOA`,
        amountWei: topUp,
      });
    }

    // Check service Safe balance — holds value for marketplace request payments
    const safeTarget = BigInt(reqs.safe) < MIN_FUND_TARGET_WEI ? MIN_FUND_TARGET_WEI : BigInt(reqs.safe);
    const safeThreshold = safeTarget / 2n;
    const safeBalance = await provider.getBalance(svc.serviceSafeAddress);

    if (safeBalance < safeThreshold && safeTarget > 0n) {
      const topUp = safeTarget - safeBalance;
      safeTransfers.push({
        to: svc.serviceSafeAddress,
        label: `Service #${svc.serviceId} Safe`,
        amountWei: topUp,
      });
    }
  }

  // Agent EOAs first (gas payers), then service Safes (value holders)
  const transfers = [...agentTransfers, ...safeTransfers];

  if (transfers.length === 0) {
    log.info({ checked: result.checked }, 'All service addresses adequately funded');
    return result;
  }

  // Trim transfers to fit within available Master Safe balance
  const totalNeeded = transfers.reduce((sum, t) => sum + t.amountWei, 0n);
  const affordableTransfers: FundTransfer[] = [];
  let runningTotal = 0n;

  for (const transfer of transfers) {
    if (runningTotal + transfer.amountWei <= availableWei) {
      affordableTransfers.push(transfer);
      runningTotal += transfer.amountWei;
    } else {
      result.skipped.push(`${transfer.label}: insufficient Master Safe funds`);
    }
  }

  if (affordableTransfers.length === 0) {
    result.error = `Need ${ethers.formatEther(totalNeeded)} ETH but only ${ethers.formatEther(availableWei)} available after reserve`;
    log.warn(result.error);
    return result;
  }

  log.info({
    transfers: affordableTransfers.map(t => ({
      to: t.to,
      label: t.label,
      ethAmount: ethers.formatEther(t.amountWei),
    })),
    totalEth: ethers.formatEther(runningTotal),
  }, 'Executing fund distribution');

  // Execute transfers as individual Safe execTransaction calls
  // Uses raw ethers (same pattern as MechMarketplaceRequester) — no Safe SDK
  const masterWallet = new ethers.Wallet(masterPrivateKey, provider);
  const safe = new ethers.Contract(masterSafeAddress, SAFE_ABI, masterWallet);

  for (const transfer of affordableTransfers) {
    try {
      const safeNonce = await safe.nonce();

      const txHash = await safe.getTransactionHash(
        transfer.to,
        transfer.amountWei,
        '0x',                       // data (plain ETH transfer)
        0,                          // operation (CALL)
        0,                          // safeTxGas
        0,                          // baseGas
        0,                          // gasPrice
        ethers.ZeroAddress,         // gasToken
        ethers.ZeroAddress,         // refundReceiver
        safeNonce,
      );

      // Sign (eth_sign format — v + 4 for Safe contract signature validation)
      const signature = await masterWallet.signMessage(ethers.getBytes(txHash));
      const sigBytes = ethers.getBytes(signature);
      const r = ethers.hexlify(sigBytes.slice(0, 32));
      const s = ethers.hexlify(sigBytes.slice(32, 64));
      const v = sigBytes[64] + 4;
      const adjustedSignature = ethers.concat([r, s, new Uint8Array([v])]);

      const tx = await safe.execTransaction(
        transfer.to,
        transfer.amountWei,
        '0x',
        0,                          // operation
        0,                          // safeTxGas
        0,                          // baseGas
        0,                          // gasPrice
        ethers.ZeroAddress,         // gasToken
        ethers.ZeroAddress,         // refundReceiver
        adjustedSignature,
      );

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Safe transaction reverted (status: ${receipt?.status})`);
      }

      result.funded.push(transfer);
      result.txHash = receipt.hash; // last successful tx hash

      log.info({
        txHash: receipt.hash,
        label: transfer.label,
        ethAmount: ethers.formatEther(transfer.amountWei),
      }, 'Fund transfer complete');
    } catch (err) {
      const errMsg = (err as Error).message;
      log.error({ error: errMsg, label: transfer.label }, 'Fund transfer failed');
      result.skipped.push(`${transfer.label}: ${errMsg}`);
      // Continue with remaining transfers — don't abort the whole batch
    }
  }

  if (result.funded.length > 0) {
    log.info({
      fundedCount: result.funded.length,
      totalEth: ethers.formatEther(result.funded.reduce((sum, t) => sum + t.amountWei, 0n)),
    }, 'Fund distribution complete');
  } else {
    result.error = 'All transfers failed';
  }

  return result;
}
