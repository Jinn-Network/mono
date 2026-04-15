/**
 * Doppler Pool State Utilities
 *
 * Fetches bonding curve state from the Doppler V4 Multicurve Initializer.
 * Used to show auction progress and link to appropriate trading UI.
 */

import { createPublicClient, http, formatEther } from 'viem';
import { base } from 'viem/chains';

// Doppler contracts on Base
const AIRLOCK_ADDRESS = '0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12' as const;
const V4_MULTICURVE_INITIALIZER = '0x65dE470Da664A5be139A5D812bE5FDa0d76CC951' as const;

// Airlock ABI for getAssetData
const airlockAbi = [
  {
    type: 'function',
    name: 'getAssetData',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'numeraire', type: 'address' },
      { name: 'timelock', type: 'address' },
      { name: 'governance', type: 'address' },
      { name: 'liquidityMigrator', type: 'address' },
      { name: 'poolInitializer', type: 'address' },
      { name: 'pool', type: 'address' },
      { name: 'migrationPool', type: 'address' },
      { name: 'numTokensToSell', type: 'uint256' },
      { name: 'totalSupply', type: 'uint256' },
      { name: 'integrator', type: 'address' },
    ],
    stateMutability: 'view',
  },
] as const;

// V4 Multicurve Initializer ABI for getState
const v4InitializerAbi = [
  {
    type: 'function',
    name: 'getState',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'numeraire', type: 'address' },
      { name: 'status', type: 'uint8' },
      {
        name: 'poolKey',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'farTick', type: 'int24' },
    ],
    stateMutability: 'view',
  },
] as const;

// ERC20 ABI for balance check
const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

/**
 * Pool status enum from Doppler contracts
 * 0 = Uninitialized - Pool not set up yet
 * 1 = Initialized - Active bonding curve (can buy/sell on Doppler)
 * 2 = Locked - Migration in progress
 * 3 = Exited - Graduated to Uniswap V2 LP
 */
export enum PoolStatus {
  Uninitialized = 0,
  Initialized = 1,
  Locked = 2,
  Exited = 3,
}

export interface DopplerPoolState {
  status: PoolStatus;
  statusLabel: 'uninitialized' | 'bonding' | 'migrating' | 'graduated';
  tokensRemaining: bigint;
  tokensToSell: bigint;
  progress: number; // 0-100 percentage
  poolInitializer: string;
  migrationPool: string;
  dopplerUrl: string;
  uniswapUrl: string | null;
}

/**
 * Get the bonding curve state for a Doppler token
 */
export async function getDopplerPoolState(
  tokenAddress: string,
  rpcUrl?: string
): Promise<DopplerPoolState | null> {
  try {
    const resolvedUrl = rpcUrl || process.env.RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    const proxyToken = process.env.RPC_PROXY_TOKEN;
    const transportOptions = proxyToken
      ? { fetchOptions: { headers: { Authorization: `Bearer ${proxyToken}` } } }
      : {};
    const client = createPublicClient({
      chain: base,
      transport: http(resolvedUrl, transportOptions),
    });

    // Get asset data from Airlock
    const assetData = await client.readContract({
      address: AIRLOCK_ADDRESS,
      abi: airlockAbi,
      functionName: 'getAssetData',
      args: [tokenAddress as `0x${string}`],
    });

    const [, , , , poolInitializer, , migrationPool, numTokensToSell] = assetData;

    // Get authoritative pool state from V4 Multicurve Initializer
    const poolState = await client.readContract({
      address: V4_MULTICURVE_INITIALIZER,
      abi: v4InitializerAbi,
      functionName: 'getState',
      args: [tokenAddress as `0x${string}`],
    });

    const [, statusNum] = poolState;
    const status = statusNum as PoolStatus;

    const statusLabels: Record<number, DopplerPoolState['statusLabel']> = {
      0: 'uninitialized',
      1: 'bonding',
      2: 'migrating',
      3: 'graduated',
    };
    const statusLabel = statusLabels[status] || 'uninitialized';

    // Calculate progress based on status
    let progress = 0;
    let tokensRemaining = BigInt(0);

    if (status === PoolStatus.Initialized) {
      // Bonding - try to get balance info for progress calculation
      try {
        tokensRemaining = await client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [poolInitializer as `0x${string}`],
        });
        const tokensSold = numTokensToSell - tokensRemaining;
        progress = numTokensToSell > BigInt(0)
          ? Number((tokensSold * BigInt(100)) / numTokensToSell)
          : 0;
      } catch {
        progress = 0;
      }
    } else if (status === PoolStatus.Exited) {
      progress = 100;
    }

    const dopplerUrl = `https://app.doppler.lol/tokens/base/${tokenAddress}`;

    // Uniswap V2 URL after graduation
    const uniswapUrl = status === PoolStatus.Exited
      ? `https://app.uniswap.org/swap?chain=base&outputCurrency=${tokenAddress}`
      : null;

    return {
      status,
      statusLabel,
      tokensRemaining,
      tokensToSell: numTokensToSell,
      progress,
      poolInitializer: poolInitializer as string,
      migrationPool: migrationPool as string,
      dopplerUrl,
      uniswapUrl,
    };
  } catch (error) {
    console.error('Failed to fetch Doppler pool state:', error);
    return null;
  }
}

/**
 * Build the appropriate trading URL based on pool status
 */
export function getDopplerTradeUrl(tokenAddress: string): string {
  return `https://app.doppler.lol/tokens/base/${tokenAddress}`;
}

/**
 * Build Uniswap swap URL for graduated tokens
 */
export function getUniswapSwapUrl(tokenAddress: string): string {
  return `https://app.uniswap.org/swap?chain=base&outputCurrency=${tokenAddress}`;
}
