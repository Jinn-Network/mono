'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { SubgraphRecord } from '@/hooks/use-subgraph-collection'
import { formatDate } from '@/lib/utils'
import { getDependencyInfo, DependencyInfo, getJobDefinition } from '@/lib/subgraph'
import { StatusIcon, mapDependencyStatusToJobStatus } from '@/components/status-icon'
import { TruncatedId } from '@/components/truncated-id'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface RequestsTableProps {
  records: SubgraphRecord[]
}

// Component to display dependency count with tooltip
function DependencyCell({ dependencies, refetchTrigger }: { dependencies?: string[]; refetchTrigger: number }) {
  const [dependencyDetails, setDependencyDetails] = useState<DependencyInfo[]>([])
  const [isHovering, setIsHovering] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (isHovering && dependencies && dependencies.length > 0) {
      setIsLoading(true)
      getDependencyInfo(dependencies)
        .then(setDependencyDetails)
        .catch(console.error)
        .finally(() => setIsLoading(false))
    }
  }, [isHovering, dependencies, refetchTrigger])

  if (!dependencies || dependencies.length === 0) {
    return <span className="text-muted-foreground">-</span>
  }

  const displayCount = dependencies.length

  return (
    <div 
      className="relative inline-block"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <span className="font-medium text-muted-foreground cursor-help">
        {displayCount}
      </span>
      
      {isHovering && (
        <div className="absolute z-50 left-0 top-full mt-1 w-64 p-3 bg-popover border rounded-lg shadow-lg">
          {isLoading ? (
            <div className="text-xs text-muted-foreground">Loading...</div>
          ) : (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-muted-foreground mb-2">
                Depends on:
              </div>
              {dependencyDetails.slice(0, 5).map((dep) => {
                const jobStatus = mapDependencyStatusToJobStatus(dep.delivered, dep.status)
                return (
                  <div key={dep.id} className="flex items-center gap-2 text-xs py-1">
                    <StatusIcon status={jobStatus} size={14} />
                    <span className="truncate" title={dep.jobName}>
                      {dep.jobName}
                    </span>
                  </div>
                )
              })}
              {dependencies.length > 5 && (
                <div className="text-xs text-muted-foreground italic mt-1">
                  +{dependencies.length - 5} more...
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Component to display job definition status icon with tooltip
function JobDefStatusCell({ jobDefId, refetchTrigger }: { jobDefId?: string; refetchTrigger: number }) {
  const [status, setStatus] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (jobDefId) {
      setIsLoading(true)
      getJobDefinition(jobDefId)
        .then((jobDef) => {
          if (jobDef?.lastStatus) {
            setStatus(jobDef.lastStatus)
          }
        })
        .catch(console.error)
        .finally(() => setIsLoading(false))
    }
  }, [jobDefId, refetchTrigger])

  if (!jobDefId) return null
  if (isLoading) return null

  return status ? <StatusIcon status={status} size={16} className="inline-block" /> : null
}

export function RequestsTable({ records }: RequestsTableProps) {
  // Note: Realtime updates are handled by useSubgraphCollection in the parent component
  // No additional subscriptions needed here - they caused excessive re-renders
  const refetchTrigger = 0 // Keep this for compatibility with child components

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
            <TableHead>Job Name</TableHead>
            <TableHead>ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Dependencies</TableHead>
            <TableHead>Workstream</TableHead>
            <TableHead>Job ID</TableHead>
            <TableHead className="text-right">Timestamp</TableHead>
            <TableHead>Mech</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => {
            const jobName = 'jobName' in record && record.jobName 
              ? (record.jobName.length > 60 ? record.jobName.substring(0, 60) + '...' : record.jobName)
              : record.id.toString().substring(0, 16) + '...'
            
            const delivered = 'delivered' in record ? record.delivered : false
            
            // Determine status based on delivered flag
            const statusText = delivered ? 'DELIVERED' : 'PENDING'
            const statusClass = delivered 
              ? 'text-green-700 dark:text-green-400 bg-green-500/10 border-green-500/30'
              : 'text-yellow-700 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/30'
            
            // Get workstream ID from Ponder (always use the indexed field)
            const workstreamId = 'workstreamId' in record ? record.workstreamId : null
            
            const mech = 'mech' in record && record.mech 
              ? record.mech 
              : null
            
            const timestamp = 'blockTimestamp' in record && record.blockTimestamp 
              ? formatDate(record.blockTimestamp) 
              : '-'

            const jobDefId = 'jobDefinitionId' in record && record.jobDefinitionId
              ? record.jobDefinitionId
              : null

            const dependencies = 'dependencies' in record ? record.dependencies as string[] : undefined

            return (
              <TableRow key={record.id}>
                <TableCell>
                  <Link 
                    href={`/requests/${record.id}`}
                    className="text-primary hover:text-primary hover:underline font-medium"
                  >
                    {jobName}
                  </Link>
                </TableCell>
                <TableCell>
                  <TruncatedId value={record.id} />
                </TableCell>
                <TableCell>
                  <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs border ${statusClass}`}>
                    {statusText}
                  </span>
                </TableCell>
                <TableCell>
                  <DependencyCell dependencies={dependencies} refetchTrigger={refetchTrigger} />
                </TableCell>
                <TableCell>
                  {workstreamId ? (
                    <TruncatedId 
                      value={workstreamId} 
                      linkTo={`/workstreams/${workstreamId}`}
                    />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {jobDefId ? (
                    <div className="flex items-center gap-2">
                      <JobDefStatusCell jobDefId={jobDefId} refetchTrigger={refetchTrigger} />
                      <TruncatedId 
                        value={jobDefId}
                        linkTo={`/jobDefinitions/${jobDefId}`}
                      />
                    </div>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {timestamp}
                </TableCell>
                <TableCell>
                  {mech ? (
                    <TruncatedId value={mech} />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

