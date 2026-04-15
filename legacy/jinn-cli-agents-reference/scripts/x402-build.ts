#!/usr/bin/env tsx
// @ts-nocheck
/**
 * x402 Build - Call the x402 Builder service
 * 
 * Pays the x402-builder endpoint using USDC from your operate-profile wallet,
 * which creates a GitHub repo and dispatches a Jinn workstream to build your service.
 * 
 * Usage:
 *   yarn x402:build --blueprint blueprints/x402-service-optimizer.json
 *   yarn x402:build --spec "Build a weather API with x402 payments"
 *   yarn x402:build --blueprint my-blueprint.json --name my-service
 *   yarn x402:build --dry-run --blueprint blueprints/x402-service-optimizer.json
 * 
 * Options:
 *   --blueprint     Path to blueprint JSON file (with assertions array)
 *   --spec          Freeform text specification (alternative to blueprint)
 *   --name          Optional service name
 *   --dry-run       Check balance without making payment
 *   --builder-url   Builder endpoint (default: https://x402-builder-production.up.railway.app)
 */

import 'dotenv/config';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createWalletClient, createPublicClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getServiceProfile } from 'jinn-node/env/operate-profile.js';
import { scriptLogger } from 'jinn-node/logging';

// USDC on Base mainnet
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const USDC_DECIMALS = 6;

// Minimal ERC20 ABI for balance check
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

interface Blueprint {
  assertions: Array<{
    id: string;
    assertion: string;
    examples: { do: string[]; dont: string[] };
    commentary: string;
  }>;
  context?: string;
}

async function loadBlueprint(path: string): Promise<Blueprint> {
  let blueprintPath = path;
  
  // Auto-append .json if needed
  if (!blueprintPath.endsWith('.json')) {
    blueprintPath = `${blueprintPath}.json`;
  }
  
  // Resolve relative to blueprints/ if no path separator
  if (!blueprintPath.includes('/')) {
    blueprintPath = join(process.cwd(), 'blueprints', blueprintPath);
  }

  const content = await readFile(blueprintPath, 'utf-8');
  const blueprint = JSON.parse(content) as Blueprint;
  
  if (!blueprint.assertions || !Array.isArray(blueprint.assertions)) {
    throw new Error('Blueprint must have an assertions array');
  }
  
  return blueprint;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('blueprint', { type: 'string', description: 'Path to blueprint JSON file' })
    .option('spec', { type: 'string', description: 'Freeform text specification' })
    .option('name', { type: 'string', description: 'Optional service name' })
    .option('dry-run', { type: 'boolean', description: 'Check balance without paying' })
    .option('builder-url', { 
      type: 'string', 
      default: 'https://x402-builder-production.up.railway.app',
      description: 'Builder endpoint URL' 
    })
    .check((argv) => {
      if (!argv.blueprint && !argv.spec) {
        throw new Error('Either --blueprint or --spec is required');
      }
      if (argv.blueprint && argv.spec) {
        throw new Error('Provide either --blueprint or --spec, not both');
      }
      return true;
    })
    .help()
    .parse();

  // Get wallet from operate-profile
  const profile = getServiceProfile();
  
  if (!profile.privateKey) {
    scriptLogger.error('No private key found in operate-profile. Run setup:service first.');
    process.exit(1);
  }

  // Create viem wallet client
  const account = privateKeyToAccount(profile.privateKey as `0x${string}`);
  
  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  scriptLogger.info({
    wallet: account.address,
    builderUrl: argv.builderUrl,
  }, 'Using operate-profile wallet');

  // Check USDC balance
  const usdcBalance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });

  const balanceFormatted = formatUnits(usdcBalance, USDC_DECIMALS);
  scriptLogger.info({ 
    usdcBalance: balanceFormatted,
    requiredMin: '0.001',
  }, 'USDC balance check');

  if (usdcBalance < 1000n) { // 0.001 USDC = 1000 units
    scriptLogger.error({
      balance: balanceFormatted,
      required: '0.001',
      wallet: account.address,
    }, 'Insufficient USDC balance');
    console.error(`\n❌ Insufficient USDC balance: ${balanceFormatted} USDC`);
    console.error(`   Required: 0.001 USDC`);
    console.error(`   Wallet: ${account.address}`);
    console.error(`\n   Send USDC to this address on Base mainnet.`);
    process.exit(1);
  }

  // Load blueprint if provided
  let blueprint: Blueprint | undefined;
  if (argv.blueprint) {
    try {
      blueprint = await loadBlueprint(argv.blueprint);
      scriptLogger.info({ 
        blueprintPath: argv.blueprint,
        assertionCount: blueprint.assertions.length,
      }, 'Loaded blueprint');
    } catch (e: any) {
      scriptLogger.error({ err: e }, 'Failed to load blueprint');
      console.error(`\n❌ Failed to load blueprint: ${e.message}`);
      process.exit(1);
    }
  }

  if (argv.dryRun) {
    scriptLogger.info('Dry run - not making payment');
    console.log('\n✅ Balance check passed');
    console.log(`   Wallet: ${account.address}`);
    console.log(`   USDC Balance: ${balanceFormatted}`);
    console.log(`   Would call: ${argv.builderUrl}/build`);
    if (blueprint) {
      console.log(`   Blueprint: ${argv.blueprint} (${blueprint.assertions.length} assertions)`);
    } else {
      console.log(`   Spec: ${argv.spec?.slice(0, 50)}...`);
    }
    return;
  }

  // Wrap fetch with x402 payment handling
  const fetchWithPay = wrapFetchWithPayment(fetch, walletClient);

  scriptLogger.info(
    blueprint 
      ? { blueprint: argv.blueprint, assertions: blueprint.assertions.length }
      : { spec: argv.spec?.slice(0, 50) + '...' },
    'Calling x402 Builder...'
  );

  try {
    // Build request body
    const requestBody: { spec?: string; blueprint?: Blueprint; name?: string } = {};
    
    if (blueprint) {
      requestBody.blueprint = blueprint;
    } else {
      requestBody.spec = argv.spec;
    }
    
    if (argv.name) {
      requestBody.name = argv.name;
    }

    const response = await fetchWithPay(`${argv.builderUrl}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Builder returned ${response.status}: ${error}`);
    }

    const result = await response.json() as {
      jobId: string;
      jobDefinitionId: string;
      repoUrl: string;
      statusUrl: string;
      explorerUrl: string;
    };

    scriptLogger.info(result, 'Build dispatched successfully');

    console.log('\n✅ Build dispatched!');
    console.log(`   Job ID: ${result.jobId}`);
    console.log(`   Repo: ${result.repoUrl}`);
    console.log(`   Status: ${result.statusUrl}`);
    console.log(`   Explorer: ${result.explorerUrl}`);
    console.log(`\n   Run worker: yarn dev:mech --workstream=${result.jobId}`);

  } catch (error: any) {
    scriptLogger.error({ err: error }, 'Build request failed');
    
    if (error.message?.includes('insufficient')) {
      console.error('\n❌ Insufficient funds for payment');
      console.error(`   Make sure you have enough USDC and ETH for gas on Base.`);
    } else {
      console.error(`\n❌ Build failed: ${error.message}`);
    }
    process.exit(1);
  }
}

main();
