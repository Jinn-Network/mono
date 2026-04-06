import { Metadata } from 'next'
import { Suspense } from 'react'
import Link from 'next/link'
import { SiteHeader } from '@/components/site-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { StakedServiceCard } from '@/components/staking/staked-service-card'
import { StakingToolbar } from '@/components/staking/staking-toolbar'
import { EpochProgressCompact } from '@/components/staking/epoch-progress-compact'
import { getStakedServices, getRecentDeliveries, getMechsForServiceIds } from '@/lib/staking/queries'
import {
  STAKING_CONTRACTS,
  STAKING_CONTRACT_BY_KEY,
  STAKING_CONTRACT_BY_ADDRESS,
  LIVENESS_PERIOD,
  stakingAbi,
} from '@/lib/staking/constants'
import {
  formatEthBalance,
  formatOlasBalance,
  getAddressBalances,
  getAgentEoaAddress,
  getEthFundingLevel,
} from '@/lib/staking/balances'
import { formatDate } from '@/lib/utils'
import { getRpcClient } from '@/lib/staking/rpc'
import { getLatestCheckpoint, getStakingContract } from '@/lib/staking/subgraph'
import { EpochCountdown } from '@/components/staking/epoch-countdown'

export const metadata: Metadata = {
  title: 'Staking Dashboard',
  description: 'View staked services and epoch progress on Jinn staking contracts',
}

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ view?: string; owner?: string; contract?: string }>
}

type ViewMode = 'table' | 'cards'

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function getEvictionRiskInfo(isStaked: boolean, lastDeliveryTimestamp: string | null): {
  level: 'safe' | 'warning' | 'critical' | 'evicted'
  label: string
  description: string
} {
  if (!isStaked) {
    return {
      level: 'evicted',
      label: 'Evicted',
      description: 'Service was evicted from staking. Must restake to resume earning rewards.',
    }
  }

  if (!lastDeliveryTimestamp) {
    return {
      level: 'critical',
      label: 'No deliveries',
      description: 'No deliveries recorded. Will be evicted at the next epoch checkpoint.',
    }
  }

  const ageMs = Date.now() - new Date(lastDeliveryTimestamp).getTime()
  const ageHours = ageMs / (1000 * 60 * 60)
  const hoursRemaining = Math.max(0, (LIVENESS_PERIOD / 3600) - ageHours)

  if (ageHours >= 24) {
    return {
      level: 'critical',
      label: 'Eviction imminent',
      description: `Last delivery was ${Math.floor(ageHours)}h ago. Will be evicted at the next epoch checkpoint unless a delivery lands.`,
    }
  }
  if (ageHours >= 12) {
    return {
      level: 'warning',
      label: `${Math.floor(hoursRemaining)}h until eviction`,
      description: `Last delivery was ${Math.floor(ageHours)}h ago. Must deliver within ${Math.floor(hoursRemaining)}h or service will be evicted.`,
    }
  }
  return {
    level: 'safe',
    label: 'On track',
    description: `Last delivery ${Math.floor(ageHours)}h ago. ${Math.floor(hoursRemaining)}h remaining in liveness window.`,
  }
}

