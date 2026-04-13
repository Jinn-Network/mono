#!/usr/bin/env node
/**
 * Operator withdraw: send JINN (ERC-20) and/or native ETH from the fleet master EOA to --to.
 *
 * Uses the same HD mnemonic keystore as earning bootstrap (~/.jinn-client/earning/master_keystore.json).
 * Password: JINN_PASSWORD (env-only, same as npm start).
 *
 * ERC-20 token:
 *   - JINN_TOKEN env overrides the default.
 *   - Otherwise uses the chain "staking token" from earning config (on Base Sepolia this is bridged JINN;
 *     on Base mainnet the default is OLAS — set JINN_TOKEN when your JINN address is known).
 *
 * Usage:
 *   JINN_PASSWORD=secret npm run withdraw -- --to 0x... --amount 10
 *   JINN_PASSWORD=secret npm run withdraw -- --to 0x... --jinn-amount 10
 *   JINN_PASSWORD=secret npm run withdraw -- --to 0x... --eth-amount 0.05 --dry-run
 *   JINN_PASSWORD=secret npm run withdraw -- --to 0x... --drain-jinn --drain-eth --yes
 *   JINN_PASSWORD=secret npm run withdraw -- --to 0x... --sweep-agents
 *
 *   npm run withdraw -- --help
 */

import { config as dotenvConfig } from 'dotenv';
import { Contract, JsonRpcProvider, formatEther, getAddress, isAddress } from 'ethers';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from '../src/config.js';
import { getChainConfig } from '../src/earning/contracts.js';
import { FleetStateStore } from '../src/earning/store.js';
import { decryptMnemonic, deriveAgentSigner, deriveMasterSigner } from '../src/earning/wallet.js';
import {
  parseWithdrawArgv,
  validateWithdrawArgs,
  withdrawArgsNeedMasterTransfer,
  type WithdrawParsedArgs,
} from '../src/withdraw/args.js';

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
] as const;

const ETH_CONFIRM_WEI = 5n * 10n ** 16n; // 0.05 ETH
const JINN_CONFIRM_WEI = 1000n * 10n ** 18n; // 1000 tokens @ 18 decimals

function printHelp(): void {
  console.log(`
Operator withdraw — master EOA and optional agent ETH sweep

  JINN_PASSWORD is required (same keystore password as npm start).

Options:
  --to <address>           Recipient (required for transfers / sweep)

  JINN / ERC-20 (18 decimals by default; decimals() on-chain for drain/balance):
  --jinn-amount <decimal>    Token amount (human, e.g. 12.5)
  --amount <decimal>         Same as --jinn-amount (JINN / configured ERC-20)
  --jinn-wei <wei>           Token amount in wei (integer string)
  --drain-jinn               Send full token balance from master

  Native ETH:
  --eth-amount <decimal>     ETH amount (e.g. 0.1)
  --eth-wei <wei>            ETH in wei
  --drain-eth                Send maximum ETH after gas reserve (--master-gas-reserve-wei)

  --sweep-agents             Send spare ETH from derived agent EOAs (fleet state) to --to
  --min-sweep-wei <wei>      Minimum balance above gas to sweep per agent (default: 1e15)

  --master-gas-reserve-wei   Wei to keep on master when using --drain-eth (default: 2.5e15)

  --dry-run                  Print planned actions; no transactions
  --yes                      Skip interactive confirmation
  --config <path>            Same as npm start

  -h, --help                 Show this help

Environment:
  JINN_TOKEN                 Optional ERC-20 contract address (0x...) for JINN/staking token transfers
`);
}

