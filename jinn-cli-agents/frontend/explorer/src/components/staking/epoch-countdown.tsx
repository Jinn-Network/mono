'use client'

import { useEffect, useState } from 'react'

interface EpochCountdownProps {
  nextCheckpoint: number
  epochNumber: number
  contractLabel?: string
}

export function EpochCountdown({ nextCheckpoint, epochNumber, contractLabel }: EpochCountdownProps) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(interval)
  }, [])

  const remaining = nextCheckpoint - now
  const isOverdue = remaining <= 0
  const abs = Math.abs(remaining)
  const hours = Math.floor(abs / 3600)
  const minutes = Math.floor((abs % 3600) / 60)
  const seconds = abs % 60

  const checkpointDate = new Date(nextCheckpoint * 1000)
  const timeStr = checkpointDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-4 py-2 text-sm">
      <span className="font-medium">
        {contractLabel ? `${contractLabel} ` : ''}Epoch #{epochNumber}
      </span>
      <span className="text-muted-foreground">|</span>
      <span className={`font-mono ${isOverdue ? 'text-yellow-500' : ''}`}>
        {isOverdue ? 'Checkpoint overdue by ' : 'Next checkpoint in '}
        <span className="font-semibold">{hours}h {minutes}m {seconds}s</span>
      </span>
      <span className="text-muted-foreground">({timeStr})</span>
    </div>
  )
}