function EvictionRiskBadge({ isStaked, lastDeliveryTimestamp }: { isStaked: boolean; lastDeliveryTimestamp: string | null }) {
  const risk = getEvictionRiskInfo(isStaked, lastDeliveryTimestamp)
  const styles = {
    safe: 'bg-green-500/10 text-green-700 border-green-500/20 dark:text-green-400',
    warning: 'bg-yellow-500/10 text-yellow-700 border-yellow-500/20 dark:text-yellow-400',
    critical: 'bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-400',
    evicted: 'bg-muted text-muted-foreground',
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={styles[risk.level]}>
            {risk.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <p>{risk.description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function EthBadge({ wei }: { wei: bigint | undefined | null }) {
  if (wei == null) return <span className="text-muted-foreground">N/A</span>
  const level = getEthFundingLevel(wei)
  const dot = {
    healthy: 'bg-green-500',
    warning: 'bg-yellow-500',
    critical: 'bg-red-500',
  }
  return (
    <span className="inline-flex items-center gap-1.5 font-mono">
      <span className={`inline-block h-2 w-2 rounded-full ${dot[level]}`} />
      {formatEthBalance(wei)} ETH
    </span>
  )
}

async function StakedServicesList({
  viewMode,
  ownerFilter,
  contractFilter,
}: {
  viewMode: ViewMode
  ownerFilter: string | null
  contractFilter: string | null
}) {
  // Resolve contract filter to addresses
  const contractAddresses = contractFilter
    ? (() => {
        const info = STAKING_CONTRACT_BY_KEY.get(contractFilter)
        return info ? [info.address.toLowerCase()] : undefined
      })()
    : undefined

  const services = await getStakedServices(contractAddresses)

  if (services.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No staked services found
      </div>
    )
  }

  // Determine which contracts are in the current view
  const contractsInView = contractFilter
    ? STAKING_CONTRACTS.filter(c => c.shortKey === contractFilter)
    : STAKING_CONTRACTS

  // Get on-chain truth: which services are actually staked right now (per contract)
  let activeServiceIds: Map<string, Set<string>> | null = null
  try {
    const client = getRpcClient()
    const results = await Promise.all(
      contractsInView.map(async c => {
        const ids = await client.readContract({
          address: c.address,
          abi: stakingAbi,
          functionName: 'getServiceIds',
        }) as bigint[]
        return { contract: c.address.toLowerCase(), ids: new Set(ids.map(id => id.toString())) }
      })
    )
    activeServiceIds = new Map(results.map(r => [r.contract, r.ids]))
  } catch (err) {
    console.warn('[staking] Failed to fetch on-chain service IDs, falling back to Ponder isStaked:', err)
  }

  const enrichedServices = services.map(s => ({
    ...s,
    isStaked: activeServiceIds
      ? (activeServiceIds.get(s.stakingContract.toLowerCase())?.has(s.serviceId) ?? s.isStaked)
      : s.isStaked,
  }))

  enrichedServices.sort((a, b) => {
    if (a.isStaked !== b.isStaked) return a.isStaked ? -1 : 1
    return 0
  })

  // Build unique owners list for the filter dropdown
  const ownerSet = new Map<string, string>()
  for (const s of enrichedServices) {
    const key = s.owner.toLowerCase()
    if (!ownerSet.has(key)) {
      ownerSet.set(key, s.owner)
    }
  }
  const owners = Array.from(ownerSet.entries()).map(([key, address]) => ({
    address: key,
    label: truncateAddress(address),
  }))

  // Apply owner filter
  const filtered = ownerFilter
    ? enrichedServices.filter(s => s.owner.toLowerCase() === ownerFilter.toLowerCase())
    : enrichedServices

  const safeBalances = await getAddressBalances(filtered.map((s) => s.multisig))

  // Resolve agent EOA addresses and fetch their ETH balances
  const agentAddresses = await Promise.all(
    filtered.map(async (s) => ({
      serviceId: s.serviceId,
      agentAddress: await getAgentEoaAddress(s.serviceId),
    }))
  )
  const agentAddressMap = new Map(agentAddresses.map((a) => [a.serviceId, a.agentAddress]))
  const agentAddressList = agentAddresses.map((a) => a.agentAddress).filter((a): a is string => a != null)
  const agentBalances = await getAddressBalances(agentAddressList)

  const deliveryPromises = filtered.map(async (service) => {
    const deliveries = await getRecentDeliveries(service.multisig, 1)
    return {
      serviceId: service.serviceId,
      lastDeliveryTimestamp: deliveries[0]?.blockTimestamp || null,
    }
  })
  const deliveryResults = await Promise.all(deliveryPromises)
  const lastDeliveryMap = new Map(deliveryResults.map((d) => [d.serviceId, d.lastDeliveryTimestamp]))

  // Compute epoch checkpoint timing per contract
  const epochInfos = (await Promise.all(
    contractsInView.map(async c => {
      try {
        const [contract, checkpoint] = await Promise.all([
          getStakingContract(c.address),
          getLatestCheckpoint(c.address),
        ])
        if (contract && checkpoint) {
          const livenessPeriod = Number(contract.livenessPeriod)
          const checkpointTs = Number(checkpoint.blockTimestamp)
          return {
            contractLabel: c.label,
            nextCheckpoint: checkpointTs + livenessPeriod,
            livenessPeriod,
            epochNumber: Number(checkpoint.epochLength),
          }
        }
      } catch {}
      return null
    })
  )).filter((e): e is NonNullable<typeof e> => e != null)

  // Per-contract stats
  const contractStats = contractsInView.map(c => {
    const contractServices = enrichedServices.filter(
      s => s.stakingContract.toLowerCase() === c.address.toLowerCase()
    )
    return {
      ...c,
      stakedCount: contractServices.filter(s => s.isStaked).length,
      evictedCount: contractServices.filter(s => !s.isStaked).length,
    }
  })

  return (
    <div className="space-y-4">
      <StakingToolbar
        viewMode={viewMode}
        owners={owners}
        selectedOwner={ownerFilter}
        selectedContract={contractFilter}
      />

      {epochInfos.map(info => (
        <EpochCountdown
          key={info.contractLabel}
          nextCheckpoint={info.nextCheckpoint}
          epochNumber={info.epochNumber}
          contractLabel={contractsInView.length > 1 ? info.contractLabel : undefined}
        />
      ))}

      <div className="flex items-center gap-3 flex-wrap">
        {contractStats.map(c => (
          <Badge key={c.shortKey} variant="outline" className="font-mono">
            <a
              href={`https://basescan.org/address/${c.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {c.label}: {truncateAddress(c.address)}
            </a>
            <span className="ml-1.5 text-muted-foreground font-sans">
              {c.stakedCount} staked{c.evictedCount > 0 ? `, ${c.evictedCount} evicted` : ''}
            </span>
          </Badge>
        ))}
        {ownerFilter && (
          <span className="text-sm text-muted-foreground">(filtered by owner)</span>
        )}
      </div>

      {viewMode === 'cards' ? (
        <CardsView
          services={filtered}
          safeBalances={safeBalances}
          lastDeliveryMap={lastDeliveryMap}
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Service</TableHead>
                <TableHead className="w-20">Contract</TableHead>
                <TableHead className="w-28">Staking</TableHead>
                <TableHead className="w-40">Eviction Risk</TableHead>
                <TableHead>Epoch Requests</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Agent EOA ETH</TableHead>
                <TableHead>Safe OLAS</TableHead>
                <TableHead>Last Delivery</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((service) => {
                const safeBalance = safeBalances.get(service.multisig.toLowerCase())
                const agentAddr = agentAddressMap.get(service.serviceId)
                const agentBalance = agentAddr ? agentBalances.get(agentAddr.toLowerCase()) : undefined
                const lastDeliveryTimestamp = lastDeliveryMap.get(service.serviceId) || null
                const contractInfo = STAKING_CONTRACT_BY_ADDRESS.get(service.stakingContract.toLowerCase())
                return (
                  <TableRow key={service.id}>
                    <TableCell className="font-mono">
                      <Link href={`/nodes/staking/${service.serviceId}`} className="text-primary hover:underline">
                        #{service.serviceId}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {contractInfo?.label ?? truncateAddress(service.stakingContract)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={service.isStaked
                          ? 'bg-green-500/10 text-green-700 border-green-500/20 dark:text-green-400'
                          : 'bg-muted text-muted-foreground'}
                      >
                        {service.isStaked ? 'Staked' : 'Evicted'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <EvictionRiskBadge isStaked={service.isStaked} lastDeliveryTimestamp={lastDeliveryTimestamp} />
                    </TableCell>
                    <TableCell>
                      <EpochProgressCompact
                        multisig={service.multisig}
                        serviceId={service.serviceId}
                        stakingContract={service.stakingContract}
                      />
                    </TableCell>
                    <TableCell className="font-mono">
                      <a
                        href={`https://basescan.org/address/${service.owner}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {truncateAddress(service.owner)}
                      </a>
                    </TableCell>
                    <TableCell>
                      <EthBadge wei={agentBalance?.ethWei} />
                    </TableCell>
                    <TableCell className="font-mono">
                      {formatOlasBalance(safeBalance?.olasWei)} OLAS
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {lastDeliveryTimestamp ? formatDate(lastDeliveryTimestamp) : 'None'}
                    </TableCell>
                    <TableCell>
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/nodes/staking/${service.serviceId}`}>View</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

async function CardsView({
  services,
  safeBalances,
  lastDeliveryMap,
}: {
  services: Awaited<ReturnType<typeof getStakedServices>>
  safeBalances: Awaited<ReturnType<typeof getAddressBalances>>
  lastDeliveryMap: Map<string, string | null>
}) {
  const serviceIds = services.map((s) => s.serviceId)
  const mechs = await getMechsForServiceIds(serviceIds)
  const mechByServiceId = new Map(mechs.map((m) => [m.serviceId, m]))

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {services.map((service) => {
        const balance = safeBalances.get(service.multisig.toLowerCase())
        return (
          <StakedServiceCard
            key={service.id}
            service={service}
            mechAddress={mechByServiceId.get(service.serviceId)?.mech}
            lastDeliveryTimestamp={lastDeliveryMap.get(service.serviceId)}
            safeEthWei={balance?.ethWei}
            safeOlasWei={balance?.olasWei}
          />
        )
      })}
    </div>
  )
}

function StakedServicesListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-9 w-48 bg-muted animate-pulse rounded" />
      <div className="h-5 w-48 bg-muted animate-pulse rounded" />
      <div className="rounded-md border">
        <div className="p-4 space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 w-full bg-muted animate-pulse rounded" />
          ))}
        </div>
      </div>
    </div>
  )
}

export default async function StakingPage({ searchParams }: PageProps) {
  const params = await searchParams
  const viewMode: ViewMode = params.view === 'cards' ? 'cards' : 'table'
  const ownerFilter = params.owner ?? null
  const contractFilter = params.contract ?? null

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        subtitle="Staked services and epoch progress"
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Staking' },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4 space-y-4">
          <Suspense fallback={<StakedServicesListSkeleton />}>
            <StakedServicesList
              viewMode={viewMode}
              ownerFilter={ownerFilter}
              contractFilter={contractFilter}
            />
          </Suspense>
        </div>
      </main>
    </div>
  )
}
