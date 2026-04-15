'use client'

import React, { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { IdLink } from '@/components/id-link'

interface LinkedArtifactsProps {
  threadId: string
}

interface Artifact {
  id: string
  content: string
  topic?: string
  created_at: string
  status?: string
  thread_id?: string
  [key: string]: unknown // Allow other fields from the database
}

// Function to convert field names to human-readable labels - removed as unused

// Component to handle different types of values (comprehensive version from artifact-detail-view)
function ValueDisplay({ value, fieldName }: { value: unknown; fieldName: string }) {
  if (value === null || value === undefined) {
    return <span className="text-gray-400 italic">null</span>
  }

  if (typeof value === 'boolean') {
    return (
      <span className={`inline-flex items-center px-2 py-1 rounded text-xs border ${
        value 
          ? 'text-green-700 dark:text-green-400 bg-green-500/10 border-green-500/30' 
          : 'text-red-700 dark:text-red-400 bg-red-500/10 border-red-500/30'
      }`}>
        {value ? '✓ true' : '✗ false'}
      </span>
    )
  }

  if (typeof value === 'number') {
    return (
      <span className="font-mono text-sm">
        {value.toLocaleString()}
      </span>
    )
  }

  if (typeof value === 'string') {
    // Check if it's a stringified JSON object first
    if (value.trim().startsWith('{') && value.trim().endsWith('}') || 
        value.trim().startsWith('[') && value.trim().endsWith(']')) {
      try {
        const parsed = JSON.parse(value)
        // If parsing succeeds, recursively display the parsed object/array
        return (
          <div className="space-y-2">
            <div className="text-xs text-gray-500">Parsed JSON ({typeof parsed === 'object' && Array.isArray(parsed) ? 'Array' : 'Object'})</div>
            <ValueDisplay value={parsed} fieldName={fieldName} />
          </div>
        )
      } catch {
        // If parsing fails, continue with string handling below
      }
    }

    // Check if it's a UUID - show as link if it's a foreign key field
    if (value.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      // Check if this is a foreign key field that should be linked
      if (fieldName.endsWith('_id') || fieldName === 'thread_id') {
        return <IdLink id={value} fieldName={fieldName} showFullId={true} />
      }
      
      return (
        <div className="font-mono text-sm break-all text-gray-400">{value}</div>
      )
    }

    // Check if it's a date string (ISO format)
    if (value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      const date = new Date(value)
      const isValid = !isNaN(date.getTime())
      
      if (isValid) {
        return (
          <div 
            className="text-sm cursor-help" 
            title={`Technical format: ${value}`}
          >
            {date.toLocaleString('en-US', {
              weekday: 'short',
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              timeZoneName: 'short'
            })}
          </div>
        )
      }
      return <span className="text-red-600 text-sm">Invalid Date: {value}</span>
    }

    // For long strings, show in a scrollable area with word count
    if (value.length > 200) {
      const wordCount = value.split(/\s+/).length
      return (
        <div className="space-y-2">
          <div className="text-xs text-gray-500">
            {value.length} characters, ~{wordCount} words
          </div>
          <div className="max-h-32 overflow-auto bg-muted p-3 rounded border text-sm">
            {value}
          </div>
        </div>
      )
    }

    return <span className="break-words text-sm">{value}</span>
  }

  // Handle arrays
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-gray-400 italic text-sm">Empty array</span>
    }

    return (
      <div className="space-y-2">
        <div className="text-xs text-gray-500">Array ({value.length} items)</div>
        <div className="bg-muted rounded border overflow-hidden">
          <div className="max-h-64 overflow-auto p-3">
            <ul className="space-y-1">
              {value.map((item, index) => (
                <li key={index} className="flex items-start gap-2 text-sm">
                  <span className="text-muted-foreground font-mono text-xs mt-0.5">{index + 1}.</span>
                  <span className="flex-1">
                    {typeof item === 'object' ? (
                      <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
                        {JSON.stringify(item, null, 2)}
                      </pre>
                    ) : (
                      String(item)
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    )
  }

  // Handle objects
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) {
      return <span className="text-gray-400 italic text-sm">Empty object</span>
    }

    return (
      <div className="space-y-2">
        <div className="text-xs text-gray-500">Object ({keys.length} properties)</div>
        <div className="bg-muted border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Property</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Value</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key, index) => (
                <tr key={key} className={index % 2 === 0 ? '' : 'bg-card/50'}>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground border-r">
                    {key}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {typeof value === 'object' && value !== null && key in value && typeof (value as Record<string, unknown>)[key] === 'object' ? (
                      <pre className="whitespace-pre-wrap text-muted-foreground">
                        {JSON.stringify((value as Record<string, unknown>)[key], null, 2)}
                      </pre>
                    ) : (
                      String(typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : '')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return <span className="font-mono text-sm">{String(value)}</span>
}

// Simplified content display component without metadata annotations
function ContentDisplay({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-gray-400 italic">null</span>
  }

  if (typeof value === 'string') {
    // Check if it's a stringified JSON object first
    if (value.trim().startsWith('{') && value.trim().endsWith('}') || 
        value.trim().startsWith('[') && value.trim().endsWith(']')) {
      try {
        const parsed = JSON.parse(value)
        // If parsing succeeds, display the parsed object/array without metadata
        return <ContentDisplay value={parsed} />
      } catch {
        // If parsing fails, continue with string handling below
      }
    }

    // For long strings, show in a scrollable area
    if (value.length > 200) {
      return (
        <div className="max-h-96 overflow-auto bg-muted p-3 rounded border text-sm">
          {value}
        </div>
      )
    }

    return <span className="break-words text-sm">{value}</span>
  }

  // Handle arrays without metadata
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-gray-400 italic text-sm">Empty array</span>
    }

    return (
      <div className="bg-muted rounded border overflow-hidden">
        <div className="max-h-64 overflow-auto p-3">
          <ul className="space-y-1">
            {value.map((item, index) => (
              <li key={index} className="flex items-start gap-2 text-sm">
                <span className="text-muted-foreground font-mono text-xs mt-0.5">{index + 1}.</span>
                <span className="flex-1">
                  {typeof item === 'object' ? (
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
                      {JSON.stringify(item, null, 2)}
                    </pre>
                  ) : (
                    String(item)
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  }

  // Handle objects without metadata
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) {
      return <span className="text-gray-400 italic text-sm">Empty object</span>
    }

    return (
      <div className="bg-muted border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Property</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Value</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key, index) => (
              <tr key={key} className={index % 2 === 0 ? '' : 'bg-card/50'}>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground border-r">
                  {key}
                </td>
                <td className="px-3 py-2 text-xs">
                  {typeof value === 'object' && value !== null && key in value && typeof (value as Record<string, unknown>)[key] === 'object' ? (
                    <pre className="whitespace-pre-wrap text-muted-foreground">
                      {JSON.stringify((value as Record<string, unknown>)[key], null, 2)}
                    </pre>
                  ) : (
                    String(typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : '')
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  // Handle other types simply
  if (typeof value === 'boolean') {
    return (
      <span className={`inline-flex items-center px-2 py-1 rounded text-xs border ${
        value 
          ? 'text-green-700 dark:text-green-400 bg-green-500/10 border-green-500/30' 
          : 'text-red-700 dark:text-red-400 bg-red-500/10 border-red-500/30'
      }`}>
        {value ? '✓ true' : '✗ false'}
      </span>
    )
  }

  if (typeof value === 'number') {
    return (
      <span className="font-mono text-sm">
        {value.toLocaleString()}
      </span>
    )
  }

  return <span className="font-mono text-sm">{String(value)}</span>
}

// Main component to fetch and display linked artifacts as tabs
export function LinkedArtifacts({ threadId }: LinkedArtifactsProps) {
  const [linkedArtifacts, setLinkedArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchLinkedArtifacts = async () => {
      try {
        // We no longer derive linkage from artifacts; events are authoritative
        const artifacts: Artifact[] = []
        const artifactsError = null

        if (artifactsError) {
          console.error('Error fetching linked artifacts:', artifactsError)
          setError('Failed to load linked artifacts')
          return
        }

        // Ensure proper ordering by created_at descending (newest first)
        const sortedArtifacts = (artifacts || []).sort((a, b) => 
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
        setLinkedArtifacts(sortedArtifacts)
      } catch (err) {
        console.error('Error in fetchLinkedArtifacts:', err)
        setError('Failed to load linked artifacts')
      } finally {
        setLoading(false)
      }
    }

    fetchLinkedArtifacts()
  }, [threadId])

  const getTabLabel = (artifact: Artifact) => {
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

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Linked Artifacts</CardTitle>
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
          <CardTitle>Linked Artifacts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-red-500">
            {error}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (linkedArtifacts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Linked Artifacts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-gray-500">
            No artifacts are linked to this thread
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Linked Artifacts ({linkedArtifacts.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={linkedArtifacts[0].id} className="w-full">
          <div className="overflow-x-auto">
            <TabsList className="inline-flex w-auto min-w-full gap-1">
              {linkedArtifacts.map((artifact) => (
                <TabsTrigger 
                  key={artifact.id} 
                  value={artifact.id}
                  className="text-xs whitespace-nowrap flex-shrink-0"
                >
                  {getTabLabel(artifact)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          
          {linkedArtifacts.map((artifact) => (
            <TabsContent key={artifact.id} value={artifact.id} className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle>{getTabLabel(artifact)}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ContentDisplay value={artifact.content} />
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}