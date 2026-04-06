import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { CollectionName } from "./types"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Function to convert collection names to human-readable labels
export function getCollectionLabel(collectionName: CollectionName): string {
  const labelMap: Record<CollectionName, string> = {
    jobDefinitions: 'Job Definitions',
    requests: 'Job Runs',
    deliveries: 'Deliveries',
    artifacts: 'Artifacts',
    messages: 'Messages',
    templates: 'Templates',
    workstreams: 'Workstreams',
  };

  return labelMap[collectionName] || collectionName;
}

// Navigation items for tabs
export interface NavigationItem {
  collection: CollectionName | string;
  label: string;
  subItems?: NavigationItem[];
}

export const navigationItems: NavigationItem[] = [
  {
    label: 'Ecosystem',
    collection: 'ecosystem',
    subItems: [
      { label: 'Ventures', collection: 'ventures' },
      { label: 'Agents', collection: 'agents' },
      { label: 'Templates', collection: 'templates' },
      { label: 'Services', collection: 'services' },
    ]
  },
  {
    label: 'Nodes',
    collection: 'nodes',
    subItems: [
      { label: 'Staking', collection: 'nodes/staking' },
      { label: 'Vote', collection: 'vote' },
    ]
  },
  {
    label: 'Work',
    collection: 'work',
    subItems: [
      { label: 'Instances', collection: 'jobDefinitions' },
      { label: 'Runs', collection: 'requests' },
      { label: 'Workstreams', collection: 'workstreams' },
      { label: 'Artifacts', collection: 'artifacts' },
    ]
  },
];

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
