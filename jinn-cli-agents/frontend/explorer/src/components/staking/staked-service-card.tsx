import Link from 'next/link'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ArrowRight } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { EpochProgress } from './epoch-progress'
import { ServiceStakingStatus } from './service-staking-status'
import type { StakedService } from '@/lib/staking/queries'
import { formatEthBalance, formatOlasBalance, getEthFundingLevel } from '@/lib/staking/balances'

interface StakedServiceCardProps {
  service: StakedService
  mechAddress?: string
  lastDeliveryTimestamp?: string | null
  safeEthWei?: bigint | null
  safeOlasWei?: bigint | null
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function EthDot({ ethWei }: { ethWei: bigint }) {
  const level = getEthFundingLevel(ethWei)
  const color = {
    healthy: 'bg-green-500',
    warning: 'bg-yellow-500',
    critical: 'bg-red-500',
  }
  return <span className={`inline-block h-2 w-2 rounded-full ${color[level]}`} />
}

export function StakedServiceCard({ service, lastDeliveryTimestamp, safeEthWei, safeOlasWei }: StakedServiceCardProps) {
  const isEvicted = !service.isStaked
  return (
    <Card className={`hover:border-primary/50 transition-colors ${isEvicted ? 'opacity-60' : ''}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <CardTitle>
            <Link href={`/nodes/staking/${service.serviceId}`} className="hover:text-primary hover:underline">
              Service #{service.serviceId}
            </Link>
          </CardTitle>
          <ServiceStakingStatus serviceId={service.serviceId} stakingContract={service.stakingContract} variant="badge" />
        </div>
        <p className="text-sm text-muted-foreground font-mono">
          Owner: {truncateAddress(service.owner)}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <EpochProgress multisig={service.multisig} serviceId={service.serviceId} stakingContract={service.stakingContract} />
        <div className="rounded-md border bg-muted/20 px-3 py-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Safe ETH</span>
            {safeEthWei != null ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-mono">
                <EthDot ethWei={safeEthWei} />
                {formatEthBalance(safeEthWei)} ETH
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">N/A</span>
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Safe OLAS</span>
            <span className="text-sm font-mono">
              {safeOlasWei != null ? `${formatOlasBalance(safeOlasWei)} OLAS` : 'N/A'}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Staked {formatDate(service.stakedAt)}</span>
          {lastDeliveryTimestamp && (
            <span>Last delivery {formatDate(lastDeliveryTimestamp)}</span>
          )}
        </div>
      </CardContent>
      <CardFooter className="pt-0">
        <Button asChild variant="outline" size="sm" className="w-full">
          <Link href={`/nodes/staking/${service.serviceId}`} className="flex items-center gap-1">
            View Details <ArrowRight className="h-3 w-3" />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  )
}
