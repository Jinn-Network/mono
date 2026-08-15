/**
 * Shared withdraw execution (master + optional agent sweeps). Used by `jinn withdraw` and `npm run withdraw`.
 */

import {
  encodeFunctionData,
  formatEther,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { JinnConfig } from '../config.js';
import { getChainConfig } from '../earning/contracts.js';
import { FleetStateStore } from '../earning/store.js';
import { decryptMnemonic, deriveAgentSigner, deriveMasterSigner } from '../earning/wallet.js';
import { createJinnPublicClient, createJinnWalletClient, type JinnOnchainNetwork } from '../earning/viem-clients.js';
import {
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
} from '../tx-retry.js';
import { withdrawArgsNeedMasterTransfer, type WithdrawParsedArgs } from './args.js';

const ETH_CONFIRM_WEI = 5n * 10n ** 16n; // 0.05 ETH
const JINN_CONFIRM_WEI = 1000n * 10n ** 18n; // 1000 tokens @ 18 decimals

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

export function withdrawNeedsInteractiveConfirm(
  p: WithdrawParsedArgs,
  opts: { sweepWouldSend: boolean },
): boolean {
  if (p.dryRun || p.yes) return false;
  if (p.drainJinn || p.drainEth) return true;
  if (opts.sweepWouldSend && p.sweepAgents) return true;
  if (p.ethWei !== null && p.ethWei >= ETH_CONFIRM_WEI) return true;
  if (p.jinnWei !== null && p.jinnWei >= JINN_CONFIRM_WEI) return true;
  return false;
}

export function resolveWithdrawTokenAddress(
  chain: 'base' | 'base-sepolia',
  config: JinnConfig,
): string {
  const envTok = process.env['JINN_TOKEN']?.trim();
  if (envTok) {
    if (!isAddress(envTok)) {
      throw new Error(`JINN_TOKEN must be a valid address, got: ${envTok}`);
    }
    return getAddress(envTok);
  }
  return getAddress(
    getChainConfig(chain, {
      testnetL2DeploymentPath: config.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: config.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    }).olasToken,
  );
}

export async function estimateNativeTransferCostWei(publicClient: PublicClient): Promise<bigint> {
  try {
    const fees = await publicClient.estimateFeesPerGas();
    if (fees.maxFeePerGas !== undefined) {
      return (21_000n * fees.maxFeePerGas * 3n) / 2n;
    }
  } catch {
    /* fall through */
  }
  const gasPrice = await publicClient.getGasPrice();
  if (gasPrice === 0n) {
    throw new Error('Could not resolve gas price for fee estimate');
  }
  return (21_000n * gasPrice * 3n) / 2n;
}

export async function computeSweepWouldSend(
  publicClient: PublicClient,
  mnemonic: string,
  fleet: Awaited<ReturnType<FleetStateStore['tryLoadExisting']>>,
  to: string,
  minSweepWei: bigint,
): Promise<boolean> {
  void to;
  if (!fleet?.services.length) return false;
  const cost = await estimateNativeTransferCostWei(publicClient);
  for (const svc of fleet.services) {
    const derived = getAddress(deriveAgentSigner(mnemonic, svc.index).address);
    const recorded = getAddress(svc.agent_address);
    if (derived !== recorded) continue;
    const bal = await publicClient.getBalance({ address: derived as Address });
    if (bal > cost + minSweepWei) return true;
  }
  return false;
}

async function sweepAgentEoas(opts: {
  rpcUrl: string;
  network: JinnOnchainNetwork;
  publicClient: PublicClient;
  mnemonic: string;
  fleet: Awaited<ReturnType<FleetStateStore['tryLoadExisting']>>;
  to: string;
  dryRun: boolean;
  minSweepWei: bigint;
  log: (s: string) => void;
  warn: (s: string) => void;
}): Promise<void> {
  const { rpcUrl, network, publicClient, mnemonic, fleet, to, dryRun, minSweepWei, log, warn } = opts;
  if (!fleet?.services.length) {
    log('[withdraw] No services in fleet state; nothing to sweep.');
    return;
  }

  const gasReserve = await estimateNativeTransferCostWei(publicClient);

  for (const svc of fleet.services) {
    const agentAccount = deriveAgentSigner(mnemonic, svc.index);
    const derived = getAddress(agentAccount.address);
    const recorded = getAddress(svc.agent_address);
    if (derived !== recorded) {
      warn(
        `[withdraw] Skip service ${svc.index}: derived agent ${derived} != state ${recorded}`,
      );
      continue;
    }

    const bal = await publicClient.getBalance({ address: derived as Address });
    const sendWei = bal > gasReserve ? bal - gasReserve : 0n;
    if (sendWei <= minSweepWei) {
      log(
        `[withdraw] Agent ${svc.index} ${derived}: balance ${bal} wei — below sweep threshold, skip`,
      );
      continue;
    }

    log(
      `[withdraw] Agent ${svc.index} ${derived}: sweep ${sendWei} wei to ${to}` +
        (dryRun ? ' (dry-run)' : ''),
    );
    if (!dryRun) {
      const agentWallet = createJinnWalletClient(rpcUrl, network, agentAccount);
      const hash = await viemSendTransactionWithRetry(agentWallet, publicClient, {
        account: agentAccount,
        to: getAddress(to) as Address,
        value: sendWei,
      });
      await waitForTransactionReceiptWithRetry(publicClient, hash);
      log(`[withdraw]   tx ${hash}`);
    }
  }
}

async function masterTransfers(opts: {
  publicClient: PublicClient;
  rpcUrl: string;
  network: JinnOnchainNetwork;
  masterAccount: ReturnType<typeof deriveMasterSigner>;
  masterWallet: ReturnType<typeof createJinnWalletClient>;
  tokenDecimals: number;
  tokenAddress: string;
  to: string;
  parsed: WithdrawParsedArgs;
  log: (s: string) => void;
}): Promise<void> {
  const { publicClient, masterWallet, masterAccount, tokenDecimals, tokenAddress, to, parsed, log } =
    opts;
  const { dryRun } = parsed;
  const chainId = await publicClient.getChainId();

  log(`[withdraw] Master ${masterAccount.address} → ${to} (chain ${chainId})`);
  log(`[withdraw] ERC-20 token contract ${tokenAddress} (set JINN_TOKEN to override)`);

  const tokenAddr = getAddress(tokenAddress) as Address;

  if (parsed.jinnWei !== null || parsed.drainJinn) {
    let amount = parsed.jinnWei;
    if (parsed.drainJinn) {
      amount = await publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [getAddress(masterAccount.address) as Address],
      });
      log(`[withdraw] Drain JINN: balance ${amount} (${tokenDecimals} decimals)`);
    }
    if (amount === null || amount <= 0n) {
      log('[withdraw] Skipping token transfer (zero amount).');
    } else {
      log(`[withdraw] Token transfer ${amount} wei` + (dryRun ? ' (dry-run)' : ''));
      if (!dryRun) {
        const data = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [getAddress(to) as Address, amount],
        });
        const hash = await viemSendTransactionWithRetry(masterWallet, publicClient, {
          account: masterAccount,
          to: tokenAddr,
          data,
        });
        await waitForTransactionReceiptWithRetry(publicClient, hash);
        log(`[withdraw]   tx ${hash}`);
      }
    }
  }

  if (parsed.ethWei !== null || parsed.drainEth) {
    const cost = await estimateNativeTransferCostWei(publicClient);
    let value = parsed.ethWei;
    if (parsed.drainEth) {
      const bal = await publicClient.getBalance({ address: getAddress(masterAccount.address) as Address });
      const reserve = parsed.masterGasReserveWei;
      const raw = bal > reserve + cost ? bal - reserve - cost : 0n;
      value = raw;
      log(
        `[withdraw] Drain ETH: balance ${bal} wei, reserve ${reserve} wei, est. gas ${cost} wei, send ${value} wei`,
      );
    }
    if (value === null || value <= 0n) {
      log('[withdraw] Skipping ETH transfer (zero amount).');
    } else {
      const bal = await publicClient.getBalance({ address: getAddress(masterAccount.address) as Address });
      if (bal < value + cost) {
        throw new Error(
          `Insufficient ETH for transfer: need ${value + cost} wei (value + est. gas), have ${bal}`,
        );
      }
      log(
        `[withdraw] ETH transfer ${value} wei (${formatEther(value)} ETH)` + (dryRun ? ' (dry-run)' : ''),
      );
      if (!dryRun) {
        const hash = await viemSendTransactionWithRetry(masterWallet, publicClient, {
          account: masterAccount,
          to: getAddress(to) as Address,
          value,
        });
        await waitForTransactionReceiptWithRetry(publicClient, hash);
        log(`[withdraw]   tx ${hash}`);
      }
    }
  }
}

