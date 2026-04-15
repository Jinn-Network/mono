import React from 'react'
import { CheckCircle2, XCircle, AlertCircle, Loader2, Clock, ArrowRight } from 'lucide-react'

export type JobStatus = 'COMPLETED' | 'FAILED' | 'DELEGATING' | 'WAITING' | 'PENDING' | 'UNKNOWN'

interface StatusIconProps {
  status: string
  className?: string
  size?: number
}

/**
 * Maps job status to appropriate lucide-react icon and color class
 */
export function getStatusIconConfig(status: string): {
  Icon: React.ComponentType<{ className?: string; size?: number }>
  colorClass: string
} {
  const normalizedStatus = status.toUpperCase()
  
  switch (normalizedStatus) {
    case 'COMPLETED':
      return {
        Icon: CheckCircle2,
        colorClass: 'text-green-600'
      }
    case 'FAILED':
      return {
        Icon: XCircle,
        colorClass: 'text-red-600'
      }
    case 'DELEGATING':
      return {
        Icon: ArrowRight,
        colorClass: 'text-primary'
      }
    case 'WAITING':
      return {
        Icon: Loader2,
        colorClass: 'text-purple-600'
      }
    case 'PENDING':
      return {
        Icon: Clock,
        colorClass: 'text-yellow-600'
      }
    default:
      return {
        Icon: AlertCircle,
        colorClass: 'text-gray-400'
      }
  }
}

/**
 * Reusable status icon component
 * Renders appropriate icon based on job definition status
 */
export function StatusIcon({ status, className = '', size = 16 }: StatusIconProps) {
  const { Icon, colorClass } = getStatusIconConfig(status)
  
  return (
    <Icon 
      className={`${colorClass} ${className}`} 
      size={size}
      aria-label={`Status: ${status}`}
    />
  )
}

/**
 * Maps 3-state dependency status to lastStatus equivalent
 * Used for backwards compatibility with dependency tooltips
 */
export function mapDependencyStatusToJobStatus(
  delivered: boolean,
  status: 'pending' | 'in_progress' | 'delivered'
): JobStatus {
  if (delivered) return 'COMPLETED'
  if (status === 'in_progress') return 'WAITING'
  return 'PENDING'
}













