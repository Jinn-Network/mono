#!/usr/bin/env tsx
/**
 * Add Service - Provision an additional OLAS service for multi-service rotation
 *
 * Usage: yarn service:add [--chain=<network>] [--staking-contract <address>|--staking-contract=<address>] [--unattended] [--no-mech] [--dry-run]
 *
 * Prerequisites:
 * - OPERATE_PASSWORD env var set
 * - RPC_URL env var set
 * - Existing Master EOA + Master Safe (from initial setup)
 *
 * This creates a new service under the existing Master EOA/Safe using the
 * same chain/staking/mech defaults as setup (or explicit CLI overrides). The
 * new service gets its own agent key, service NFT, and service Safe.
 */

import 'dotenv/config';
import { promises as fsPromises } from 'fs';
import { join } from 'path';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';
import { createDefaultServiceConfig, SERVICE_CONSTANTS } from '../../src/worker/config/ServiceConfig.js';
import { enableMechMarketplaceInConfig, DEFAULT_MECH_DELIVERY_RATE } from '../../src/worker/config/MechConfig.js';
import { listServiceConfigs, cleanupUndeployedConfigs } from '../../src/worker/ServiceConfigReader.js';
import { printHeader, printStep, printFundingRequirements, printSuccess, printError } from '../../src/setup/display.js';
import { ethers } from 'ethers';
import { getMechChainConfig } from '../../src/env/operate-profile.js';

const OLAS_TOKEN_BASE = '0x54330d28ca3357F294334BDC454a032e7f353416';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const STAKING_ABI = ['function getServiceIds() view returns (uint256[])'];

type SupportedChain = 'base' | 'gnosis' | 'mode' | 'optimism';

function isSupportedChain(value: string): value is SupportedChain {
  return value === 'base' || value === 'gnosis' || value === 'mode' || value === 'optimism';
}

function parseArgs(): {
  chain?: SupportedChain;
  stakingContract?: string;
  dryRun: boolean;
  noMech: boolean;
  unattended: boolean;
  mechMarketplace?: string;
  mechPrice?: string;
  count: number;
} {
  const args = process.argv.slice(2);
  let chain: SupportedChain | undefined;
  let stakingContract: string | undefined;
  let dryRun = false;
  let noMech = false;
  let unattended = false;
  let mechMarketplace: string | undefined;
  let mechPrice: string | undefined;
  let count = 1;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--count=')) {
      count = parseInt(args[i].slice('--count='.length), 10);
      if (isNaN(count) || count < 1) {
        printError('--count must be a positive integer');
        process.exit(1);
      }
    } else if (args[i].startsWith('--chain=')) {
      const candidate = args[i].slice('--chain='.length);
      if (isSupportedChain(candidate)) {
        chain = candidate;
      } else {
        printError(`Invalid --chain value: ${candidate}. Supported: base, gnosis, mode, optimism`);
        process.exit(1);
      }
    } else if (args[i].startsWith('--staking-contract=')) {
      stakingContract = args[i].slice('--staking-contract='.length);
    } else if (args[i] === '--staking-contract' && args[i + 1]) {
      stakingContract = args[++i];
    } else if (args[i] === '--mech-marketplace' && args[i + 1]) {
      mechMarketplace = args[++i];
    } else if (args[i] === '--mech-price' && args[i + 1]) {
      mechPrice = args[++i];
    } else if (args[i] === '--unattended') {
      unattended = true;
    } else if (args[i] === '--no-mech') {
      noMech = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { chain, stakingContract, dryRun, noMech, unattended, mechMarketplace, mechPrice, count };
}

