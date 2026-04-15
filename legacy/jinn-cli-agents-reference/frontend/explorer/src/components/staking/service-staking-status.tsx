'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Badge } from '@/components/ui/badge'

interface ServiceStatus {
  serviceId: string
  isActivelyStaked: boolean
  isEvicted: boolean
  stakingStateUnknown?: boolean
  accumulatedReward: string
  pendingReward: string
  totalClaimable: string
  hasClaimableRewards: boolean
  contractAvailableRewards: string
  stakedSince: string | null
  totalEpochsParticipated?: number
  olasStaked?: string
  restakeEligibleAt?: number | null
}

interface ServiceStakingStatusProps {
  serviceId: string
  stakingContract: string
  variant?: 'badge' | 'full'
}

function RestakeCountdown({ eligibleAt }: { eligibleAt: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    if (now >= eligibleAt) return
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(interval)
  }, [now, eligibleAt])

  if (now >= eligibleAt) {
    return (
      <p className="mt-2 font-medium text-green-500">
        Ready to restake now
      </p>
    )
  }

  const remaining = eligibleAt - now
  const hours = Math.floor(remaining / 3600)
  const minutes = Math.floor((remaining % 3600) / 60)
  const seconds = remaining % 60

  const eligibleDate = new Date(eligibleAt * 1000)

  return (
    <div className="mt-2 space-y-1">
      <p className="text-muted-foreground">
        Restake available in{' '}
        <span className="font-mono font-medium text-orange-500">
          {hours}h {minutes}m {seconds}s
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        Eligible at {eligibleDate.toLocaleString()}
      </p>
    </div>
  )
}

function StakingBadge({ status }: { status: ServiceStatus | null }) {
  if (!status) {
    return (
      <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-muted animate-pulse">
        loading
      </Badge>
    )
  }

  if (status.stakingStateUnknown) {
    return (
      <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
        unknown
      </Badge>
    )
  }

  if (status.isEvicted) {
    return (
      <Badge variant="outline" className="bg-orange-500/10 text-orange-500 border-orange-500/20">
        evicted
      </Badge>
    )
  }
  if (status.isActivelyStaked) {
    return (
      <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20">
        staked
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="bg-gray-500/10 text-gray-500 border-gray-500/20">
      unstaked
    </Badge>
  )
}

export function ServiceStakingStatus({ serviceId, stakingContract, variant = 'badge' }: ServiceStakingStatusProps) {
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasLoadedOnce = useRef(false)

  const fetchStatus = useCallback(async () => {
    try {
      const params = new URLSearchParams({ serviceId, stakingContract })
      const res = await fetch(`/api/staking/service-status?${params}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const data: ServiceStatus = await res.json()
      setStatus(data)
      setError(null)
      hasLoadedOnce.current = true
    } catch (e) {
      if (!hasLoadedOnce.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [serviceId, stakingContract])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 120_000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  if (variant === 'badge') {
    if (error) {
      return (
        <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/20">
          error
        </Badge>
      )
    }
    return <StakingBadge status={status} />
  }

  // Full variant — used on detail page
  if (error) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm">
        <p className="text-destructive">Failed to load staking status</p>
        <p className="text-muted-foreground mt-1 text-xs">{error}</p>
        <button
          onClick={fetchStatus}
          className="mt-2 text-xs underline text-muted-foreground hover:text-foreground"
        >
          Retry
        </button>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="flex items-center justify-between py-1.5">
            <div className="h-4 w-32 bg-muted animate-pulse rounded" />
            <div className="h-4 w-24 bg-muted animate-pulse rounded" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between py-1.5">
        <span className="text-sm text-muted-foreground">On-chain Status</span>
        <StakingBadge status={status} />
      </div>

      {status.stakingStateUnknown && (
        <div className="rounded-md border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm">
          <p className="font-medium text-yellow-500">Staking state unavailable</p>
          <p className="text-muted-foreground mt-1">
            On-chain RPC is not responding. The actual staking state could not be verified.
          </p>
        </div>
      )}

      {status.isEvicted && (
        <div className="rounded-md border border-orange-500/20 bg-orange-500/5 p-3 text-sm">
          <p className="font-medium text-orange-500">Service Evicted</p>
          <p className="text-muted-foreground mt-1">
            This service was removed from active staking due to insufficient activity.
          </p>
          {status.restakeEligibleAt && (
            <RestakeCountdown eligibleAt={status.restakeEligibleAt} />
          )}
        </div>
      )}

      {status.olasStaked && (
        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-muted-foreground">OLAS Staked</span>
          <span className="text-sm font-mono">
            {parseFloat(status.olasStaked).toLocaleString()} OLAS
          </span>
        </div>
      )}

      <div className="flex items-center justify-between py-1.5">
        <span className="text-sm text-muted-foreground">Total Rewards Earned</span>
        <span className="text-sm font-mono">
          {parseFloat(status.accumulatedReward).toFixed(4)} OLAS
        </span>
      </div>

      {status.isActivelyStaked && (
        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-muted-foreground">Pending (next checkpoint)</span>
          <span className="text-sm font-mono">
            {parseFloat(status.pendingReward).toFixed(4)} OLAS
          </span>
        </div>
      )}

      <div className="flex items-center justify-between py-1.5">
        <span className="text-sm text-muted-foreground">Claimable</span>
        <span className={`text-sm font-mono ${status.hasClaimableRewards ? 'text-green-500' : ''}`}>
          {status.hasClaimableRewards
            ? `${parseFloat(status.totalClaimable).toFixed(4)} OLAS`
            : 'None'
          }
        </span>
      </div>

      {status.contractAvailableRewards && parseFloat(status.contractAvailableRewards) > 0 && (
        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-muted-foreground">Contract Reward Pool</span>
          <span className="text-sm font-mono">
            {parseFloat(status.contractAvailableRewards).toFixed(2)} OLAS
          </span>
        </div>
      )}

      {status.totalEpochsParticipated != null && (
        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-muted-foreground">Epochs Participated</span>
          <span className="text-sm font-mono">{status.totalEpochsParticipated}</span>
        </div>
      )}
    </div>
  )
}
