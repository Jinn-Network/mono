'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Progress } from '@/components/ui/progress'
import { TARGET_REQUESTS_PER_EPOCH } from '@/lib/staking/constants'

interface EpochData {
  checkpoint: number
  nextCheckpoint: number
  livenessPeriod: number
  targetRequests: number
  requestCount?: number
}

interface EpochProgressCompactProps {
  multisig: string
  serviceId?: string
  stakingContract: string
}

export function EpochProgressCompact({ multisig, serviceId, stakingContract }: EpochProgressCompactProps) {
  const [data, setData] = useState<EpochData | null>(null)
  const [error, setError] = useState(false)
  const hasLoadedOnce = useRef(false)

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({ multisig, stakingContract })
      if (serviceId) params.set('serviceId', serviceId)
      const res = await fetch(`/api/staking/epoch?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const epochData: EpochData = await res.json()
      setData(prev => {
        if (epochData.requestCount == null && prev?.requestCount != null) {
          return { ...epochData, requestCount: prev.requestCount }
        }
        return epochData
      })
      setError(false)
      hasLoadedOnce.current = true
    } catch {
      if (!hasLoadedOnce.current) setError(true)
    }
  }, [multisig, serviceId, stakingContract])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 60_000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (error) {
    return <span className="text-muted-foreground">--</span>
  }

  if (!data) {
    return <div className="h-2 w-20 bg-muted animate-pulse rounded-full" />
  }

  const target = TARGET_REQUESTS_PER_EPOCH
  const hasCount = data.requestCount != null
  const count = data.requestCount ?? 0
  const pct = hasCount ? Math.min((count / target) * 100, 100) : 0

  let progressColor = '[&_[data-slot=progress-indicator]]:bg-red-500'
  if (!hasCount) {
    progressColor = '[&_[data-slot=progress-indicator]]:bg-muted-foreground'
  } else if (pct >= 100) {
    progressColor = '[&_[data-slot=progress-indicator]]:bg-green-500'
  } else if (pct >= 50) {
    progressColor = '[&_[data-slot=progress-indicator]]:bg-yellow-500'
  }

  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <Progress value={hasCount ? count : 0} max={target} className={`h-2 w-16 ${progressColor}`} />
      <span className="font-mono text-muted-foreground whitespace-nowrap">
        {hasCount ? `${count}/${target}` : '--'}
      </span>
    </div>
  )
}
