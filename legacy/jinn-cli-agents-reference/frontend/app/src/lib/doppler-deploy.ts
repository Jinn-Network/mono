/**
 * Doppler Token Deployment for Browser
 *
 * Adapts the CLI launch-token.ts for browser context using wagmi wallet/public clients.
 * Uses MulticurveBuilder with 10/10/80 allocation.
 */

import { parseEther } from 'viem';
import { base } from 'viem/chains';
import { DopplerSDK, MulticurveBuilder } from '@whetstone-research/doppler-sdk';
import { AIRLOCK_ADDRESS, airlockAbi } from './doppler';

// Constants
const WETH_BASE = '0x4200000000000000000000000000000000000006' as const;
const TOTAL_SUPPLY = parseEther('1000000000');              // 1B
const TOKENS_FOR_PRICE_DISCOVERY = parseEther('100000000'); // 10% -> bonding curve
const TOKENS_FOR_INSIDERS = parseEther('100000000');        // 10% -> vested

// Jinn payment address — receives 10% vested allocation
const JINN_PAYMENT_ADDRESS = '0x900Db2954a6c14C011dBeBE474e3397e58AE5421' as const;

// Use loose types to avoid viem version conflicts in monorepo
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DeployTokenArgs {
  name: string;
  symbol: string;
  publicClient: any;
  walletClient: any;
}

export interface DeployTokenResult {
  tokenAddress: string;
  poolId: string;
  transactionHash: string;
  governor: string;
  timelock: string;
  poolInitializer: string;
  migrationPool: string;
  liquidityMigrator: string;
  integrator: string;
  numeraire: string;
}

/**
 * Deploy a venture token via Doppler Multicurve
 *
 * Allocation: 10% bonding curve / 10% vested to Jinn / 80% governance treasury
 */
export async function deployVentureToken(args: DeployTokenArgs): Promise<DeployTokenResult> {
  const { name, symbol, publicClient, walletClient } = args;

  const account = walletClient.account;
  if (!account) throw new Error('Wallet not connected');

  const sdk = new DopplerSDK({
    publicClient,
    walletClient,
    chainId: base.id,
  });

  const params = new MulticurveBuilder(base.id)
    .tokenConfig({
      name,
      symbol,
      tokenURI: '',
    })
    .saleConfig({
      initialSupply: TOTAL_SUPPLY,
      numTokensToSell: TOKENS_FOR_PRICE_DISCOVERY,
      numeraire: WETH_BASE,
    })
    .withMarketCapPresets()
    .withVesting({
      recipients: [JINN_PAYMENT_ADDRESS],
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

  // Execute creation (wallet popup)
  const result = await sdk.factory.createMulticurve(params);

  // Read asset data from Airlock
  const assetData = await publicClient.readContract({
    address: AIRLOCK_ADDRESS,
    abi: airlockAbi,
    functionName: 'getAssetData',
    args: [result.tokenAddress as `0x${string}`],
  });

  const [numeraire, timelock, governance, liquidityMigrator, poolInitializer, , migrationPool, , , integrator] = assetData;

  return {
    tokenAddress: result.tokenAddress,
    poolId: result.poolId,
    transactionHash: result.transactionHash,
    governor: governance as string,
    timelock: timelock as string,
    poolInitializer: poolInitializer as string,
    migrationPool: migrationPool as string,
    liquidityMigrator: liquidityMigrator as string,
    integrator: integrator as string,
    numeraire: numeraire as string,
  };
}
