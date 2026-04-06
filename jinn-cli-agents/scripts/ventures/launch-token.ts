#!/usr/bin/env tsx
/**
 * Launch a venture token via Doppler on Base
 *
 * Deploys a multicurve auction token paired against WETH (default) or OLAS on Base.
 * Updates the venture record in Supabase with token details.
 *
 * Token allocation (10/10/80):
 *   - 10% (100M) → Doppler bonding curve (price discovery)
 *   - 10% (100M) → Safe address (insiders, vested)
 *   - 80% (800M) → Governance contract (treasury/rewards, controlled by Safe)
 *
 * Usage:
 *   yarn tsx scripts/ventures/launch-token.ts \
 *     --venture-id "<uuid>" \
 *     --name "Growth Agency Token" \
 *     --symbol "GROWTH" \
 *     --safe-address "0x..."
 */

import { createPublicClient, createWalletClient, http, parseAbi, parseEther } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { DopplerSDK, MulticurveBuilder } from '@whetstone-research/doppler-sdk';
import { updateVenture } from './update.js';
import { getMasterPrivateKey } from '../../env/operate-profile.js';
import dotenv from 'dotenv';

dotenv.config();

// Supported numeraire tokens on Base
const WETH_BASE_ADDRESS = '0x4200000000000000000000000000000000000006' as const;
const OLAS_BASE_ADDRESS = '0x54330d28ca3357F294334BDC454a032e7f353416' as const;

const NUMERAIRE_OPTIONS: Record<string, `0x${string}`> = {
  weth: WETH_BASE_ADDRESS,
  eth: WETH_BASE_ADDRESS,  // alias
  olas: OLAS_BASE_ADDRESS,
};

const NUMERAIRE_NAMES: Record<string, string> = {
  [WETH_BASE_ADDRESS]: 'WETH',
  [OLAS_BASE_ADDRESS]: 'OLAS',
};

// Doppler Airlock on Base — holds asset data for all launched tokens
const AIRLOCK_ADDRESS = '0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12' as const;

const airlockAbi = parseAbi([
  'function getAssetData(address asset) view returns (address numeraire, address timelock, address governance, address liquidityMigrator, address poolInitializer, address pool, address migrationPool, uint256 numTokensToSell, uint256 totalSupply, address integrator)',
]);

// Token allocation: 10/10/80
const TOTAL_SUPPLY = parseEther('1000000000');              // 1B
const TOKENS_FOR_PRICE_DISCOVERY = parseEther('100000000'); // 10% → bonding curve
const TOKENS_FOR_INSIDERS = parseEther('100000000');        // 10% → vested to Safe
// Remaining 80% (800M) → governance contract (treasury, controlled by Safe)

export interface LaunchTokenArgs {
  ventureId: string;
  name: string;
  symbol: string;
  safeAddress: string;
  numeraire?: string;  // 'weth' (default), 'olas', or a custom address
  tokenUri?: string;
  rpcUrl?: string;
}

/**
 * Resolve deployer private key.
 * Fallback chain: master EOA (via operate-profile) → DEPLOYER_PRIVATE_KEY env → error
 */
function resolvePrivateKey(): `0x${string}` {
  const masterKey = getMasterPrivateKey();
  if (masterKey) {
    return masterKey as `0x${string}`;
  }

  const envKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (envKey) {
    return envKey as `0x${string}`;
  }

  throw new Error(
    'No deployer key found. Ensure operate-profile + OPERATE_PASSWORD are configured, or set DEPLOYER_PRIVATE_KEY env var.'
  );
}

