import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SiteHeader } from '@/components/site-header'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EpochProgress } from '@/components/staking/epoch-progress'
import { ServiceStakingStatus } from '@/components/staking/service-staking-status'
import { DeliveriesTable, RequestsTable } from '@/components/staking/service-deliveries-table'
import { getStakedServiceByServiceId, getMechsForServiceIds, getRecentDeliveries, getRecentRequests } from '@/lib/staking/queries'
import { formatDate } from '@/lib/utils'
import {
  formatEthBalance,
  formatOlasBalance,
  getAddressBalances,
  getAgentEoaAddress,
  getEthFundingLevel,
} from '@/lib/staking/balances'
import { ETH_FUNDING_TARGET_WEI, ETH_FUNDING_WARNING_WEI } from '@/lib/staking/constants'

interface PageProps {
  params: Promise<{ serviceId: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { serviceId } = await params
  return {
    title: `Service ${serviceId} - Staking`,
    description: `Staking details for service ${serviceId}`,
  }
}

export const dynamic = 'force-dynamic'

function AddressLink({ address, label }: { address: string; label: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <a
        href={`https://basescan.org/address/${address}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-mono text-primary hover:underline"
      >
        {address}
      </a>
    </div>
  )
}

function EthFundingBadge({ ethWei }: { ethWei: bigint | null }) {
  if (ethWei == null) {
    return (
      <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-muted">
        Unavailable
      </Badge>
    )
  }

  const level = getEthFundingLevel(ethWei)
  if (level === 'healthy') {
    return <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20">Healthy</Badge>
  }
  if (level === 'warning') {
    return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Warning</Badge>
  }
  return <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/20">Low</Badge>
}

function EthBalanceRow({ label, balance }: { label: string; balance: bigint | null }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono">{formatEthBalance(balance)} ETH</span>
        <EthFundingBadge ethWei={balance} />
      </div>
    </div>
  )
}

function OlasBalanceRow({ label, balance }: { label: string; balance: bigint | null }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-mono">{formatOlasBalance(balance)} OLAS</span>
    </div>
  )
}

export default async function ServiceDetailPage({ params }: PageProps) {
  const { serviceId } = await params
  const services = await getStakedServiceByServiceId(serviceId)

  if (services.length === 0) {
    notFound()
  }

  // Prefer actively staked record; if none, use the most recent
  const service = services.find(s => s.isStaked) ?? services[0]

  const [mechs, deliveries] = await Promise.all([
    getMechsForServiceIds([service.serviceId]),
    getRecentDeliveries(service.multisig, 50),
  ])

  const mech = mechs[0]
  const [requests, agentEoaAddress] = await Promise.all([
    mech ? getRecentRequests(mech.mech, 50) : Promise.resolve([]),
    getAgentEoaAddress(service.serviceId),
  ])

  const balanceMap = await getAddressBalances([
    service.multisig,
    service.owner,
    ...(agentEoaAddress ? [agentEoaAddress] : []),
  ])
  const safeBalance = balanceMap.get(service.multisig.toLowerCase()) || null
  const masterSafeBalance = balanceMap.get(service.owner.toLowerCase()) || null
  const agentBalance = agentEoaAddress ? balanceMap.get(agentEoaAddress.toLowerCase()) || null : null

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Staking', href: '/nodes/staking' },
          { label: `Service ${serviceId}` },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4 space-y-6">
          {/* Service Info Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Service {serviceId}</CardTitle>
                <ServiceStakingStatus serviceId={serviceId} stakingContract={service.stakingContract} variant="badge" />
              </div>
            </CardHeader>
            <CardContent className="space-y-1 divide-y">
              <AddressLink address={service.owner} label="Master Safe (Owner)" />
              <AddressLink address={service.multisig} label="Service Safe (Multisig)" />
              {agentEoaAddress && <AddressLink address={agentEoaAddress} label="Agent EOA" />}
              {mech && <AddressLink address={mech.mech} label="Mech" />}
              <AddressLink address={service.stakingContract} label="Staking Contract" />
              <div className="flex items-center justify-between py-1.5">
                <span className="text-sm text-muted-foreground">Staked Since</span>
                <span className="text-sm">{formatDate(service.stakedAt)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Funding Balances */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Funding Balances</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 divide-y">
              <div className="pb-3 text-xs text-muted-foreground">
                Target {formatEthBalance(ETH_FUNDING_TARGET_WEI)} ETH · Warning below {formatEthBalance(ETH_FUNDING_WARNING_WEI)} ETH
              </div>
              <EthBalanceRow label="Service Safe ETH" balance={safeBalance?.ethWei ?? null} />
              <EthBalanceRow label="Agent EOA ETH" balance={agentBalance?.ethWei ?? null} />
              <EthBalanceRow label="Master Safe ETH" balance={masterSafeBalance?.ethWei ?? null} />
              <OlasBalanceRow label="Service Safe OLAS" balance={safeBalance?.olasWei ?? null} />
              <OlasBalanceRow label="Master Safe OLAS" balance={masterSafeBalance?.olasWei ?? null} />
            </CardContent>
          </Card>

          {/* Staking Status & Rewards */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Staking Rewards</CardTitle>
            </CardHeader>
            <CardContent>
              <ServiceStakingStatus serviceId={serviceId} stakingContract={service.stakingContract} variant="full" />
            </CardContent>
          </Card>

          {/* Epoch Progress */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Epoch Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <EpochProgress multisig={service.multisig} serviceId={service.serviceId} stakingContract={service.stakingContract} />
            </CardContent>
          </Card>

          {/* Recent Deliveries */}
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">Recent Deliveries</h2>
            <DeliveriesTable deliveries={deliveries} />
          </div>

          {/* Recent Requests */}
          {mech && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">Recent Requests</h2>
              <RequestsTable requests={requests} />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
