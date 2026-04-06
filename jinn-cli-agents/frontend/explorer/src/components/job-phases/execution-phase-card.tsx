'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { RequestsTable } from '../requests-table'
import { RequestsTableSkeleton } from '../loading-skeleton'
import { useState, useEffect } from 'react'
import { queryRequests, type Request } from '@/lib/subgraph'

interface ExecutionTrace {
  tool: string
  args: string
  result_summary: string
}

interface Artifact {
  topic: string
  name: string
  contentPreview?: string
  cid?: string
}

interface ExecutionPhaseCardProps {
  status?: string
  trace?: ExecutionTrace[]
  finalOutputSummary?: string
  artifacts?: Artifact[]
  tokens?: number
  duration?: number
  childRequestIds?: string[]
}

export function ExecutionPhaseCard({ 
  status, 
  trace, 
  finalOutputSummary, 
  artifacts,
  tokens,
  duration,
  childRequestIds
}: ExecutionPhaseCardProps) {
  const [childJobs, setChildJobs] = useState<Request[]>([])
  const [loadingChildren, setLoadingChildren] = useState(false)

  useEffect(() => {
    const fetchChildJobs = async () => {
      if (!childRequestIds || childRequestIds.length === 0) return

      setLoadingChildren(true)
      try {
        // Fetch all child jobs
        const jobs = await Promise.all(
          childRequestIds.map(id => 
            queryRequests({ where: { id }, orderBy: 'blockTimestamp', orderDirection: 'desc' })
              .then(results => results.items[0])
              .catch(() => null)
          )
        )
        setChildJobs(jobs.filter(Boolean) as Request[])
      } catch (error) {
        console.error('Error fetching child jobs:', error)
      } finally {
        setLoadingChildren(false)
      }
    }

    fetchChildJobs()
  }, [childRequestIds])

  const getStatusColor = (status?: string) => {
    switch (status?.toUpperCase()) {
      case 'COMPLETED':
        return 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30'
      case 'FAILED':
        return 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30'
      case 'RUNNING':
        return 'bg-primary/20 text-primary border-blue-300'
      default:
        return 'bg-muted text-gray-800 border-gray-300'
    }
  }

  return (
    <Card className="border-green-500/30 bg-green-500/10/50">
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2">
          ⚙️ Execution Phase
          {status && (
            <Badge 
              variant={
                status.toUpperCase() === 'COMPLETED' ? 'default' :
                status.toUpperCase() === 'FAILED' ? 'destructive' :
                'secondary'
              }
              className="ml-auto"
            >
              {status}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {(tokens !== undefined || duration !== undefined) && (
          <div className="flex gap-4 text-sm">
            {tokens !== undefined && (
              <div className="bg-card px-3 py-2 rounded border">
                <span className="text-gray-400">Tokens:</span>{' '}
                <span className="font-semibold text-gray-900">{tokens.toLocaleString()}</span>
              </div>
            )}
            {duration !== undefined && (
              <div className="bg-card px-3 py-2 rounded border">
                <span className="text-gray-400">Duration:</span>{' '}
                <span className="font-semibold text-gray-900">{(duration / 1000).toFixed(1)}s</span>
              </div>
            )}
          </div>
        )}

        {trace && trace.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-400 mb-2">
              Execution Trace ({trace.length} steps)
            </h4>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {trace.map((step, index) => (
                <div key={index} className="border-l-4 border-green-400 pl-4 py-2 bg-card rounded-r">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-gray-500">Step {index + 1}</span>
                    <span className="text-sm font-medium text-gray-900">{step.tool}</span>
                  </div>
                  <div className="text-xs text-gray-400">
                    {step.result_summary.slice(0, 200)}
                    {step.result_summary.length > 200 ? '...' : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {finalOutputSummary && (
          <div>
            <h4 className="text-sm font-semibold text-gray-400 mb-2">Final Output</h4>
            <div className="text-sm text-gray-900 bg-card p-4 rounded border max-h-64 overflow-y-auto whitespace-pre-wrap">
              {finalOutputSummary}
            </div>
          </div>
        )}

        {artifacts && artifacts.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-400 mb-2">Artifacts Created</h4>
            <div className="space-y-2">
              {artifacts.map((artifact, index) => (
                <div key={index} className="bg-card p-3 rounded border border-green-500/30">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="secondary" className="text-green-700 bg-green-500/10">
                      {artifact.topic}
                    </Badge>
                    <span className="text-sm font-medium text-gray-900 flex-1">{artifact.name}</span>
                    {artifact.cid && (
                      <a
                        href={`https://gateway.autonolas.tech/ipfs/${artifact.cid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:text-primary hover:underline"
                      >
                        IPFS ↗
                      </a>
                    )}
                  </div>
                  {artifact.contentPreview && (
                    <p className="text-xs text-gray-400 truncate">{artifact.contentPreview}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {childRequestIds && childRequestIds.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-400 mb-2">
              Child Jobs Spawned ({childRequestIds.length})
            </h4>
            {loadingChildren ? (
              <RequestsTableSkeleton />
            ) : childJobs.length > 0 ? (
              <RequestsTable records={childJobs} />
            ) : (
              <div className="text-center py-8 text-gray-500 bg-card rounded border">
                Loading child jobs...
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

