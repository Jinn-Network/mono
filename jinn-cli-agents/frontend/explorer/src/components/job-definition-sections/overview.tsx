'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import { queryArtifacts, queryRequests, type Artifact, type Request } from '@/lib/subgraph'
import { parseInvariants, getInvariantDisplayText, type InvariantItem } from '@/lib/invariant-utils'
import { StatusIcon } from '@/components/status-icon'
import { TruncatedId } from '@/components/truncated-id'
import { Skeleton } from '@/components/ui/skeleton'
import { useRealtimeData } from '@/hooks/use-realtime-data'

interface JobDefinition {
  id: string
  name: string
  enabledTools?: string[]
  blueprint?: string
  lastStatus?: string
  lastInteraction?: string
  latestStatusUpdate?: string
}

interface OverviewProps {
  jobDefinition: JobDefinition
}

export function JobDefinitionOverview({ jobDefinition }: OverviewProps) {
  const [recognitionArtifact, setRecognitionArtifact] = useState<Artifact | null>(null)
  const [recentRuns, setRecentRuns] = useState<Request[]>([])
  const [recentArtifacts, setRecentArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)
  const [invariants, setInvariants] = useState<InvariantItem[]>([])

  // Real-time updates
  const { isConnected } = useRealtimeData(undefined, {
    enabled: true,
    onEvent: () => {
      // Refetch data on events
      fetchData()
    }
  })

  const fetchData = async () => {
    try {
      // Parse blueprint for invariants (supports both new 'invariants' and legacy 'assertions')
      if (jobDefinition.blueprint) {
        try {
          const parsed = JSON.parse(jobDefinition.blueprint)
          const items = parseInvariants(parsed)
          if (items.length > 0) {
            setInvariants(items)
          }
        } catch {
          // Not JSON, ignore
        }
      }

      // Fetch latest SITUATION artifact and extract recognition summary
      const situationResults = await queryArtifacts({
        where: {
          sourceJobDefinitionId: jobDefinition.id,
          topic: 'SITUATION'
        },
        orderBy: 'blockTimestamp',
        orderDirection: 'desc',
        limit: 1
      })

      if (situationResults.items[0]) {
        // Fetch the full content from IPFS to get recognition data
        try {
          const response = await fetch(`https://gateway.autonolas.tech/ipfs/${situationResults.items[0].cid}`)
          const situationData = await response.json()

          // Extract recognition markdown/summary from the SITUATION artifact
          const recognitionSummary = situationData?.meta?.recognition?.markdown ||
            situationData?.meta?.recognition?.learnings ||
            situationData?.meta?.summaryText ||
            null

          if (recognitionSummary) {
            setRecognitionArtifact({
              ...situationResults.items[0],
              contentPreview: recognitionSummary
            })
          } else {
            setRecognitionArtifact(null)
          }
        } catch (error) {
          console.error('Failed to fetch SITUATION content:', error)
          setRecognitionArtifact(null)
        }
      } else {
        setRecognitionArtifact(null)
      }

      // Fetch latest 3 runs
      const runsResponse = await queryRequests({
        where: { jobDefinitionId: jobDefinition.id },
        orderBy: 'blockTimestamp',
        orderDirection: 'desc',
        limit: 3
      })
      setRecentRuns(runsResponse.items)

      // Fetch latest 3 artifacts
      const artifactsResponse = await queryArtifacts({
        where: { sourceJobDefinitionId: jobDefinition.id },
        orderBy: 'blockTimestamp',
        orderDirection: 'desc',
        limit: 3
      })
      setRecentArtifacts(artifactsResponse.items)

      setLoading(false)
    } catch (error) {
      console.error('Error fetching overview data:', error)
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [jobDefinition.id])

  if (loading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Status Badge */}
      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            {jobDefinition.latestStatusUpdate && (
              <div className="text-sm italic text-muted-foreground border-l-2 border-primary pl-3">
                "{jobDefinition.latestStatusUpdate}"
              </div>
            )}
            {jobDefinition.lastStatus && (
              <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap ${jobDefinition.lastStatus === 'COMPLETED'
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
                <StatusIcon status={jobDefinition.lastStatus} size={16} />
                {jobDefinition.lastStatus}
              </span>
            )}
            {jobDefinition.lastInteraction && (
              <div className="text-sm text-gray-500">
                Last activity: {new Date(parseInt(jobDefinition.lastInteraction) * 1000).toLocaleString()}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Job Definition ID */}
      <Card>
        <CardHeader>
          <CardTitle>Job Definition ID</CardTitle>
        </CardHeader>
        <CardContent>
          <TruncatedId value={jobDefinition.id} />
        </CardContent>
      </Card>

      {/* Recognition Progress Summary */}
      {recognitionArtifact && (
        <Card>
          <CardHeader>
            <CardTitle>Progress Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="text-sm">
                <span className="font-medium">From:</span> <TruncatedId value={recognitionArtifact.requestId} linkTo={`/requests/${recognitionArtifact.requestId}`} />
              </div>
              <div className="prose prose-sm max-w-none bg-muted p-3 rounded">
                {recognitionArtifact.contentPreview}
              </div>
              <div className="pt-2">
                <Link
                  href={`/requests/${recognitionArtifact.requestId}`}
                  className="text-sm text-primary hover:text-primary hover:underline"
                >
                  View full job run →
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Invariants Summary */}
      {invariants.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Invariants ({invariants.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {invariants.map((item, idx) => {
                const text = getInvariantDisplayText(item)
                return (
                  <div key={item.id || idx} className="text-sm">
                    <span className="font-mono font-medium">{item.id}:</span>{' '}
                    <span className="text-gray-400">
                      {text?.substring(0, 100)}
                      {text && text.length > 100 ? '...' : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Enabled Tools */}
      {jobDefinition.enabledTools && jobDefinition.enabledTools.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Enabled Tools</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {jobDefinition.enabledTools.map((tool, index) => (
                <Badge key={index} variant="outline" className="bg-primary/10 text-primary border-primary/30">
                  {tool}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Runs */}
      {recentRuns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Runs (Latest 3)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentRuns.map((run) => (
                <div key={run.id} className="flex items-center justify-between border-b pb-2 last:border-b-0">
                  <div>
                    <TruncatedId value={run.id} linkTo={`/requests/${run.id}`} />
                    <div className="text-xs text-gray-500 mt-1">
                      {new Date(parseInt(run.blockTimestamp) * 1000).toLocaleString()}
                    </div>
                  </div>
                  <Badge variant={run.delivered ? 'default' : 'secondary'}>
                    {run.delivered ? 'Delivered' : 'Pending'}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Artifacts */}
      {recentArtifacts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Artifacts (Latest 3)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentArtifacts.map((artifact) => (
                <div key={artifact.id} className="border-b pb-2 last:border-b-0">
                  <div className="font-medium text-sm">{artifact.name}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    Topic: {artifact.topic}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <TruncatedId value={artifact.cid} />
                    {artifact.blockTimestamp && (
                      <span className="text-xs text-gray-500">
                        {new Date(parseInt(artifact.blockTimestamp) * 1000).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

