import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(dateString: string | number): string {
  try {
    let date: Date
    if (typeof dateString === 'string') {
      const asNumber = Number(dateString)
      if (!isNaN(asNumber) && asNumber > 0) {
        date = new Date(asNumber * 1000)
      } else {
        date = new Date(dateString)
      }
    } else {
      date = new Date(Number(dateString) * 1000)
    }

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
