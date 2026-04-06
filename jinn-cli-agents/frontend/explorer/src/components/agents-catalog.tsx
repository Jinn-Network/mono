'use client'

import * as React from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Activity, Play, Zap } from 'lucide-react'

// Agent type from Ponder job_template
interface JobTemplate {
  id: string
  name: string
  description: string | null
  tags: string[]
  priceWei: string
  priceUsd: string | null
  runCount: number
  lastUsedAt: string | null
}

const PONDER_URL = process.env.NEXT_PUBLIC_PONDER_URL || 'https://indexer.jinn.network/graphql'

function formatLastRun(timestamp: string): string {
  const date = new Date(parseInt(timestamp) * 1000) // Convert Unix timestamp
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function AgentsCatalog() {
  const [agents, setAgents] = React.useState<JobTemplate[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    async function fetchAgents() {
      try {
        const res = await fetch(PONDER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `{
              jobTemplates(limit: 100, orderBy: "runCount", orderDirection: "desc") {
                items {
                  id
                  name
                  description
                  tags
                  priceWei
                  priceUsd
                  runCount
                  lastUsedAt
                }
              }
            }`
          })
        })

        if (!res.ok) throw new Error('Failed to fetch agents')
        const data = await res.json()

        if (data.errors) {
          throw new Error(data.errors[0].message)
        }

        setAgents(data.data.jobTemplates.items || [])
      } catch (err: any) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    fetchAgents()
  }, [])

  if (loading) {
    return <AgentsLoading />
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-destructive">Error: {error}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>

      {agents.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No active agents found
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function AgentCard({ agent }: { agent: JobTemplate }) {
  const lastRun = agent.lastUsedAt
    ? formatLastRun(agent.lastUsedAt)
    : 'Never'

  // Clean description - remove "Auto-derived from job:" prefix
  const cleanDescription = agent.description
    ?.replace(/^Auto-derived from job:\s*/i, '')
    ?.trim() || 'Active agent'

  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-lg truncate">{agent.name}</CardTitle>
            <CardDescription className="line-clamp-2 text-xs mt-1">
              {cleanDescription}
            </CardDescription>
          </div>
          <Activity className="h-4 w-4 text-green-500 shrink-0" />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Execution Stats */}
        <div className="text-sm">
          <div className="text-muted-foreground text-xs">Total Runs</div>
          <div className="font-medium text-lg">{agent.runCount.toLocaleString()}</div>
        </div>

        {/* Last Activity */}
        <div className="text-sm">
          <div className="text-muted-foreground text-xs">Last Run</div>
          <div className="font-medium">{lastRun}</div>
        </div>

        {/* Price */}
        {(agent.priceUsd || agent.priceWei !== '0') && (
          <div className="flex items-center gap-1 text-sm">
            <Zap className="h-3 w-3 text-yellow-500" />
            {agent.priceUsd || `${parseFloat(agent.priceWei) / 1e18} ETH`}
          </div>
        )}

        {/* Tags */}
        {agent.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {agent.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="secondary" className="text-[10px]">
                {tag}
              </Badge>
            ))}
            {agent.tags.length > 3 && (
              <Badge variant="secondary" className="text-[10px]">
                +{agent.tags.length - 3}
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AgentsLoading() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-full mt-2" />
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
