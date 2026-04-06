'use client'

import React from 'react'
import Link from 'next/link'
import { ArrowUpDown, ArrowDown, ArrowUp } from 'lucide-react'
import { SubgraphRecord } from '@/hooks/use-subgraph-collection'
import { formatDate } from '@/lib/utils'
import { StatusIcon } from '@/components/status-icon'
import { TruncatedId } from '@/components/truncated-id'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
interface JobDefinitionsTableProps {
  records: SubgraphRecord[]
  onSort?: (column: string, direction: 'asc' | 'desc') => void
  sortColumn?: string
  sortAscending?: boolean
}

export function JobDefinitionsTable({ records, onSort, sortColumn = '', sortAscending = false }: JobDefinitionsTableProps) {
  const handleSort = (column: string) => {
    // Toggle direction if clicking the same column, otherwise default to descending
    const newDirection = sortColumn === column && !sortAscending ? 'asc' : 'desc'
    if (onSort) {
      onSort(column, newDirection)
    }
  }

  const SortIcon = ({ column }: { column: string }) => {
    if (!onSort || sortColumn !== column) {
      return <ArrowUpDown className="w-4 h-4 text-muted-foreground ml-1" />
    }
    return sortAscending 
      ? <ArrowUp className="w-4 h-4 ml-1" />
      : <ArrowDown className="w-4 h-4 ml-1" />
  }
  
  if (records.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No records found
      </div>
    )
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead 
              className={onSort ? 'cursor-pointer hover:bg-muted select-none' : ''}
              onClick={onSort ? () => handleSort('lastInteraction') : undefined}
            >
              <span className="flex items-center">
                Last Activity
                {onSort && <SortIcon column="lastInteraction" />}
              </span>
            </TableHead>
            <TableHead 
              className={onSort ? 'cursor-pointer hover:bg-muted select-none' : ''}
              onClick={onSort ? () => handleSort('lastStatus') : undefined}
            >
              <span className="flex items-center">
                Status
                {onSort && <SortIcon column="lastStatus" />}
              </span>
            </TableHead>
            <TableHead>ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => {
            const fullName = 'name' in record && record.name && typeof record.name === 'string'
              ? record.name
              : 'Unnamed'
            
            const displayName = fullName.length > 60 ? fullName.substring(0, 60) + '...' : fullName
            
            const lastInteraction = 'lastInteraction' in record && record.lastInteraction
              ? formatDate(record.lastInteraction)
              : '-'
            
            const lastStatus = 'lastStatus' in record && record.lastStatus && typeof record.lastStatus === 'string'
              ? record.lastStatus
              : 'UNKNOWN'
            
            // Status color mapping based on protocol model states
            const statusColor = lastStatus === 'COMPLETED'
              ? 'bg-green-500/10 text-green-700 dark:text-green-400'
              : lastStatus === 'FAILED'
              ? 'bg-red-500/10 text-red-700 dark:text-red-400'
              : lastStatus === 'DELEGATING'
              ? 'bg-primary/20 text-primary'
              : lastStatus === 'WAITING'
              ? 'bg-purple-500/10 text-purple-700 dark:text-purple-400'
              : lastStatus === 'PENDING'
              ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
              : 'bg-muted text-gray-800'

            return (
              <TableRow key={record.id}>
                <TableCell className="truncate" title={fullName}>
                  <Link 
                    href={`/jobDefinitions/${record.id}`}
                    className="text-primary hover:text-primary hover:underline font-medium"
                  >
                    {displayName}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {lastInteraction}
                </TableCell>
                <TableCell>
                  <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${statusColor}`}>
                    <StatusIcon status={lastStatus} size={14} />
                    {lastStatus}
                  </span>
                </TableCell>
                <TableCell>
                  <TruncatedId value={record.id} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

