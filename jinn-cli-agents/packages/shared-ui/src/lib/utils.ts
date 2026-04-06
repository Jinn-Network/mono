import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Format timestamps for display
export function formatDate(dateString: string | number): string {
  try {
    let date: Date
    if (typeof dateString === 'string') {
      // Try parsing as number first if it looks like a timestamp
      const asNumber = Number(dateString)
      if (!isNaN(asNumber) && asNumber > 0) {
        date = new Date(asNumber * 1000)
      } else {
        date = new Date(dateString)
      }
    } else {
      // Handle bigint timestamps (convert from seconds to milliseconds)
      date = new Date(Number(dateString) * 1000)
    }

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return dateString.toString()
    }

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return dateString.toString()
  }
}

// Format relative time (e.g., "2 hours ago")
export function formatRelativeTime(timestamp: string | number | bigint): string {
  const now = Date.now()
  const time = typeof timestamp === 'bigint'
    ? Number(timestamp) * 1000
    : typeof timestamp === 'string'
      ? Number(timestamp) * 1000
      : timestamp * 1000

  const diff = now - time
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return 'just now'
}

// Truncate address for display
export function truncateAddress(address: string, chars: number = 6): string {
  if (!address) return ''
  if (address.length <= chars * 2 + 2) return address
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
}