function resolveTokenAddress(
  chain: 'base' | 'base-sepolia',
  config: ReturnType<typeof loadConfig>,
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

async function confirmOrThrow(message: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new Error('Non-interactive terminal: repeat with --yes to confirm, or use --dry-run.');
  }
  const ok = await new Promise<boolean>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} [y/N] `, ans => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes');
    });
  });
  if (!ok) {
    throw new Error('Aborted by operator.');
  }
}

function needsInteractiveConfirm(p: WithdrawParsedArgs, opts: { sweepWouldSend: boolean }): boolean {
  if (p.dryRun || p.yes) return false;
  if (p.drainJinn || p.drainEth) return true;
  if (opts.sweepWouldSend && p.sweepAgents) return true;
  if (p.ethWei !== null && p.ethWei >= ETH_CONFIRM_WEI) return true;
  if (p.jinnWei !== null && p.jinnWei >= JINN_CONFIRM_WEI) return true;
  return false;
}

async function estimateNativeTransferCostWei(provider: JsonRpcProvider): Promise<bigint> {
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? 0n;
  if (gasPrice === 0n) {
    throw new Error('Could not resolve gas price for fee estimate');
  }
  const gasLimit = 21_000n;
  return gasLimit * gasPrice * 3n / 2n; // 1.5x buffer
}

async function main(): Promise<void> {
  let parsed: WithdrawParsedArgs;
  try {
    parsed = parseWithdrawArgv(process.argv.slice(2));
  } catch (e) {
    console.error(`[withdraw] ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  try {
    validateWithdrawArgs(parsed);
  } catch (e) {
    console.error(`[withdraw] ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    return;
  }

  const password = process.env['JINN_PASSWORD'];
  if (!password) {
    console.error('[withdraw] Fatal: JINN_PASSWORD environment variable is required.');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(getConfigPathFromArgs());
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
    console.error(
      `[withdraw] RPC chainId ${network.chainId} does not match expected ${chainConfig.chainId} for ${chain}.`,
    );
    process.exitCode = 1;
    return;
  }

  const store = new FleetStateStore(config.earningDir);
  if (!store.hasMnemonicKeystore()) {
    console.error(`[withdraw] No mnemonic keystore at ${store.dir}/master_keystore.json`);
    process.exitCode = 1;
    return;
  }

  const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), password);
  const masterSigner = deriveMasterSigner(mnemonic).connect(provider);
  const fleet = await store.tryLoadExisting();

  if (fleet?.master_address) {
    const m = getAddress(fleet.master_address);
    const w = getAddress(masterSigner.address);
    if (m !== w) {
      console.error(`[withdraw] Keystore master ${w} does not match fleet state master ${m}`);
      process.exitCode = 1;
      return;
    }
  }

  const tokenAddress = resolveTokenAddress(chain, config);
  const token = new Contract(tokenAddress, ERC20_ABI, masterSigner);
  let tokenDecimals = 18;
  try {
    tokenDecimals = Number(await token.decimals());
  } catch {
    // default 18
  }

  const to = parsed.to as `0x${string}`;
  const sweepWouldSend = await computeSweepWouldSend(
    provider,
    mnemonic,
    fleet,
    to,
    parsed.minSweepWei,
  );

  if (needsInteractiveConfirm(parsed, { sweepWouldSend })) {
    await confirmOrThrow(
      'This operation may move large balances or drain wallets. Proceed?',
      parsed.yes,
    );
  }

  if (parsed.sweepAgents) {
    await sweepAgentEoas({
      provider,
      mnemonic,
      fleet,
      to,
      dryRun: parsed.dryRun,
      minSweepWei: parsed.minSweepWei,
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
    });
  }

  console.log(parsed.dryRun ? '[withdraw] Dry-run complete.' : '[withdraw] Done.');
}

async function computeSweepWouldSend(
  provider: JsonRpcProvider,
  mnemonic: string,
  fleet: Awaited<ReturnType<FleetStateStore['tryLoadExisting']>>,
  to: string,
  minSweepWei: bigint,
): Promise<boolean> {
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
}): Promise<void> {
  const { provider, mnemonic, fleet, to, dryRun, minSweepWei } = opts;
  if (!fleet?.services.length) {
    console.log('[withdraw] No services in fleet state; nothing to sweep.');
    return;
  }

  const gasReserve = await estimateNativeTransferCostWei(provider);

  for (const svc of fleet.services) {
    const signer = deriveAgentSigner(mnemonic, svc.index).connect(provider);
    const derived = getAddress(signer.address);
    const recorded = getAddress(svc.agent_address);
    if (derived !== recorded) {
      console.warn(
        `[withdraw] Skip service ${svc.index}: derived agent ${derived} != state ${recorded}`,
      );
      continue;
    }

    const bal = await provider.getBalance(derived);
    const sendWei = bal > gasReserve ? bal - gasReserve : 0n;
    if (sendWei <= minSweepWei) {
      console.log(
        `[withdraw] Agent ${svc.index} ${derived}: balance ${bal} wei — below sweep threshold, skip`,
      );
      continue;
    }

    console.log(
      `[withdraw] Agent ${svc.index} ${derived}: sweep ${sendWei} wei to ${to}` +
        (dryRun ? ' (dry-run)' : ''),
    );
    if (!dryRun) {
      const tx = await signer.sendTransaction({ to, value: sendWei });
      await tx.wait();
      console.log(`[withdraw]   tx ${tx.hash}`);
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
}): Promise<void> {
  const { provider, masterSigner, token, tokenDecimals, tokenAddress, to, parsed } = opts;
  const { dryRun } = parsed;

  console.log(`[withdraw] Master ${masterSigner.address} → ${to} (chain ${await provider.getNetwork().then(n => n.chainId)})`);
  console.log(
    `[withdraw] ERC-20 token contract ${tokenAddress} (set JINN_TOKEN to override)`,
  );

  if (parsed.jinnWei !== null || parsed.drainJinn) {
    let amount = parsed.jinnWei;
    if (parsed.drainJinn) {
      amount = await token.balanceOf(masterSigner.address);
      console.log(`[withdraw] Drain JINN: balance ${amount} (${tokenDecimals} decimals)`);
    }
    if (amount === null || amount <= 0n) {
      console.log('[withdraw] Skipping token transfer (zero amount).');
    } else {
      console.log(`[withdraw] Token transfer ${amount} wei` + (dryRun ? ' (dry-run)' : ''));
      if (!dryRun) {
        const tx = await token.transfer(to, amount);
        await tx.wait();
        console.log(`[withdraw]   tx ${tx.hash}`);
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
      console.log(
        `[withdraw] Drain ETH: balance ${bal} wei, reserve ${reserve} wei, est. gas ${cost} wei, send ${value} wei`,
      );
    }
    if (value === null || value <= 0n) {
      console.log('[withdraw] Skipping ETH transfer (zero amount).');
    } else {
      const bal = await provider.getBalance(masterSigner.address);
      if (bal < value + cost) {
        throw new Error(
          `Insufficient ETH for transfer: need ${value + cost} wei (value + est. gas), have ${bal}`,
        );
      }
      console.log(
        `[withdraw] ETH transfer ${value} wei (${formatEther(value)} ETH)` + (dryRun ? ' (dry-run)' : ''),
      );
      if (!dryRun) {
        const tx = await masterSigner.sendTransaction({ to, value });
        await tx.wait();
        console.log(`[withdraw]   tx ${tx.hash}`);
      }
    }
  }
}

main().catch(e => {
  console.error('[withdraw]', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