export interface RunWithdrawPlanOptions {
  password: string;
  config: JinnConfig;
  parsed: WithdrawParsedArgs;
  log?: (s: string) => void;
  warn?: (s: string) => void;
}

export async function runWithdrawPlan(options: RunWithdrawPlanOptions): Promise<void> {
  const log = options.log ?? ((s: string) => console.log(s));
  const warn = options.warn ?? ((s: string) => console.warn(s));
  const { password, config, parsed } = options;

  const chain: JinnOnchainNetwork = config.network === 'testnet' ? 'base-sepolia' : 'base';
  const publicClient = createJinnPublicClient(config.rpcUrl, chain);
  const chainId = await publicClient.getChainId();
  const chainConfig = getChainConfig(chain, {
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
  });
  if (chainId !== chainConfig.chainId) {
    throw new Error(`RPC chainId ${chainId} does not match expected ${chainConfig.chainId} for ${chain}.`);
  }

  const store = new FleetStateStore(config.earningDir);
  if (!store.hasMnemonicKeystore()) {
    throw new Error(`No mnemonic keystore at ${store.dir}/master_keystore.json`);
  }

  const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), password);
  const masterAccount = deriveMasterSigner(mnemonic);
  const masterWallet = createJinnWalletClient(config.rpcUrl, chain, masterAccount);
  const fleet = await store.tryLoadExisting();

  if (fleet?.master_address) {
    const m = getAddress(fleet.master_address);
    const w = getAddress(masterAccount.address);
    if (m !== w) {
      throw new Error(`Keystore master ${w} does not match fleet state master ${m}`);
    }
  }

  const tokenAddress = resolveWithdrawTokenAddress(chain, config);
  let tokenDecimals = 18;
  try {
    tokenDecimals = Number(
      await publicClient.readContract({
        address: getAddress(tokenAddress) as Address,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
    );
  } catch {
    // default 18
  }

  const to = parsed.to as `0x${string}`;

  if (parsed.sweepAgents) {
    await sweepAgentEoas({
      rpcUrl: config.rpcUrl,
      network: chain,
      publicClient,
      mnemonic,
      fleet,
      to,
      dryRun: parsed.dryRun,
      minSweepWei: parsed.minSweepWei,
      log,
      warn,
    });
  }

  if (withdrawArgsNeedMasterTransfer(parsed)) {
    await masterTransfers({
      publicClient,
      rpcUrl: config.rpcUrl,
      network: chain,
      masterAccount,
      masterWallet,
      tokenDecimals,
      tokenAddress,
      to,
      parsed,
      log,
    });
  }

  log(parsed.dryRun ? '[withdraw] Dry-run complete.' : '[withdraw] Done.');
}
