'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface MemoryVisualizationProps {
  requestId: string
}

interface SimilarSituation {
  requestId: string
  similarity: number
  jobName?: string
  summary?: string
}

interface RecognitionData {
  similarSituations?: SimilarSituation[]
  learnings?: string
  timestamp?: string
}

interface SituationData {
  version: string
  job: {
    requestId: string
    jobDefinitionId?: string
    jobName?: string
  }
  execution: {
    status: string
    trace: Array<{
      tool: string
      args: string
      result_summary: string
    }>
    finalOutputSummary?: string
  }
  context: {
    childRequestIds: string[]
    siblingRequestIds: string[]
  }
  artifacts: Array<{
    topic: string
    name: string
    contentPreview?: string
  }>
  embedding: {
    model: string
    dim: number
    vector: number[]
  }
  meta: {
    summaryText: string
    generatedAt: string
  }
}

interface MemoryInspectionResponse {
  requestId: string
  situation: SituationData | null
  recognition: RecognitionData | null
  hasSituation: boolean
  hasRecognition: boolean
}

export function MemoryVisualization({ requestId }: MemoryVisualizationProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<MemoryInspectionResponse | null>(null)

  useEffect(() => {
    const fetchMemoryData = async () => {
      try {
        setLoading(true)
        setError(null)

        const response = await fetch(`/api/memory-inspection?requestId=${encodeURIComponent(requestId)}`)
        
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`)
        }

        const result: MemoryInspectionResponse = await response.json()
        setData(result)
        setLoading(false)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch memory data'
        setError(message)
        setLoading(false)
      }
    }

    fetchMemoryData()
  }, [requestId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>🧠 Memory System</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-gray-500">Loading memory data...</div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>🧠 Memory System</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="text-sm text-red-700 dark:text-red-400">Error: {error}</div>
            <div className="text-xs text-gray-500 bg-muted p-3 rounded border">
              <p className="font-medium mb-1">CLI inspection tool:</p>
              <code className="block bg-card p-2 rounded mt-1">
                tsx scripts/memory/inspect-situation.ts {requestId}
              </code>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!data || (!data.hasSituation && !data.hasRecognition)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>🧠 Memory System</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="text-sm text-gray-400">
              No memory data available for this request.
            </div>
            <div className="text-xs text-gray-500">
              Memory artifacts are created during job execution (recognition phase) and after completion (reflection phase).
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Recognition Phase (Pre-Job) */}
      {data.hasRecognition && data.recognition && (
        <Card>
          <CardHeader>
            <CardTitle>🔍 Recognition Phase (Pre-Job)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.recognition.similarSituations && data.recognition.similarSituations.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Similar Situations Retrieved</h3>
                <div className="space-y-2">
                  {data.recognition.similarSituations.map((situation, index) => (
                    <div key={index} className="border rounded p-3 bg-muted">
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-sm font-medium text-primary">
                          {situation.jobName || situation.requestId.slice(0, 10)}
                        </span>
                        <span className="text-xs text-gray-500">
                          Similarity: {(situation.similarity * 100).toFixed(1)}%
                        </span>
                      </div>
                      {situation.summary && (
                        <p className="text-xs text-gray-400 mt-1">{situation.summary}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {data.recognition.learnings && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Synthesized Learnings</h3>
                <div className="text-sm text-gray-400 bg-primary/10 p-3 rounded border border-primary/30 whitespace-pre-wrap">
                  {data.recognition.learnings}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Reflection Phase (Post-Job) */}
      {data.hasSituation && data.situation && (
        <Card>
          <CardHeader>
            <CardTitle>💭 Reflection Phase (Post-Job)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold mb-2">Job Information</h3>
              <div className="text-sm space-y-1">
                {data.situation.job.jobName && (
                  <div><span className="font-medium">Name:</span> {data.situation.job.jobName}</div>
                )}
                {data.situation.execution.status && (
                  <div><span className="font-medium">Status:</span> {data.situation.execution.status}</div>
                )}
                {data.situation.job.jobDefinitionId && (
                  <div className="text-xs text-gray-500">
                    <span className="font-medium">Job Definition:</span> {data.situation.job.jobDefinitionId.slice(0, 8)}...
                  </div>
                )}
              </div>
            </div>

            {data.situation.execution.trace && data.situation.execution.trace.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Execution Trace ({data.situation.execution.trace.length} steps)</h3>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {data.situation.execution.trace.slice(0, 5).map((step, index) => (
                    <div key={index} className="border-l-2 border-gray-300 pl-3 text-xs">
                      <div className="font-medium text-gray-400">
                        Step {index + 1}: {step.tool}
                      </div>
                      <div className="text-gray-400 mt-1">
                        {step.result_summary.slice(0, 150)}
                        {step.result_summary.length > 150 ? '...' : ''}
                      </div>
                    </div>
                  ))}
                  {data.situation.execution.trace.length > 5 && (
                    <div className="text-xs text-gray-500 italic">
                      ... and {data.situation.execution.trace.length - 5} more steps
                    </div>
                  )}
                </div>
              </div>
            )}

            {data.situation.execution.finalOutputSummary && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Final Output Summary</h3>
                <div className="text-sm text-gray-400 bg-green-500/10 p-3 rounded border border-green-500/30 max-h-48 overflow-y-auto">
                  {data.situation.execution.finalOutputSummary.slice(0, 600)}
                  {data.situation.execution.finalOutputSummary.length > 600 ? '...' : ''}
                </div>
              </div>
            )}

            {data.situation.artifacts && data.situation.artifacts.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Artifacts Created</h3>
                <div className="space-y-1">
                  {data.situation.artifacts.map((artifact, index) => (
                    <div key={index} className="text-xs bg-purple-500/10 p-2 rounded border border-purple-500/30">
                      <span className="font-medium">{artifact.topic}:</span> {artifact.name}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.situation.embedding && (
              <div className="text-xs text-gray-500 bg-muted p-2 rounded">
                <span className="font-medium">Embedding:</span> {data.situation.embedding.model} ({data.situation.embedding.dim}D vector)
              </div>
            )}

            <div className="text-xs text-gray-500 bg-muted p-3 rounded border">
              <p className="font-medium mb-1">Full inspection via CLI:</p>
              <code className="block bg-card p-2 rounded mt-1">
                tsx scripts/memory/inspect-situation.ts {requestId}
              </code>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
