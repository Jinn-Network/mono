'use client'

import { useState, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { Artifact } from '@/lib/subgraph'
import { useRealtimeData } from '@/hooks/use-realtime-data'

interface WorkstreamBriefingProps {
  rootRequestId: string
  initialBriefing: Artifact | null
}

export function WorkstreamBriefing({ rootRequestId, initialBriefing }: WorkstreamBriefingProps) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(
    initialBriefing?.blockTimestamp || null
  )

  const fetchBriefing = useCallback(async (silent: boolean = false) => {
    if (!silent) {
      setLoading(true)
    }
    
    try {
      // Fetch latest briefing artifact
      const response = await fetch(
        `/api/workstream-briefing?rootRequestId=${rootRequestId}`
      )
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      
      const data = await response.json()
      
      if (data.artifact && data.artifact.cid) {
        // Fetch IPFS content
        const ipfsResponse = await fetch(
          `https://gateway.autonolas.tech/ipfs/${data.artifact.cid}`
        )
        
        if (!ipfsResponse.ok) {
          throw new Error(`IPFS fetch error! status: ${ipfsResponse.status}`)
        }
        
        const ipfsText = await ipfsResponse.text()
        
        try {
          // Try to parse as JSON artifact structure
          const parsed = JSON.parse(ipfsText)
          if (parsed.content && typeof parsed.content === 'string') {
            setContent(parsed.content)
          } else {
            setContent(ipfsText)
          }
        } catch {
          // Not JSON, use raw content
          setContent(ipfsText)
        }
        
        setLastUpdated(data.artifact.blockTimestamp)
        setError(null)
      } else {
        setContent(null)
        setError('No launcher briefing found for this workstream')
      }
    } catch (err) {
      console.error('Error fetching briefing:', err)
      if (!silent) {
        setError(`Failed to fetch briefing: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      setLoading(false)
    }
  }, [rootRequestId])

  // Initial fetch
  useEffect(() => {
    if (initialBriefing?.cid) {
      // Use initial briefing
      fetch(`https://gateway.autonolas.tech/ipfs/${initialBriefing.cid}`)
        .then(response => response.text())
        .then(text => {
          try {
            const parsed = JSON.parse(text)
            if (parsed.content && typeof parsed.content === 'string') {
              setContent(parsed.content)
            } else {
              setContent(text)
            }
          } catch {
            setContent(text)
          }
          setLoading(false)
        })
        .catch(err => {
          console.error('Error fetching initial briefing:', err)
          setError('Failed to load briefing')
          setLoading(false)
        })
    } else {
      fetchBriefing()
    }
  }, [initialBriefing, fetchBriefing])

  // Use SSE for real-time updates to artifacts
  useRealtimeData(
    'artifacts',
    {
      enabled: true,
      onEvent: () => {
        console.log('[WorkstreamBriefing] Real-time artifact update detected, refetching briefing')
        fetchBriefing(true)
      }
    }
  )

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(Number(timestamp) * 1000)
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  if (loading) {
    return (
      <div className="text-sm text-gray-500 p-4">
        Loading launcher briefing...
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-md">
        <p className="text-sm text-yellow-700 dark:text-yellow-400">{error}</p>
        <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-2">
          This workstream may not have a launcher briefing yet.
        </p>
      </div>
    )
  }

  if (!content) {
    return (
      <div className="p-4 bg-primary/10 border border-primary/30 rounded-md">
        <p className="text-sm text-primary font-medium mb-2">
          No launcher briefing available yet
        </p>
        <p className="text-xs text-primary">
          The launcher briefing will appear after the root job completes its first execution and delivers results.
          This workstream may still be initializing or waiting to run.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Timestamp */}
      {lastUpdated && (
        <div className="text-xs text-gray-500">
          Last updated: {formatTimestamp(lastUpdated)}
        </div>
      )}

      {/* Main content */}
      <div className="prose prose-sm max-w-none bg-card p-6 rounded-lg border">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </div>
  )
}



