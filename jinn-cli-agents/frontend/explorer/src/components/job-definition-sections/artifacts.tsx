'use client'

import { useEffect, useState } from 'react'
import { queryArtifacts, type Artifact } from '@/lib/subgraph'
import { ArtifactsTable } from '@/components/artifacts-table'
import { ArtifactsTableSkeleton } from '@/components/loading-skeleton'
import { useRealtimeData } from '@/hooks/use-realtime-data'

interface JobDefinition {
  id: string
  name: string
}

interface ArtifactsProps {
  jobDefinition: JobDefinition
}

export function JobDefinitionArtifacts({ jobDefinition }: ArtifactsProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)

  // Real-time updates
  const { isConnected } = useRealtimeData('artifacts', { 
    enabled: true,
    onEvent: () => {
      fetchArtifacts()
    }
  })

  const fetchArtifacts = async () => {
    try {
      const artifactsResponse = await queryArtifacts({
        where: { sourceJobDefinitionId: jobDefinition.id },
        orderBy: 'blockTimestamp',
        orderDirection: 'desc',
      })
      
      setArtifacts(artifactsResponse.items)
      setLoading(false)
    } catch (error) {
      console.error('Error fetching artifacts:', error)
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchArtifacts()
  }, [jobDefinition.id])

  if (loading) {
    return <ArtifactsTableSkeleton />
  }

  return <ArtifactsTable records={artifacts} />
}

