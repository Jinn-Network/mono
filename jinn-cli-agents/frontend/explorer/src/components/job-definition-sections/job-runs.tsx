'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RequestsTable } from '@/components/requests-table'
import { RequestsTableSkeleton } from '@/components/loading-skeleton'
import { queryRequests, type Request } from '@/lib/subgraph'
import { useRealtimeData } from '@/hooks/use-realtime-data'

interface JobDefinition {
  id: string
  name: string
}

interface JobRunsProps {
  jobDefinition: JobDefinition
}

export function JobDefinitionJobRuns({ jobDefinition }: JobRunsProps) {
  const [jobRuns, setJobRuns] = useState<Request[]>([])
  const [loading, setLoading] = useState(true)

  // Real-time updates
  const { isConnected } = useRealtimeData('requests', { 
    enabled: true,
    onEvent: () => {
      fetchRuns()
    }
  })

  const fetchRuns = async () => {
    try {
      const runsResponse = await queryRequests({
        where: { jobDefinitionId: jobDefinition.id },
        orderBy: 'blockTimestamp',
        orderDirection: 'desc',
      })
      
      setJobRuns(runsResponse.items)
      setLoading(false)
    } catch (error) {
      console.error('Error fetching job runs:', error)
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchRuns()
  }, [jobDefinition.id])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>All Job Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <RequestsTableSkeleton />
          ) : jobRuns.length > 0 ? (
            <RequestsTable records={jobRuns} />
          ) : (
            <div className="text-center py-8 text-gray-500">
              No runs found for this job definition
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

