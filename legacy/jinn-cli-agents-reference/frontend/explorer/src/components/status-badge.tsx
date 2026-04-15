import { StatusIcon } from '@/components/status-icon'

interface StatusBadgeProps {
  status: string
  showIcon?: boolean
  size?: number
}

/**
 * Shared status badge component for displaying job statuses across the application.
 * 
 * Supports two status types:
 * - Job Definition statuses: COMPLETED, FAILED, DELEGATING, WAITING, PENDING
 * - Job Run (delivery) statuses: COMPLETED, PENDING (derived from delivery state)
 * 
 * The styling and colors are shared where statuses overlap.
 */
export function StatusBadge({ status, showIcon = true, size = 14 }: StatusBadgeProps) {
  const getStatusColor = (status: string) => {
    switch (status.toUpperCase()) {
      case 'COMPLETED':
        return 'bg-green-500/10 text-green-700 dark:text-green-400'
      case 'FAILED':
        return 'bg-red-500/10 text-red-700 dark:text-red-400'
      case 'DELEGATING':
        return 'bg-primary/20 text-primary'
      case 'WAITING':
        return 'bg-purple-500/10 text-purple-700 dark:text-purple-400'
      case 'PENDING':
        return 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
      default:
        return 'bg-muted text-gray-800'
    }
  }

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(status)}`}>
      {showIcon && <StatusIcon status={status} size={size} />}
      {status}
    </span>
  )
}
