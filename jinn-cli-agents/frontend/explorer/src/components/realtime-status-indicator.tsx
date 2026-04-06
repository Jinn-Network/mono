'use client'

import { type ConnectionStatus } from '@/hooks/use-realtime-data'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface RealtimeStatusIndicatorProps {
  status: ConnectionStatus
  className?: string
}

export function RealtimeStatusIndicator({ status, className = '' }: RealtimeStatusIndicatorProps) {
  const getStatusColor = () => {
    switch (status) {
      case 'connected':
        return 'bg-green-500'
      case 'connecting':
        return 'bg-yellow-500 animate-pulse'
      case 'disconnected':
        return 'bg-gray-400'
      case 'error':
        return 'bg-red-500'
      default:
        return 'bg-gray-400'
    }
  }

  const getStatusText = () => {
    switch (status) {
      case 'connected':
        return 'Real-time updates active'
      case 'connecting':
        return 'Connecting to real-time updates...'
      case 'disconnected':
        return 'Using polling fallback'
      case 'error':
        return 'Real-time connection error - using polling fallback'
      default:
        return 'Unknown status'
    }
  }

  const getStatusLabel = () => {
    switch (status) {
      case 'connected':
        return 'Live'
      case 'connecting':
        return 'Connecting'
      case 'disconnected':
        return 'Polling'
      case 'error':
        return 'Fallback'
      default:
        return 'Unknown'
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={`flex items-center gap-2 text-sm ${className}`}>
          <div className={`w-2 h-2 rounded-full ${getStatusColor()}`} />
          <span className="text-gray-400">{getStatusLabel()}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs">{getStatusText()}</p>
      </TooltipContent>
    </Tooltip>
  )
}

