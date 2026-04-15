import { type Address, formatEther } from 'viem'
import {
  ETH_FUNDING_TARGET_WEI,
  ETH_FUNDING_WARNING_WEI,
  OLAS_TOKEN_CONTRACT,
  SERVICE_REGISTRY_CONTRACT,
  erc20Abi,
  serviceRegistryAbi,
} from './constants'
import { getRpcClient } from './rpc'

const BALANCE_CACHE_TTL_MS = 60_000
const AGENT_CACHE_TTL_MS = 60_000

interface CachedBalance {
  ethWei: bigint
  olasWei: bigint
  fetchedAt: number
}

interface CachedAgent {
  address: string | null
  fetchedAt: number
}

export interface AddressBalances {
  ethWei: bigint
  olasWei: bigint
}

export type EthFundingLevel = 'healthy' | 'warning' | 'critical'

const balanceCache = new Map<string, CachedBalance>()
const agentCache = new Map<string, CachedAgent>()

function isAddress(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value)
}

function normalizeAddress(address: string): Address | null {
  const trimmed = address.trim()
  if (!isAddress(trimmed)) return null
  return trimmed as Address
}

function formatCompact(wei: bigint, maxDecimals: number): string {
  const value = Number(formatEther(wei))
  if (!Number.isFinite(value)) return '0'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  })
}

export function formatEthBalance(wei?: bigint | null): string {
  if (wei == null) return 'N/A'
  if (wei >= BigInt('1000000000000000000')) return formatCompact(wei, 4)
  if (wei >= BigInt('10000000000000000')) return formatCompact(wei, 6)
  return formatCompact(wei, 8)
}

export function formatOlasBalance(wei?: bigint | null): string {
  if (wei == null) return 'N/A'
  return formatCompact(wei, 4)
}

export function getEthFundingLevel(ethWei: bigint): EthFundingLevel {
  if (ethWei >= ETH_FUNDING_TARGET_WEI) return 'healthy'
  if (ethWei >= ETH_FUNDING_WARNING_WEI) return 'warning'
  return 'critical'
}

async function readAddressBalances(address: Address): Promise<AddressBalances> {
  const client = getRpcClient()
  const [ethWei, olasWei] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: OLAS_TOKEN_CONTRACT,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    }),
  ])

  return { ethWei, olasWei }
}

export async function getAddressBalances(addresses: string[]): Promise<Map<string, AddressBalances>> {
  const now = Date.now()
  const balances = new Map<string, AddressBalances>()
  const toFetch: Address[] = []

  for (const rawAddress of new Set(addresses.map((a) => a.toLowerCase()))) {
    const normalized = normalizeAddress(rawAddress)
    if (!normalized) continue

    const cacheKey = normalized.toLowerCase()
    const cached = balanceCache.get(cacheKey)
    if (cached && now - cached.fetchedAt < BALANCE_CACHE_TTL_MS) {
      balances.set(cacheKey, { ethWei: cached.ethWei, olasWei: cached.olasWei })
      continue
    }

    toFetch.push(normalized)
  }

  if (toFetch.length > 0) {
    const fetched = await Promise.allSettled(
      toFetch.map(async (address) => {
        const result = await readAddressBalances(address)
        return { address, ...result }
      })
    )

    for (const result of fetched) {
      if (result.status !== 'fulfilled') {
        console.warn('[staking/balances] Failed to fetch address balance:', result.reason)
        continue
      }

      const key = result.value.address.toLowerCase()
      balanceCache.set(key, {
        ethWei: result.value.ethWei,
        olasWei: result.value.olasWei,
        fetchedAt: now,
      })
      balances.set(key, {
        ethWei: result.value.ethWei,
        olasWei: result.value.olasWei,
      })
    }
  }

  return balances
}

export async function getAgentEoaAddress(serviceId: string): Promise<string | null> {
  const normalizedServiceId = serviceId.trim()
  if (!/^\d+$/.test(normalizedServiceId)) return null

  const now = Date.now()
  const cached = agentCache.get(normalizedServiceId)
  if (cached && now - cached.fetchedAt < AGENT_CACHE_TTL_MS) {
    return cached.address
  }

  try {
    const client = getRpcClient()
    const [, agentInstances] = await client.readContract({
      address: SERVICE_REGISTRY_CONTRACT,
      abi: serviceRegistryAbi,
      functionName: 'getAgentInstances',
      args: [BigInt(normalizedServiceId)],
    })

    const firstAgent = agentInstances[0] ?? null
    agentCache.set(normalizedServiceId, {
      address: firstAgent,
      fetchedAt: now,
    })
    return firstAgent
  } catch (error) {
    console.warn('[staking/balances] Failed to resolve agent instance:', error)
    agentCache.set(normalizedServiceId, {
      address: null,
      fetchedAt: now,
    })
    return null
  }
}
