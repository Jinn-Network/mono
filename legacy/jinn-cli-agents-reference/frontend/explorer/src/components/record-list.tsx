import React from 'react'
import Link from 'next/link'
import { CollectionName } from '@/lib/types'
import { SubgraphRecord } from '@/hooks/use-subgraph-collection'
import { IdLink } from '@/components/id-link'
import { formatDate } from '@/lib/utils'
import { StatusIcon } from '@/components/status-icon'
import { Badge } from '@/components/ui/badge'

interface RecordListProps {
  records: SubgraphRecord[]
  collectionName: CollectionName
}

// Helper function to get the primary identifier for a record
function getPrimaryIdentifier(record: SubgraphRecord): string {
  // Priority order for identifying fields based on record type
  if ('name' in record && record.name) {
    // Job definitions have names
    const value = record.name
    return value.length > 80 ? value.substring(0, 80) + '...' : value
  }
  
  if ('jobName' in record && record.jobName) {
    // Requests can have job names
    const value = record.jobName
    return value.length > 80 ? value.substring(0, 80) + '...' : value
  }
  
  if ('topic' in record && record.topic) {
    // Artifacts have topics
    const value = record.topic
    return value.length > 80 ? value.substring(0, 80) + '...' : value
  }
  
  // Fall back to ID
  return record.id.toString()
}

// Helper function to get status display
function getStatusDisplay(record: SubgraphRecord): { status: string; className: string; showIcon: boolean } | null {
  // Check if this is a job definition with lastStatus
  if ('lastStatus' in record && record.lastStatus && typeof record.lastStatus === 'string') {
    const lastStatus = record.lastStatus
    const statusColor = lastStatus === 'COMPLETED'
      ? 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30'
      : lastStatus === 'FAILED'
      ? 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30'
      : lastStatus === 'DELEGATING'
      ? 'bg-primary/20 text-primary border-primary/30'
      : lastStatus === 'WAITING'
      ? 'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/30'
      : lastStatus === 'PENDING'
      ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30'
      : 'bg-muted text-muted-foreground border-muted-foreground/30'
    
    return {
      status: lastStatus,
      className: statusColor,
      showIcon: true
    }
  }
  
  // Check if this is a request and show delivery status
  if ('delivered' in record) {
    if (record.delivered) {
      return {
        status: 'DELIVERED',
        className: 'text-green-700 dark:text-green-400 bg-green-500/10 border-green-500/30',
        showIcon: false
      }
    }
    
    return {
      status: 'PENDING',
      className: 'text-yellow-700 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
      showIcon: false
    }
  }
  
  return null
}

// Helper function to get secondary information based on collection type
function getSecondaryInfo(record: SubgraphRecord, collectionName: CollectionName): React.ReactNode[] {
  const info: React.ReactNode[] = []
  
  switch (collectionName) {
    case 'jobDefinitions':
      if ('enabledTools' in record && record.enabledTools && record.enabledTools.length > 0) {
        info.push(`Tools: ${record.enabledTools.join(', ')}`)
      }
      if ('sourceJobDefinitionId' in record && record.sourceJobDefinitionId) {
        info.push(
          <span key="source_job_def">
            Source Job: <IdLink id={record.sourceJobDefinitionId} fieldName="jobDefinitionId" />
          </span>
        )
      }
      if ('sourceRequestId' in record && record.sourceRequestId) {
        info.push(
          <span key="source_request">
            Source Job Execution: <IdLink id={record.sourceRequestId} fieldName="requestId" />
          </span>
        )
      }
      break
      
    case 'requests':
      if ('mech' in record && record.mech) {
        info.push(`Mech: ${record.mech.slice(0, 10)}...`)
      }
      if ('sender' in record && record.sender) {
        info.push(`Sender: ${record.sender.slice(0, 10)}...`)
      }
      if ('enabledTools' in record && record.enabledTools && record.enabledTools.length > 0) {
        info.push(`Tools: ${record.enabledTools.join(', ')}`)
      }
      if ('sourceJobDefinitionId' in record && record.sourceJobDefinitionId) {
        info.push(
          <span key="job_def">
            Job Def: <IdLink id={record.sourceJobDefinitionId} fieldName="jobDefinitionId" />
          </span>
        )
      }
      break
      
    case 'deliveries':
      if ('mech' in record && record.mech) {
        info.push(`Mech: ${record.mech.slice(0, 10)}...`)
      }
      if ('deliveryRate' in record && record.deliveryRate) {
        info.push(`Rate: ${record.deliveryRate}`)
      }
      if ('requestId' in record && record.requestId) {
        info.push(
          <span key="request">
            Job Execution: <IdLink id={record.requestId} fieldName="requestId" />
          </span>
        )
      }
      break

    case 'artifacts':
      if ('cid' in record && record.cid) {
        info.push(`CID: ${record.cid.slice(0, 20)}...`)
      }
      if ('requestId' in record && record.requestId) {
        info.push(
          <span key="request">
            Job Execution: <IdLink id={record.requestId} fieldName="requestId" />
          </span>
        )
      }
      if ('contentPreview' in record && record.contentPreview) {
        const preview = record.contentPreview
        info.push(preview.length > 100 ? preview.substring(0, 100) + '...' : preview)
      }
      break
  }
  
  return info
}

export function RecordList({ records, collectionName }: RecordListProps) {
  if (records.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        No records found
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {records.map((record) => {
        const primaryId = getPrimaryIdentifier(record)
        const statusDisplay = getStatusDisplay(record)
        const secondaryInfo = getSecondaryInfo(record, collectionName)
        
        return (
          <div key={record.id} className="bg-card border border-border rounded-lg p-4 hover:bg-accent transition-colors">
            <div className="flex items-start justify-between gap-4">
              {/* Main content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2">
                  <Link 
                    href={`/${collectionName}/${record.id}`}
                    className="text-primary hover:text-primary hover:underline font-medium truncate"
                  >
                    {primaryId}
                  </Link>
                  
                  {statusDisplay && (
                    <Badge 
                      variant={
                        statusDisplay.status === 'COMPLETED' || statusDisplay.status === 'DELIVERED' ? 'default' :
                        statusDisplay.status === 'FAILED' ? 'destructive' :
                        'secondary'
                      }
                      className="gap-1.5"
                    >
                      {statusDisplay.showIcon && <StatusIcon status={statusDisplay.status} size={14} />}
                      {statusDisplay.status}
                    </Badge>
                  )}
                </div>
                
                {secondaryInfo.length > 0 && (
                  <div className="text-sm text-gray-400 space-y-1">
                    {secondaryInfo.map((info, index) => (
                      <div key={index}>{info}</div>
                    ))}
                  </div>
                )}
              </div>
              
              {/* Timestamps */}
              <div className="text-right text-sm text-gray-500 flex-shrink-0">
                {'blockTimestamp' in record && record.blockTimestamp && (
                  <div>Block: {formatDate(record.blockTimestamp)}</div>
                )}
                {'blockNumber' in record && record.blockNumber && (
                  <div>Block #: {record.blockNumber.toString()}</div>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}