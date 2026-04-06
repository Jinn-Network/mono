'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

interface ThreadCitationsProps {
  threadId: string
}

interface Artifact {
  id: string
  content: string
  topic?: string
  created_at: string
  status?: string
  thread_id?: string
}

// Component to display a single artifact citation card
function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const getTitle = () => {
    // Show topic name + first 5 digits of UUID
    const uuidPrefix = artifact.id.substring(0, 5)
    if (artifact.topic) {
      return `${artifact.topic} ${uuidPrefix}`
    }
    if (artifact.content) {
      const contentPreview = artifact.content.length > 60 
        ? artifact.content.substring(0, 60) + '...'
        : artifact.content
      return `${contentPreview} ${uuidPrefix}`
    }
    return `${artifact.id.substring(0, 8)}...`
  }



  return (
    <div className="bg-card border border-border rounded-lg p-4 hover:bg-accent transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Link 
              href={`/artifacts/${artifact.id}`}
              className="text-primary hover:text-primary hover:underline font-medium truncate"
            >
              {getTitle()}
            </Link>
            {/* Removed RAW status label */}
          </div>
          <div className="text-sm text-gray-400">
            {artifact.created_at && (
              <span>Created: {new Date(artifact.created_at).toLocaleDateString()}</span>
            )}
          </div>
        </div>
        <div className="text-xs text-gray-400 uppercase tracking-wide">
          artifact
        </div>
      </div>
    </div>
  )
}

// Main component to fetch and display thread citations
export function ThreadCitations({ threadId }: ThreadCitationsProps) {
  const [citingArtifacts, setCitingArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchCitingArtifacts() {
      try {
        setLoading(true)
        setError(null)
        
        // We no longer derive citations from artifacts; events are authoritative
        const artifacts: Artifact[] = []
        const artifactsError = null

        if (artifactsError) {
          console.error('Error fetching citing artifacts:', artifactsError)
          setError('Failed to load citing artifacts')
          return
        }

        setCitingArtifacts(artifacts || [])
      } catch (err) {
        console.error('Error in fetchCitingArtifacts:', err)
        setError('Failed to load citing artifacts')
      } finally {
        setLoading(false)
      }
    }

    fetchCitingArtifacts()
  }, [threadId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Citing Artifacts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-gray-500">
            Loading...
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Citing Artifacts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-red-500">
            {error}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Citing Artifacts (deprecated by events) {citingArtifacts.length > 0 && `(${citingArtifacts.length})`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {citingArtifacts.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            Citations are now modeled via events. No artifact-based citations shown.
          </div>
        ) : (
          <div className="space-y-3">
            {citingArtifacts.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}