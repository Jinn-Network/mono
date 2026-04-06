'use client'

import { DbRecord } from '@/lib/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { IdLink } from '@/components/id-link'

interface ThreadDetailsSidebarProps {
  record: DbRecord
}

// Function to convert field names to human-readable labels
function humanizeFieldName(fieldName: string): string {
  return fieldName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

// Component to handle different types of values (simplified)
function ValueDisplay({ value, fieldName }: { value: unknown; fieldName: string }) {
  if (value === null || value === undefined) {
    return <span className="text-gray-400 italic">null</span>
  }

  if (typeof value === 'boolean') {
    return (
      <span className={`inline-flex items-center px-2 py-1 rounded text-xs ${
        value 
          ? 'text-green-700 dark:text-green-400 bg-green-500/10 border border-green-500/30' 
          : 'text-red-700 dark:text-red-400 bg-red-500/10 border border-red-500/30'
      }`}>
        {value ? '✓ true' : '✗ false'}
      </span>
    )
  }

  if (typeof value === 'number') {
    return (
      <span className="font-mono text-sm">
        {value.toLocaleString()}
      </span>
    )
  }

  if (typeof value === 'string') {
    // Check if it's a UUID - show as link if it's a foreign key field
    if (value.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      // Check if this is a foreign key field that should be linked
      if (fieldName.endsWith('_id') || fieldName === 'parent_thread_id') {
        return <IdLink id={value} fieldName={fieldName} showFullId={true} />
      }
      
      return (
        <div className="font-mono text-sm break-all text-gray-400">{value}</div>
      )
    }

    // Check if it's a date string (ISO format)
    if (value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      const date = new Date(value)
      const isValid = !isNaN(date.getTime())
      
      if (isValid) {
        return (
          <div 
            className="text-sm cursor-help" 
            title={`Technical format: ${value}`}
          >
            {date.toLocaleString('en-US', {
              weekday: 'short',
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              timeZoneName: 'short'
            })}
          </div>
        )
      }
      return <span className="text-red-600 text-sm">Invalid Date: {value}</span>
    }

    return <span className="break-words text-sm">{value}</span>
  }

  return <span className="font-mono text-sm">{String(value)}</span>
}

// Component for status badge
function StatusBadge({ status }: { status: string }) {
  const getStatusColors = (status: string) => {
    switch (status.toLowerCase()) {
      case 'open':
        return 'bg-primary/20 text-primary border-primary/30'
      case 'completed':
        return 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30'
      case 'closed':
        return 'bg-muted text-muted-foreground border-muted-foreground/30'
      case 'failed':
        return 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30'
      case 'in_progress':
        return 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30'
      default:
        return 'bg-muted text-muted-foreground border-muted-foreground/30'
    }
  }

  return (
    <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium border ${getStatusColors(status)}`}>
      {status.toUpperCase()}
    </span>
  )
}

export function ThreadDetailsSidebar({ record }: ThreadDetailsSidebarProps) {
  if (!record) {
    return null
  }

  // Extract fields, excluding objective (shown separately) and status for separate display
  const { objective, status, ...otherFields } = record
  
  // Fields to hide from the detail view
  const hiddenFields = ['worker_id', 'dispatcher_processed_at']
  
  // Filter out hidden fields from other fields
  const visibleOtherFields = Object.entries(otherFields).filter(([key]) => 
    !hiddenFields.includes(key)
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Objective */}
          {objective && (
            <div className="border-b border-gray-100 pb-3">
              <div className="font-medium text-gray-900 text-sm mb-1">
                Objective:
              </div>
              <div className="text-sm text-gray-400">
                {objective}
              </div>
            </div>
          )}

          {/* Status */}
          {status && (
            <div className="border-b border-gray-100 pb-3">
              <div className="font-medium text-gray-900 text-sm mb-1">
                Status:
              </div>
              <div>
                <StatusBadge status={status} />
              </div>
            </div>
          )}

          {/* Timeline Link */}
          <div className="border-b border-gray-100 pb-3">
            <div className="font-medium text-gray-900 text-sm mb-1">
              Timeline:
            </div>
            <div>
              <a 
                href={`/threads/${record.id}/timeline`}
                className="text-primary hover:text-primary text-sm underline"
              >
                View Event Timeline →
              </a>
            </div>
          </div>

          {/* Other fields */}
          {visibleOtherFields.map(([key, value]) => (
            <div key={key} className="border-b border-gray-100 pb-3 last:border-b-0 last:pb-0">
              <div className="font-medium text-gray-900 text-sm mb-1" title={`Field: ${key}`}>
                {humanizeFieldName(key)}:
              </div>
              <div>
                <ValueDisplay value={value} fieldName={key} />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}