'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  getJobDefinition,
  getRequest,
  getWorkstreamMeasurements,
  fetchIpfsContent,
  type Artifact,
} from '@/lib/subgraph'
import {
  InvariantCard,
  parseInvariants,
  matchInvariantsWithMeasurements,
  countByStatus,
  type Invariant,
  type LegacyInvariant,
  type HealthStatus,
  type InvariantWithMeasurementDisplay,
} from '@jinn/shared-ui'

interface WorkstreamHealthProps {
  workstreamId: string
  /** Override blueprint from venture (instead of resolving from template) */
  ventureBlueprint?: unknown
}

interface StatusCount {
  healthy: number
  warning: number
  critical: number
  unknown: number
}

function HealthSummary({ counts }: { counts: StatusCount }) {
  const total = counts.healthy + counts.warning + counts.critical + counts.unknown
  const healthyPercent = total > 0 ? Math.round((counts.healthy / total) * 100) : 0

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-2xl font-bold">{healthyPercent}% Healthy</div>
            <div className="text-sm text-muted-foreground">
              {counts.healthy} of {total} invariants passing
            </div>
          </div>
          <div className="flex gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-500">{counts.healthy}</div>
              <div className="text-xs text-muted-foreground">Healthy</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-yellow-500">{counts.warning}</div>
              <div className="text-xs text-muted-foreground">Warning</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-500">{counts.critical}</div>
              <div className="text-xs text-muted-foreground">Critical</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-muted-foreground">{counts.unknown}</div>
              <div className="text-xs text-muted-foreground">Unknown</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function WorkstreamHealth({ workstreamId, ventureBlueprint }: WorkstreamHealthProps) {
  const [loading, setLoading] = useState(true)
  const [invariants, setInvariants] = useState<InvariantWithMeasurementDisplay[]>([])
  const [statusCounts, setStatusCounts] = useState<StatusCount>({ healthy: 0, warning: 0, critical: 0, unknown: 0 })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadData() {
      setLoading(true)
      setError(null)

      try {
        // Fetch root request to get job definition ID and IPFS hash
        const rootRequest = await getRequest(workstreamId)
        if (!rootRequest) {
          setError('Workstream not found')
          setLoading(false)
          return
        }

        // Use venture blueprint if provided (venture-level invariants take priority)
        let blueprintJson: unknown = ventureBlueprint ?? null

        if (!blueprintJson) {
          // Try to get blueprint from IPFS first (source of truth)
          if (rootRequest.ipfsHash) {
            try {
              const ipfsResult = await fetchIpfsContent(rootRequest.ipfsHash)
              if (ipfsResult) {
                const parsed = JSON.parse(ipfsResult.content)
                // Extract blueprint (new architecture) or try to parse as blueprint directly
                const rawBlueprint = parsed.blueprint || parsed.prompt || ipfsResult.content
                if (typeof rawBlueprint === 'string') {
                  try {
                    blueprintJson = JSON.parse(rawBlueprint)
                  } catch {
                    // Not JSON, might be raw text
                  }
                } else {
                  blueprintJson = rawBlueprint
                }
              }
            } catch (e) {
              console.error('Failed to fetch/parse IPFS content:', e)
            }
          }

          // Fallback to job definition blueprint
          if (!blueprintJson && rootRequest.jobDefinitionId) {
            const jobDef = await getJobDefinition(rootRequest.jobDefinitionId)
            if (jobDef?.blueprint) {
              try {
                blueprintJson = JSON.parse(jobDef.blueprint)
              } catch {
                // Not JSON
              }
            }
          }
        }

        // Parse invariants from blueprint
        const parsedInvariants = parseInvariants(blueprintJson)

        if (parsedInvariants.length === 0) {
          setInvariants([])
          setStatusCounts({ healthy: 0, warning: 0, critical: 0, unknown: 0 })
          setLoading(false)
          return
        }

        // Fetch measurement artifacts
        const measurements = await getWorkstreamMeasurements(workstreamId)

        // Match invariants with measurements
        const matched = matchInvariantsWithMeasurements(parsedInvariants, measurements)

        // Calculate status counts
        const counts = countByStatus(matched)

        setInvariants(matched)
        setStatusCounts(counts)
      } catch (e) {
        console.error('Error loading workstream health:', e)
        setError('Failed to load health data')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [workstreamId])

  if (loading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="py-6">
            <div className="animate-pulse space-y-4">
              <div className="h-8 w-32 bg-muted rounded" />
              <div className="h-4 w-48 bg-muted rounded" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="h-6 w-24 bg-muted rounded animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-20 bg-muted rounded animate-pulse" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          {error}
        </CardContent>
      </Card>
    )
  }

  if (invariants.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No blueprint invariants found for this workstream
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <HealthSummary counts={statusCounts} />

      <Card>
        <CardHeader>
          <CardTitle>Invariants</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {invariants.map((item) => (
              <div key={item.id} className="p-4">
                <InvariantCard
                  invariant={item.invariant}
                  measurement={item.measurement}
                  status={item.status}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