async function main() {
  const {
    chain: chainArg,
    stakingContract: stakingContractArg,
    dryRun,
    noMech,
    unattended,
    mechMarketplace,
    mechPrice,
    count,
  } = parseArgs();

  printHeader(count > 1 ? `Add OLAS Services (batch: ${count})` : 'Add OLAS Service');

  // --- Preflight checks ---
  const password = process.env.OPERATE_PASSWORD;
  const rpcUrl = process.env.RPC_URL;

  if (!password) {
    printError('OPERATE_PASSWORD environment variable is required');
    process.exit(1);
  }
  if (!rpcUrl) {
    printError('RPC_URL environment variable is required');
    process.exit(1);
  }

  const resolvedChain = chainArg || getMechChainConfig() || 'base';
  if (!isSupportedChain(resolvedChain)) {
    printError(`Invalid chain from configuration: ${resolvedChain}. Supported: base, gnosis, mode, optimism`);
    process.exit(1);
  }
  const chain = resolvedChain;
  const envAttended = typeof process.env.ATTENDED === 'string'
    ? process.env.ATTENDED.toLowerCase() === 'true'
    : undefined;
  const attendedMode = unattended ? false : (envAttended ?? false);

  // Keep add-service defaults aligned with setup CLI.
  // DEFAULT_MECH_DELIVERY_RATE = 99 — must match ecosystem standard or marketplace rejects delivery.
  const mechRequestPrice = mechPrice || DEFAULT_MECH_DELIVERY_RATE;
  const defaultStakingContract = SERVICE_CONSTANTS.DEFAULT_STAKING_PROGRAM_ID;
  const stakingContract = stakingContractArg || process.env.STAKING_CONTRACT || defaultStakingContract;

  const mechMarketplaceAddresses: Record<SupportedChain, string> = {
    base: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020',
    gnosis: '0x0000000000000000000000000000000000000000',
    mode: '0x0000000000000000000000000000000000000000',
    optimism: '0x0000000000000000000000000000000000000000',
  };
  const resolvedMechMarketplace = mechMarketplace || mechMarketplaceAddresses[chain];

  printStep('active', 'Starting middleware daemon...');

  const wrapper = await OlasOperateWrapper.create({
    rpcUrl,
    defaultEnv: {
      operatePassword: password,
      stakingProgram: 'custom_staking',
      chainLedgerRpc: { [chain]: rpcUrl },
      attended: attendedMode,
    },
  });

  try {
    await wrapper.startServer();

    // Login
    const loginResult = await wrapper.login(password);
    if (!loginResult.success) {
      // Try setup if login fails (first time)
      const setupResult = await wrapper.setupUserAccount(password);
      if (!setupResult.success && !setupResult.error?.includes('Account already exists')) {
        printError(`Authentication failed: ${setupResult.error}`);
        process.exit(1);
      }
    }
    printStep('done', 'Middleware daemon started');

    // Verify wallet exists
    printStep('active', 'Checking wallet...');
    const walletInfo = await wrapper.getWalletInfo();
    if (!walletInfo.success || !walletInfo.wallets?.length) {
      printError('No wallet found. Run initial setup first (yarn setup).');
      process.exit(1);
    }
    const masterEoa = walletInfo.wallets[0].address;
    printStep('done', 'Wallet found', `Master EOA: ${masterEoa}`);

    // Verify Master Safe exists
    printStep('active', 'Checking Master Safe...');
    const masterSafe = await wrapper.getExistingSafeForChain(chain);
    if (!masterSafe) {
      printError(`No Master Safe found on ${chain}. Run initial setup first (yarn setup).`);
      process.exit(1);
    }
    printStep('done', 'Master Safe found', `Address: ${masterSafe}`);

    // Clean up stale configs from previous interrupted runs
    const middlewarePath = wrapper.getMiddlewarePath();
    printStep('active', 'Cleaning up stale configs...');
    const { removed } = await cleanupUndeployedConfigs(middlewarePath);
    if (removed.length > 0) {
      printStep('done', `Removed ${removed.length} stale config(s)`, removed.join(', '));
    } else {
      printStep('done', 'No stale configs found');
    }

    // List existing services
    printStep('active', 'Listing existing services...');
    const existingServices = await listServiceConfigs(middlewarePath);
    printStep('done', `Found ${existingServices.length} existing service(s)`);

    for (const svc of existingServices) {
      console.log(`      - ${svc.serviceConfigId} (service #${svc.serviceId ?? 'N/A'}, mech: ${svc.mechContractAddress ?? 'none'})`);
    }

    console.log(`\n  Chain: ${chain}`);
    console.log(`  Attended mode: ${attendedMode ? 'ENABLED' : 'DISABLED'}`);
    console.log(`  Staking contract: ${stakingContract}`);
    if (!noMech) {
      console.log(`  Mech marketplace: ${resolvedMechMarketplace}`);
      console.log(`  Mech request price: ${mechRequestPrice} wei`);
    }

    // Preflight: check staking slots
    printStep('active', 'Checking staking contract slots...');
    try {
      const provider = createRpcProvider(rpcUrl);
      const stakingContractInstance = new ethers.Contract(stakingContract, STAKING_ABI, provider);
      const serviceIds = await stakingContractInstance.getServiceIds();
      console.log(`      Staked services: ${serviceIds.length}`);
      // Note: we don't know maxNumServices without the full ABI, just warn if many
      if (serviceIds.length >= 10) {
        console.log(`      Warning: contract has ${serviceIds.length} services staked, may be near capacity`);
      }
      printStep('done', 'Staking contract accessible');
    } catch {
      console.log('      Could not query staking contract (will proceed anyway)');
      printStep('done', 'Staking contract check skipped');
    }

    // Preflight: check OLAS balance on Master Safe
    printStep('active', 'Checking Master Safe OLAS balance...');
    try {
      const provider = createRpcProvider(rpcUrl);
      const olasContract = new ethers.Contract(OLAS_TOKEN_BASE, ERC20_ABI, provider);
      const olasBalance = await olasContract.balanceOf(masterSafe);
      const formatted = ethers.formatEther(olasBalance);
      console.log(`      OLAS balance: ${formatted}`);
      printStep('done', 'Balance checked');
    } catch {
      console.log('      Could not query OLAS balance');
      printStep('done', 'Balance check skipped');
    }

    // --- Batch loop ---
    const batchResults: Array<{ index: number; configId?: string; safe?: string; error?: string }> = [];

    for (let batchIdx = 0; batchIdx < count; batchIdx++) {
      if (count > 1) {
        console.log(`\n  \u2500\u2500 Service ${batchIdx + 1} of ${count} \u2500\u2500\n`);
      }

      let batchConfigId: string | undefined;
      let batchSafe: string | undefined;

    try {
    // --- Create service config ---
    printStep('active', 'Creating service configuration...');
    const serviceName = `jinn-service-${Date.now()}`;
    const serviceConfig = createDefaultServiceConfig({
      name: serviceName,
      home_chain: chain,
    });

    // Match setup defaults for chain-specific service configuration.
    serviceConfig.configurations[chain].staking_program_id = stakingContract;
    serviceConfig.configurations[chain].use_staking = true;
    serviceConfig.configurations[chain].rpc = rpcUrl;

    // Enable mech marketplace (skip with --no-mech to save VNet write quota)
    if (!noMech) {
      enableMechMarketplaceInConfig(
        serviceConfig,
        resolvedMechMarketplace,
        mechRequestPrice,
      );
    }

    printStep('done', 'Service configuration created');

    // --- Create service via middleware API ---
    printStep('active', 'Creating service in middleware...');
    const createResult = await wrapper.createService(serviceConfig);
    if (!createResult.success) {
      printError(`Service creation failed: ${createResult.error}`);
      process.exit(1);
    }

    const serviceConfigId = createResult.service?.service_config_id;
    if (!serviceConfigId) {
      printError('Service creation succeeded but no service_config_id returned');
      process.exit(1);
    }
    printStep('done', 'Service created', `Config ID: ${serviceConfigId}`);

    // Clean up partial config if interrupted before deployment completes
    const cleanupPartial = async () => {
      console.log('\n  Cleaning up partial service config...');
      try {
        const servicePath = join(middlewarePath, '.operate', 'services', serviceConfigId);
        await fsPromises.rm(servicePath, { recursive: true, force: true });
        console.log('  Cleaned up.');
      } catch {}
      process.exit(130);
    };
    process.on('SIGINT', cleanupPartial);
    process.on('SIGTERM', cleanupPartial);

    if (dryRun) {
      console.log('\n  --dry-run: Service config created but not deployed.');
      console.log(`  Config ID: ${serviceConfigId}`);
      console.log('  Run without --dry-run to fund and deploy.\n');
      return;
    }

    // --- Show funding requirements ---
    printStep('active', 'Fetching funding requirements...');
    const fundingResult = await wrapper.getFundingRequirements(serviceConfigId);
    if (!fundingResult.success) {
      printError(`Failed to fetch funding requirements: ${fundingResult.error}`);
      process.exit(1);
    }

    const requirements = fundingResult.requirements || {};
    const refill = requirements.refill_requirements?.[chain] || {};

    // Format funding requirements for display
    const displayReqs: Array<{ purpose: string; address: string; amount: string; token: string }> = [];
    const zeroAddress = '0x0000000000000000000000000000000000000000';

    for (const [addr, tokens] of Object.entries<any>(refill)) {
      const ethWei = BigInt(tokens?.[zeroAddress] || '0');
      const olasWei = BigInt(tokens?.[OLAS_TOKEN_BASE] || '0');

      if (ethWei > 0n) {
        displayReqs.push({
          purpose: addr.toLowerCase() === masterSafe.toLowerCase() ? 'Master Safe (gas)' : `Address ${addr.slice(0, 10)}...`,
          address: addr,
          amount: ethers.formatEther(ethWei),
          token: 'ETH',
        });
      }
      if (olasWei > 0n) {
        displayReqs.push({
          purpose: addr.toLowerCase() === masterSafe.toLowerCase() ? 'Master Safe (staking bond)' : `Address ${addr.slice(0, 10)}...`,
          address: addr,
          amount: ethers.formatEther(olasWei),
          token: 'OLAS',
        });
      }
    }

    if (displayReqs.length > 0) {
      printFundingRequirements(displayReqs);
    } else {
      printStep('done', 'No additional funding required');
    }

    // --- Check if funding is needed ---
    const allowStart = requirements.allow_start_agent === true;
    const isRefillRequired = requirements.is_refill_required === true;

    if (!allowStart || isRefillRequired) {
      console.log('\n  Fund the addresses above, then re-run this command to continue deployment.\n');
      return;
    }

    // --- Deploy service ---
    printStep('active', 'Deploying service on-chain...');
    const startResult = await wrapper.startService(serviceConfigId);
    if (!startResult.success) {
      printError(`Service deployment failed: ${startResult.error}`);
      process.exit(1);
    }

    // Wait for deployment
    const deployTimeoutMs = 10 * 60 * 1000;
    const deployStart = Date.now();
    let serviceSafe: string | undefined;

    while (Date.now() - deployStart < deployTimeoutMs) {
      const dep = await wrapper.getDeployment(serviceConfigId);
      if (dep.success && dep.deployment?.status === 3) {
        // Extract service safe from deployment
        const chainData = startResult.service?.chain_configs?.[chain]?.chain_data;
        serviceSafe = chainData?.multisig;
        break;
      }
      await new Promise(r => setTimeout(r, 5000));
    }

    printStep('done', 'Service deployed');

    // Deployment complete — no longer need cleanup handler
    process.removeListener('SIGINT', cleanupPartial);
    process.removeListener('SIGTERM', cleanupPartial);

    // --- Show result ---
    const totalServices = existingServices.length + batchIdx + 1;
    printSuccess({
      serviceConfigId,
      serviceSafeAddress: serviceSafe,
    });

    if (count === 1) {
      console.log(`  Total services: ${totalServices}`);
      console.log('');
      if (totalServices >= 2) {
        console.log('  To enable multi-service rotation:');
        console.log('    WORKER_MULTI_SERVICE=true');
        console.log('');
      }
    }

    batchConfigId = serviceConfigId;
    batchSafe = serviceSafe;

    } catch (batchError) {
      const msg = batchError instanceof Error ? batchError.message : String(batchError);
      printError(`Service ${batchIdx + 1} failed: ${msg}`);
      batchResults.push({ index: batchIdx + 1, error: msg });
      if (count === 1) process.exit(1);
      continue;
    }

    batchResults.push({ index: batchIdx + 1, configId: batchConfigId, safe: batchSafe });

    // Brief pause between services in batch mode
    if (count > 1 && batchIdx < count - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
    } // end batch loop

    // Batch summary
    if (count > 1) {
      const succeeded = batchResults.filter(r => !r.error);
      const failed = batchResults.filter(r => r.error);
      console.log(`\n  \u2500\u2500 Batch Summary \u2500\u2500\n`);
      console.log(`  ${succeeded.length}/${count} services provisioned successfully`);
      for (const r of succeeded) {
        console.log(`  [+] Service ${r.index}: ${r.configId}`);
      }
      for (const r of failed) {
        console.log(`  [-] Service ${r.index}: FAILED — ${r.error}`);
      }
      const totalServices = existingServices.length + succeeded.length;
      console.log(`\n  Total services: ${totalServices}`);
      if (totalServices >= 2) {
        console.log('  To enable multi-service rotation: WORKER_MULTI_SERVICE=true');
      }
      console.log('');
      if (failed.length > 0) process.exit(1);
    }

  } finally {
    await wrapper.stopServer();
  }
}

main().catch(error => {
  printError(error.message);
  process.exit(1);
});
