/**
 * Shared withdraw execution (master + optional agent sweeps). Used by `jinn withdraw` and `npm run withdraw`.
 */

import { Contract, JsonRpcProvider, formatEther, getAddress, isAddress } from 'ethers';
import type { JinnConfig } from '../config.js';
import { getChainConfig } from '../earning/contracts.js';
import { FleetStateStore } from '../earning/store.js';
import { decryptMnemonic, deriveAgentSigner, deriveMasterSigner } from '../earning/wallet.js';
import { withdrawArgsNeedMasterTransfer, type WithdrawParsedArgs } from './args.js';

const ETH_CONFIRM_WEI = 5n * 10n ** 16n; // 0.05 ETH
const JINN_CONFIRM_WEI = 1000n * 10n ** 18n; // 1000 tokens @ 18 decimals

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

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
] as const;

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

export async function estimateNativeTransferCostWei(provider: JsonRpcProvider): Promise<bigint> {
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? 0n;
  if (gasPrice === 0n) {
    throw new Error('Could not resolve gas price for fee estimate');
  }
  const gasLimit = 21_000n;
  return (gasLimit * gasPrice * 3n) / 2n;
}

export async function computeSweepWouldSend(
  provider: JsonRpcProvider,
  mnemonic: string,
  fleet: Awaited<ReturnType<FleetStateStore['tryLoadExisting']>>,
  to: string,
  minSweepWei: bigint,
): Promise<boolean> {
  void to;
  if (!fleet?.services.length) return false;
  const cost = await estimateNativeTransferCostWei(provider);
  for (const svc of fleet.services) {
    const derived = getAddress(deriveAgentSigner(mnemonic, svc.index).address);
    const recorded = getAddress(svc.agent_address);
    if (derived !== recorded) continue;
    const bal = await provider.getBalance(recorded);
    if (bal > cost + minSweepWei) return true;
  }
  return false;
}

async function sweepAgentEoas(opts: {
  provider: JsonRpcProvider;
  mnemonic: string;
  fleet: Awaited<ReturnType<FleetStateStore['tryLoadExisting']>>;
  to: string;
  dryRun: boolean;
  minSweepWei: bigint;
  log: (s: string) => void;
  warn: (s: string) => void;
}): Promise<void> {
  const { provider, mnemonic, fleet, to, dryRun, minSweepWei, log, warn } = opts;
  if (!fleet?.services.length) {
    log('[withdraw] No services in fleet state; nothing to sweep.');
    return;
  }

  const gasReserve = await estimateNativeTransferCostWei(provider);

  for (const svc of fleet.services) {
    const signer = deriveAgentSigner(mnemonic, svc.index).connect(provider);
    const derived = getAddress(signer.address);
    const recorded = getAddress(svc.agent_address);
    if (derived !== recorded) {
      warn(
        `[withdraw] Skip service ${svc.index}: derived agent ${derived} != state ${recorded}`,
      );
      continue;
    }

    const bal = await provider.getBalance(derived);
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
      const tx = await signer.sendTransaction({ to, value: sendWei });
      await tx.wait();
      log(`[withdraw]   tx ${tx.hash}`);
    }
  }
}

async function masterTransfers(opts: {
  provider: JsonRpcProvider;
  masterSigner: ReturnType<typeof deriveMasterSigner> & { provider: JsonRpcProvider };
  token: Contract;
  tokenDecimals: number;
  tokenAddress: string;
  to: string;
  parsed: WithdrawParsedArgs;
  log: (s: string) => void;
}): Promise<void> {
  const { provider, masterSigner, token, tokenDecimals, tokenAddress, to, parsed, log } = opts;
  const { dryRun } = parsed;

  log(
    `[withdraw] Master ${masterSigner.address} → ${to} (chain ${await provider.getNetwork().then(n => n.chainId)})`,
  );
  log(`[withdraw] ERC-20 token contract ${tokenAddress} (set JINN_TOKEN to override)`);

  if (parsed.jinnWei !== null || parsed.drainJinn) {
    let amount = parsed.jinnWei;
    if (parsed.drainJinn) {
      amount = await token.balanceOf(masterSigner.address);
      log(`[withdraw] Drain JINN: balance ${amount} (${tokenDecimals} decimals)`);
    }
    if (amount === null || amount <= 0n) {
      log('[withdraw] Skipping token transfer (zero amount).');
    } else {
      log(`[withdraw] Token transfer ${amount} wei` + (dryRun ? ' (dry-run)' : ''));
      if (!dryRun) {
        const tx = await token.transfer(to, amount);
        await tx.wait();
        log(`[withdraw]   tx ${tx.hash}`);
      }
    }
  }

  if (parsed.ethWei !== null || parsed.drainEth) {
    const cost = await estimateNativeTransferCostWei(provider);
    let value = parsed.ethWei;
    if (parsed.drainEth) {
      const bal = await provider.getBalance(masterSigner.address);
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
      const bal = await provider.getBalance(masterSigner.address);
      if (bal < value + cost) {
        throw new Error(
          `Insufficient ETH for transfer: need ${value + cost} wei (value + est. gas), have ${bal}`,
        );
      }
      log(
        `[withdraw] ETH transfer ${value} wei (${formatEther(value)} ETH)` + (dryRun ? ' (dry-run)' : ''),
      );
      if (!dryRun) {
        const tx = await masterSigner.sendTransaction({ to, value });
        await tx.wait();
        log(`[withdraw]   tx ${tx.hash}`);
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

  const chain: 'base' | 'base-sepolia' = config.network === 'testnet' ? 'base-sepolia' : 'base';
  const provider = new JsonRpcProvider(config.rpcUrl);
  const network = await provider.getNetwork();
  const chainConfig = getChainConfig(chain, {
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
  });
  if (Number(network.chainId) !== chainConfig.chainId) {
    throw new Error(
      `RPC chainId ${network.chainId} does not match expected ${chainConfig.chainId} for ${chain}.`,
    );
  }

  const store = new FleetStateStore(config.earningDir);
  if (!store.hasMnemonicKeystore()) {
    throw new Error(`No mnemonic keystore at ${store.dir}/master_keystore.json`);
  }

  const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), password);
  const masterSigner = deriveMasterSigner(mnemonic).connect(provider) as ReturnType<
    typeof deriveMasterSigner
  > & { provider: JsonRpcProvider };
  const fleet = await store.tryLoadExisting();

  if (fleet?.master_address) {
    const m = getAddress(fleet.master_address);
    const w = getAddress(masterSigner.address);
    if (m !== w) {
      throw new Error(`Keystore master ${w} does not match fleet state master ${m}`);
    }
  }

  const tokenAddress = resolveWithdrawTokenAddress(chain, config);
  const token = new Contract(tokenAddress, ERC20_ABI, masterSigner);
  let tokenDecimals = 18;
  try {
    tokenDecimals = Number(await token.decimals());
  } catch {
    // default 18
  }

  const to = parsed.to as `0x${string}`;

  if (parsed.sweepAgents) {
    await sweepAgentEoas({
      provider,
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
      provider,
      masterSigner,
      token,
      tokenDecimals,
      tokenAddress,
      to,
      parsed,
      log,
    });
  }

  log(parsed.dryRun ? '[withdraw] Dry-run complete.' : '[withdraw] Done.');
}
