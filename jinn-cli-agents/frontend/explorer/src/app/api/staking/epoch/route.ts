import { NextRequest, NextResponse } from 'next/server'
import { type Address } from 'viem'
import { ALL_STAKING_ADDRESSES, stakingAbi, MECH_MARKETPLACE, marketplaceAbi, TARGET_REQUESTS_PER_EPOCH } from '@/lib/staking/constants'
import { getLatestCheckpoint, getStakingContract } from '@/lib/staking/subgraph'
import { getRpcClient } from '@/lib/staking/rpc'

// Per-contract cache for subgraph data (5 minutes TTL — only changes when checkpoint() is called on-chain)
interface EpochCacheEntry {
  livenessPeriod: number
  checkpointTimestamp: number
  epochLength: number
  fetchedAt: number
}
const subgraphCache = new Map<string, EpochCacheEntry>()
const SUBGRAPH_CACHE_TTL_MS = 5 * 60_000

async function getSubgraphEpochData(stakingContract: string) {
  const key = stakingContract.toLowerCase()
  const cached = subgraphCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < SUBGRAPH_CACHE_TTL_MS) {
    return cached
  }

  const [contract, checkpoint] = await Promise.all([
    getStakingContract(stakingContract),
    getLatestCheckpoint(stakingContract),
  ])

  if (!contract || !checkpoint) {
    throw new Error(`Staking contract or checkpoint not found in subgraph for ${stakingContract}`)
  }

  const entry: EpochCacheEntry = {
    livenessPeriod: Number(contract.livenessPeriod),
    checkpointTimestamp: Number(checkpoint.blockTimestamp),
    epochLength: Number(checkpoint.epochLength),
    fetchedAt: Date.now(),
  }
  subgraphCache.set(key, entry)

  return entry
}

async function rpcWithRetry<T>(fn: () => Promise<T>, retries = 1, delayMs = 2000): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, delayMs))
      return rpcWithRetry(fn, retries - 1, delayMs)
    }
    throw err
  }
}

export async function GET(request: NextRequest) {
  try {
    const multisig = request.nextUrl.searchParams.get('multisig')
    const serviceId = request.nextUrl.searchParams.get('serviceId')
    const stakingContract = request.nextUrl.searchParams.get('stakingContract')

    if (!stakingContract || !ALL_STAKING_ADDRESSES.includes(stakingContract.toLowerCase())) {
      return NextResponse.json({ error: 'Valid stakingContract parameter required' }, { status: 400 })
    }

    const contractAddress = stakingContract as Address

    // Primary: subgraph for epoch timing (static data, highly reliable)
    const epoch = await getSubgraphEpochData(contractAddress)
    const nextCheckpoint = epoch.checkpointTimestamp + epoch.livenessPeriod

    // RPC: request count + inactivity (essential real-time data, with retry + graceful fallback)
    // Uses shared singleton client with multicall batching — concurrent calls from
    // multiple service cards get batched into fewer actual RPC requests.
    let requestCount: number | undefined
    let inactivity: number | undefined
    let maxInactivityPeriods: number | undefined
    if (multisig) {
      try {
        const client = getRpcClient()

        const [currentCount, serviceInfo, maxInactivity] = await Promise.all([
          rpcWithRetry(() =>
            client.readContract({
              address: MECH_MARKETPLACE,
              abi: marketplaceAbi,
              functionName: 'mapRequestCounts',
              args: [multisig as Address],
            })
          ),
          serviceId
            ? rpcWithRetry(() =>
                client.readContract({
                  address: contractAddress,
                  abi: stakingAbi,
                  functionName: 'getServiceInfo',
                  args: [BigInt(serviceId)],
                })
              )
            : Promise.resolve(null),
          rpcWithRetry(() =>
            client.readContract({
              address: contractAddress,
              abi: stakingAbi,
              functionName: 'maxNumInactivityPeriods',
            })
          ),
        ])

        maxInactivityPeriods = Number(maxInactivity)

        if (serviceId && serviceInfo) {
          // getServiceInfo returns a tuple: { multisig, owner, nonces, tsStart, reward, inactivity }
          // nonces[1] is the request count baseline at the last checkpoint
          const info = serviceInfo as { nonces: readonly bigint[]; inactivity: bigint }
          const baseline = Number(info.nonces[1])
          const delta = Number(currentCount) - baseline
          requestCount = delta >= 0 ? delta : Number(currentCount)
          inactivity = Number(info.inactivity)
        } else {
          requestCount = Number(currentCount)
        }
      } catch (err) {
        console.warn('Failed to fetch request count after retry, returning without it:', err)
      }
    }

    // maxInactivityPeriods is in units of livenessPeriod (seconds)
    // inactivity is cumulative seconds of missed epochs
    const maxInactivitySeconds = maxInactivityPeriods != null
      ? maxInactivityPeriods * epoch.livenessPeriod
      : undefined

    return NextResponse.json({
      checkpoint: epoch.checkpointTimestamp,
      nextCheckpoint,
      livenessPeriod: epoch.livenessPeriod,
      targetRequests: TARGET_REQUESTS_PER_EPOCH,
      requestCount,
      inactivity,
      maxInactivitySeconds,
    })
  } catch (error) {
    console.error('Error fetching staking epoch:', error)
    return NextResponse.json(
      { error: 'Failed to fetch epoch data' },
      { status: 502 }
    )
  }
}
