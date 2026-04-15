import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, formatEther } from 'viem';
import { base } from 'viem/chains';

// Doppler contracts on Base
const AIRLOCK_ADDRESS = '0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12' as const;
const V4_MULTICURVE_INITIALIZER = '0x65dE470Da664A5be139A5D812bE5FDa0d76CC951' as const;

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

const STATUS_LABELS: Record<number, 'uninitialized' | 'bonding' | 'migrating' | 'graduated'> = {
  0: 'uninitialized',
  1: 'bonding',
  2: 'migrating',
  3: 'graduated',
};

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const tokenAddress = searchParams.get('tokenAddress');

  if (!tokenAddress) {
    return NextResponse.json(
      { error: 'tokenAddress is required' },
      { status: 400 }
    );
  }

  try {
    const rpcUrl = process.env.RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    const proxyToken = process.env.RPC_PROXY_TOKEN;
    const transportOptions = proxyToken
      ? { fetchOptions: { headers: { Authorization: `Bearer ${proxyToken}` } } }
      : {};
    const client = createPublicClient({
      chain: base,
      transport: http(rpcUrl, transportOptions),
    });

    const assetData = await client.readContract({
      address: AIRLOCK_ADDRESS,
      abi: airlockAbi,
      functionName: 'getAssetData',
      args: [tokenAddress as `0x${string}`],
    });

    const [, , , , poolInitializer, , migrationPool, numTokensToSell] = assetData;

    const poolState = await client.readContract({
      address: V4_MULTICURVE_INITIALIZER,
      abi: v4InitializerAbi,
      functionName: 'getState',
      args: [tokenAddress as `0x${string}`],
    });

    const [, status] = poolState;
    const statusLabel = STATUS_LABELS[status] || 'uninitialized';

    // For V4 multicurve pools, progress can't be easily calculated without event indexing
    const progress = status === 3 ? 100 : null;

    return NextResponse.json({
      status,
      statusLabel,
      tokensToSell: formatEther(numTokensToSell),
      progress,
      poolInitializer,
      migrationPool,
      dopplerUrl: `https://app.doppler.lol/tokens/base/${tokenAddress}`,
      uniswapUrl: status === 3
        ? `https://app.uniswap.org/swap?chain=base&outputCurrency=${tokenAddress}`
        : null,
    });
  } catch (error) {
    console.error('Error fetching Doppler pool state:', error);
    return NextResponse.json(
      { error: 'Failed to fetch pool state' },
      { status: 500 }
    );
  }
}
