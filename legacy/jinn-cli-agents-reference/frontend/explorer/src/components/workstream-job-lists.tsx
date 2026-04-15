'use client'

import React, { useMemo, useEffect } from 'react'
import { useSubgraphCollection } from '@/hooks/use-subgraph-collection'
import { JobDefinitionsTable } from '@/components/job-definitions-table'
import { RequestsTable } from '@/components/requests-table'
import { Request, JobDefinition } from '@/lib/subgraph'
import { Card, CardContent } from '@/components/ui/card'

interface WorkstreamJobListsProps {
  workstreamId: string
  onCountUpdate?: (count: number) => void
}

export function WorkstreamJobRunsList({ workstreamId, onCountUpdate }: WorkstreamJobListsProps) {
  const whereFilter = useMemo(() => ({ workstreamId }), [workstreamId])

  const { 
    records: requests, 
    loading, 
    error 
  } = useSubgraphCollection({
    collectionName: 'requests',
    whereFilter,
    sortColumn: 'blockTimestamp',
    sortAscending: false,
    pageSize: 500, // Match the page limit
    enablePolling: true,
    pollingInterval: 5000
  })

  // Update count when data changes
  useEffect(() => {
    if (onCountUpdate && !loading) {
      onCountUpdate(requests.length)
    }
  }, [requests.length, loading, onCountUpdate])

  if (loading && requests.length === 0) {
    return (
      <Card>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent>
          <div className="text-red-500">Error loading job runs: {error}</div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="pt-6">
        {requests.length === 0 ? (
          <p className="text-gray-500 text-sm">No job runs found in this workstream yet</p>
        ) : (
          <RequestsTable records={requests} />
        )}
      </CardContent>
    </Card>
  )
}

export function WorkstreamJobDefinitionsList({ workstreamId, onCountUpdate }: WorkstreamJobListsProps) {
  // 1. Fetch all requests in the workstream
  const requestsWhereFilter = useMemo(() => ({ workstreamId }), [workstreamId])

  const { 
    records: requests, 
    loading: loadingRequests 
  } = useSubgraphCollection({
    collectionName: 'requests',
    whereFilter: requestsWhereFilter,
    pageSize: 500,
    enablePolling: true,
    pollingInterval: 5000
  })

  // 2. Extract unique Job Definition IDs
  const uniqueJobDefIds = useMemo(() => {
    const ids = new Set<string>()
    requests.forEach(r => {
      if ((r as Request).jobDefinitionId) {
        ids.add((r as Request).jobDefinitionId!)
      }
    })
    return Array.from(ids)
  }, [requests])

  // 3. Fetch Job Definitions details
  // We use useSubgraphCollection again, filtering by ID
  const jobDefsWhereFilter = useMemo(() => (
    uniqueJobDefIds.length > 0 ? { id_in: uniqueJobDefIds } : { id: 'non-existent' }
  ), [uniqueJobDefIds])

  const {
    records: jobDefinitions,
    loading: loadingJobDefs
  } = useSubgraphCollection({
    collectionName: 'jobDefinitions',
    whereFilter: jobDefsWhereFilter,
    pageSize: uniqueJobDefIds.length > 0 ? uniqueJobDefIds.length : 10,
    enablePolling: true,
    pollingInterval: 10000
  })

  // 4. Aggregate data
  const aggregatedDefinitions = useMemo(() => {
    const jobDefsById = new Map(
      jobDefinitions.map(jd => [jd.id, jd as JobDefinition])
    )

    const jobDefinitionMap = new Map<string, {
      id: string
      name: string
      enabledTools: string[]
      lastInteraction: string
      lastStatus: string
      runCount: number
    }>()

    for (const item of requests) {
      const job = item as Request
      if (job.jobDefinitionId) {
        const existing = jobDefinitionMap.get(job.jobDefinitionId)
        if (existing) {
          existing.runCount++
          if (BigInt(job.blockTimestamp) > BigInt(existing.lastInteraction)) {
            existing.lastInteraction = job.blockTimestamp
          }
        } else {
          const jobDef = jobDefsById.get(job.jobDefinitionId)
          jobDefinitionMap.set(job.jobDefinitionId, {
            id: job.jobDefinitionId,
            name: jobDef?.name || job.jobName || 'Unnamed Job',
            enabledTools: jobDef?.enabledTools || job.enabledTools || [],
            lastInteraction: job.blockTimestamp,
            lastStatus: jobDef?.lastStatus || (job.delivered ? 'COMPLETED' : 'PENDING'),
            runCount: 1
          })
        }
      }
    }

    return Array.from(jobDefinitionMap.values()).map(def => ({
      id: def.id,
      enabledTools: def.enabledTools,
      name: def.name,
      lastInteraction: def.lastInteraction,
      lastStatus: def.lastStatus,
    }))
  }, [requests, jobDefinitions])

  const loading = loadingRequests || (uniqueJobDefIds.length > 0 && loadingJobDefs && jobDefinitions.length === 0)

  // Update count when data changes
  useEffect(() => {
    if (onCountUpdate && !loading) {
      onCountUpdate(aggregatedDefinitions.length)
    }
  }, [aggregatedDefinitions.length, loading, onCountUpdate])

  if (loading && aggregatedDefinitions.length === 0) {
    return (
      <Card>
        <CardContent>
           <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="pt-6">
        {aggregatedDefinitions.length === 0 ? (
          <p className="text-gray-500 text-sm">No job definitions found in this workstream yet</p>
        ) : (
          <JobDefinitionsTable records={aggregatedDefinitions} />
        )}
      </CardContent>
    </Card>
  )
}

