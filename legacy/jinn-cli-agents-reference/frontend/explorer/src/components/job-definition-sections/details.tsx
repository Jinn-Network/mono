'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { queryRequests, type Request } from '@/lib/subgraph'
import { StatusIcon } from '@/components/status-icon'
import { TruncatedId } from '@/components/truncated-id'
import { useRealtimeData } from '@/hooks/use-realtime-data'

interface JobDefinition {
  id: string
  name: string
  lastStatus?: string
  lastInteraction?: string
  sourceJobDefinitionId?: string
  sourceRequestId?: string
}

interface DetailsProps {
  jobDefinition: JobDefinition
}

export function JobDefinitionDetails({ jobDefinition }: DetailsProps) {
  const [workstreamId, setWorkstreamId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Real-time updates
  const { isConnected } = useRealtimeData('requests', { 
    enabled: true,
    onEvent: () => {
      fetchWorkstream()
    }
  })

  const fetchWorkstream = async () => {
    try {
      // Get workstream from first run
      const runsResponse = await queryRequests({
        where: { jobDefinitionId: jobDefinition.id },
        orderBy: 'blockTimestamp',
        orderDirection: 'desc',
        limit: 1
      })
      
      if (runsResponse.items.length > 0) {
        const latestRun = runsResponse.items[0]
        setWorkstreamId(latestRun.workstreamId || latestRun.id)
      }
      setLoading(false)
    } catch (error) {
      console.error('Error fetching workstream:', error)
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchWorkstream()
  }, [jobDefinition.id])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Job Definition Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Full ID */}
            <div>
              <div className="text-sm font-medium text-gray-400 mb-1">Full ID</div>
              <div className="text-sm text-gray-400 font-mono break-all">
                {jobDefinition.id}
              </div>
            </div>

            {/* Status */}
            {jobDefinition.lastStatus && (
              <div>
                <div className="text-sm font-medium text-gray-400 mb-1">Status</div>
                <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${
                  jobDefinition.lastStatus === 'COMPLETED'
                    ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                    : jobDefinition.lastStatus === 'FAILED'
                    ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                    : jobDefinition.lastStatus === 'DELEGATING'
                    ? 'bg-primary/20 text-primary'
                    : jobDefinition.lastStatus === 'WAITING'
                    ? 'bg-purple-500/10 text-purple-700 dark:text-purple-400'
                    : jobDefinition.lastStatus === 'PENDING'
                    ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
                    : 'bg-muted text-gray-800'
                }`}>
                  <StatusIcon status={jobDefinition.lastStatus} size={14} />
                  {jobDefinition.lastStatus}
                </span>
              </div>
            )}

            {/* Workstream Link */}
            {loading ? (
              <div>
                <div className="text-sm font-medium text-gray-400 mb-1">Workstream</div>
                <div className="text-sm text-gray-500">Loading...</div>
              </div>
            ) : workstreamId ? (
              <div>
                <div className="text-sm font-medium text-gray-400 mb-1">Workstream</div>
                <TruncatedId 
                  value={workstreamId}
                  linkTo={`/workstreams/${workstreamId}`}
                />
              </div>
            ) : null}

            {/* Source Job Definition */}
            {jobDefinition.sourceJobDefinitionId && (
              <div>
                <div className="text-sm font-medium text-gray-400 mb-1">Source Job Definition</div>
                <TruncatedId 
                  value={jobDefinition.sourceJobDefinitionId}
                  linkTo={`/jobDefinitions/${jobDefinition.sourceJobDefinitionId}`}
                />
              </div>
            )}

            {/* Source Request */}
            {jobDefinition.sourceRequestId && (
              <div>
                <div className="text-sm font-medium text-gray-400 mb-1">Source Job Execution</div>
                <TruncatedId 
                  value={jobDefinition.sourceRequestId}
                  linkTo={`/requests/${jobDefinition.sourceRequestId}`}
                />
              </div>
            )}

            {/* Last Interaction */}
            {jobDefinition.lastInteraction && (
              <div>
                <div className="text-sm font-medium text-gray-400 mb-1">Last Interaction</div>
                <div className="text-sm text-gray-400">
                  {new Date(parseInt(jobDefinition.lastInteraction) * 1000).toLocaleString()}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