export async function launchToken(args: LaunchTokenArgs) {
  const { ventureId, name, symbol, safeAddress, tokenUri } = args;
  const rpcUrl = args.rpcUrl || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

  // Resolve numeraire: default to WETH for Doppler app compatibility
  const numeraireInput = args.numeraire?.toLowerCase() || 'weth';
  const numeraireAddress = NUMERAIRE_OPTIONS[numeraireInput] || (numeraireInput as `0x${string}`);
  const numeraireName = NUMERAIRE_NAMES[numeraireAddress] || numeraireAddress;

  const privateKey = resolvePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  console.log(`Launching token ${symbol} for venture ${ventureId}...`);
  console.log(`  Name: ${name}`);
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Safe: ${safeAddress}`);
  console.log(`  Numeraire: ${numeraireName} (${numeraireAddress})`);
  console.log(`  Total supply: 1B`);
  console.log(`  Price discovery: 100M (10%) → bonding curve`);
  console.log(`  Insiders: 100M (10%) → vested to Safe`);
  console.log(`  Treasury: 800M (80%) → governance contract (Safe-controlled)`);

  // Initialize Doppler SDK
  const sdk = new DopplerSDK({
    publicClient,
    walletClient,
    chainId: base.id,
  });

  // Build multicurve params via MulticurveBuilder (handles pool/curve defaults)
  // TokenFactory80: 80% → governance (Governor+Timelock), 20% → Airlock
  // Airlock distributes: numTokensToSell → bonding curve, vesting → Safe
  const params = new MulticurveBuilder(base.id)
    .tokenConfig({
      name,
      symbol,
      tokenURI: tokenUri || '',
    })
    .saleConfig({
      initialSupply: TOTAL_SUPPLY,
      numTokensToSell: TOKENS_FOR_PRICE_DISCOVERY,
      numeraire: numeraireAddress,
    })
    .withMarketCapPresets()  // default 3-curve pool config (low/medium/high market cap tiers)
    .withVesting({
      recipients: [safeAddress as `0x${string}`],
      amounts: [TOKENS_FOR_INSIDERS],
    })
    .withGovernance({
      type: 'default' as const,
    })
    .withMigration({
      type: 'uniswapV2' as const,
    })
    .withUserAddress(account.address)
    .build();

  // Simulate first to get predicted addresses
  console.log('\nSimulating multicurve creation...');
  const simResult = await sdk.factory.simulateCreateMulticurve(params);

  console.log(`  Predicted token: ${simResult.tokenAddress}`);
  console.log(`  Predicted pool ID: ${simResult.poolId}`);

  // Execute the actual creation
  console.log('\nSubmitting multicurve creation...');
  const result = await sdk.factory.createMulticurve(params);

  console.log('\nToken launched successfully!');
  console.log(`  Token address: ${result.tokenAddress}`);
  console.log(`  Pool ID: ${result.poolId}`);
  console.log(`  TX hash: ${result.transactionHash}`);

  // Read full asset data from Airlock to get all contract addresses
  console.log('\nReading asset data from Airlock...');
  const assetData = await publicClient.readContract({
    address: AIRLOCK_ADDRESS,
    abi: airlockAbi,
    functionName: 'getAssetData',
    args: [result.tokenAddress as `0x${string}`],
  });

  const [numeraire, timelock, governance, liquidityMigrator, poolInitializer, pool, migrationPool] = assetData;
  console.log(`  Governor: ${governance}`);
  console.log(`  Timelock: ${timelock}`);
  console.log(`  Pool Initializer: ${poolInitializer}`);
  console.log(`  Migration Pool: ${migrationPool}`);
  console.log(`  Liquidity Migrator: ${liquidityMigrator}`);

  // Update venture record with token details + all on-chain addresses
  console.log('\nUpdating venture record in Supabase...');

  await updateVenture({
    id: ventureId,
    tokenAddress: result.tokenAddress,
    tokenSymbol: symbol,
    tokenName: name,
    tokenLaunchPlatform: 'doppler',
    governanceAddress: governance,
    poolAddress: poolInitializer,
    tokenMetadata: {
      poolId: result.poolId,
      safeAddress,
      totalSupply: '1000000000',
      priceDiscoveryTokens: '100000000',
      insiderTokens: '100000000',
      treasuryTokens: '800000000',
      numeraire,
      transactionHash: result.transactionHash,
      launchedAt: new Date().toISOString(),
      // On-chain contract addresses from Airlock getAssetData
      governor: governance,
      timelock,
      liquidityMigrator,
      poolInitializer,
      migrationPool,
      integrator: assetData[9], // 10th return value
    },
  });

  console.log('Venture record updated.');

  return {
    tokenAddress: result.tokenAddress,
    poolId: result.poolId,
    transactionHash: result.transactionHash,
  };
}

// ============================================================================
// CLI Interface
// ============================================================================

function parseArgs(): LaunchTokenArgs {
  const args = process.argv.slice(2);
  const result: Partial<LaunchTokenArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--venture-id':
        result.ventureId = next;
        i++;
        break;
      case '--name':
        result.name = next;
        i++;
        break;
      case '--symbol':
        result.symbol = next;
        i++;
        break;
      case '--safe-address':
        result.safeAddress = next;
        i++;
        break;
      case '--numeraire':
        result.numeraire = next;
        i++;
        break;
      case '--token-uri':
        result.tokenUri = next;
        i++;
        break;
      case '--rpc-url':
        result.rpcUrl = next;
        i++;
        break;
    }
  }

  if (!result.ventureId) {
    console.error('Error: --venture-id is required');
    printUsage();
    process.exit(1);
  }
  if (!result.name) {
    console.error('Error: --name is required');
    printUsage();
    process.exit(1);
  }
  if (!result.symbol) {
    console.error('Error: --symbol is required');
    printUsage();
    process.exit(1);
  }
  if (!result.safeAddress) {
    console.error('Error: --safe-address is required');
    printUsage();
    process.exit(1);
  }

  return result as LaunchTokenArgs;
}

function printUsage() {
  console.log(`
Usage: yarn tsx scripts/ventures/launch-token.ts [options]

Required:
  --venture-id <uuid>        Venture ID to associate the token with
  --name <name>              Token display name (e.g., "Growth Agency Token")
  --symbol <symbol>          Token symbol (e.g., "GROWTH")
  --safe-address <addr>      Gnosis Safe address (controls governance + receives vested tokens)

Optional:
  --numeraire <token>        Numeraire token: 'weth' (default), 'olas', or a custom address
  --token-uri <uri>          IPFS metadata URI for the token
  --rpc-url <url>            Base RPC URL (default: BASE_RPC_URL env or https://mainnet.base.org)

Deployer key (fallback chain):
  1. Master EOA via operate-profile (requires OPERATE_PASSWORD)
  2. DEPLOYER_PRIVATE_KEY env var (manual override)

Token allocation (10/10/80):
  - 10% (100M) → Doppler bonding curve (price discovery)
  - 10% (100M) → Gnosis Safe (insiders, vested)
  - 80% (800M) → Governance contract (treasury/rewards, Safe-controlled)

GovernanceLaunchpad: Safe controls the governance contract and the 80% treasury.
Numeraire: WETH on Base by default (Doppler app compatible)
           Use --numeraire olas for OLAS pairing
Migration: Uniswap V2 (graduates to TOKEN/numeraire LP pair)

Example:
  yarn tsx scripts/ventures/launch-token.ts \\
    --venture-id "123e4567-e89b-12d3-a456-426614174000" \\
    --name "Growth Agency Token" \\
    --symbol "GROWTH" \\
    --safe-address "0x..."
`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  try {
    const args = parseArgs();
    const result = await launchToken(args);
    console.log(JSON.stringify({ ok: true, data: result }, null, 2));
  } catch (err: any) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

const isDirectRun = process.argv[1]?.endsWith('launch-token.ts') || process.argv[1]?.endsWith('launch-token.js');
if (isDirectRun) {
  main();
}
