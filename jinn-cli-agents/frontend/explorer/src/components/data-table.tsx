import React from 'react'
import Link from 'next/link'
import { DbRecord, CollectionName } from '@/lib/types'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { IdLink } from '@/components/id-link'

interface DataTableProps {
  records: DbRecord[]
  collectionName: CollectionName
}

export function DataTable({ records, collectionName }: DataTableProps) {
  // If no records, show empty state
  if (!records || records.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-500">No records found in {collectionName}</p>
      </div>
    )
  }

  // Get headers from the first record
  const headers = Object.keys(records[0])

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((header) => (
              <TableHead key={header} className="font-medium">
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
          <TableBody>
            {records.map((record, index) => (
              <TableRow key={record.id || index}>
                {headers.map((header) => (
                  <TableCell key={header} className="max-w-xs min-w-0">
                    {header === 'id' ? (
                      <Link 
                        href={`/${collectionName}/${record.id}`}
                        className="text-primary hover:text-primary underline block truncate"
                      >
                        {record.id}
                      </Link>
                    ) : (
                      <span className="block truncate" title={String(record[header])}>
                        {formatCellValue(record[header], header)}
                      </span>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
    </div>
  )
}

// Helper function to format cell values for display
function formatCellValue(value: unknown, fieldName?: string): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-gray-400 italic text-xs">null</span>
  }
  
  if (typeof value === 'boolean') {
    return (
      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
        value ? 'bg-green-500/10 text-green-700' : 'bg-red-500/10 text-red-700'
      }`}>
        {value ? '✓' : '✗'}
      </span>
    )
  }
  
  if (typeof value === 'number') {
    return <span className="font-mono text-sm">{value.toLocaleString()}</span>
  }
  
  if (typeof value === 'string') {
    // UUID - check if it's a foreign key field first
    if (value.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      // Check if this is a foreign key field that should be linked
      if (fieldName && (fieldName.endsWith('_id') || fieldName === 'thread_id')) {
        return <IdLink id={value} fieldName={fieldName} showFullId={false} />
      }
      
      return (
        <span className="font-mono text-xs text-purple-700 dark:text-purple-400" title={value}>
          {value.slice(0, 8)}...
        </span>
      )
    }
    
    // Date string
    if (value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      const date = new Date(value)
      const isValid = !isNaN(date.getTime())
      return (
        <span className="text-xs" title={value}>
          {isValid ? date.toLocaleDateString() : 'Invalid Date'}
        </span>
      )
    }
    
    // Long strings
    if (value.length > 50) {
      return (
        <span className="text-sm" title={value}>
          {value.substring(0, 50)}...
        </span>
      )
    }
    
    return <span className="text-sm">{value}</span>
  }
  
  if (typeof value === 'object') {
    const isArray = Array.isArray(value)
    const count = isArray ? value.length : Object.keys(value).length
    return (
      <span className="text-xs bg-muted px-1.5 py-0.5 rounded" title={JSON.stringify(value)}>
        {isArray ? `Array(${count})` : `Object(${count})`}
      </span>
    )
  }
  
  return <span className="text-sm">{String(value)}</span>
}