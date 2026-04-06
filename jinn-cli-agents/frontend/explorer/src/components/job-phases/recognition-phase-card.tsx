'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import { CheckCircle2, XCircle } from 'lucide-react'

interface RecognitionData {
  searchQuery?: string
  similarJobs?: Array<{
    requestId: string
    score: number
    jobName?: string
  }>
  learnings: string | object[]
  timestamp?: string
  initialSituation?: Record<string, unknown>
  embeddingStatus?: 'success' | 'failed' | 'unknown'
  progressCheckpoint?: {
    checkpointSummary: string
    workstreamJobs?: Array<{
      requestId: string
      jobName?: string
      blockTimestamp: string
      deliverySummary?: string
    }>
    stats?: {
      totalJobs: number
      completedJobs: number
    }
  }
}

export interface RecognitionPhaseCardProps {
  recognitionData: RecognitionData | null
  hasRecognition: boolean
}

export function RecognitionPhaseCard({ recognitionData }: RecognitionPhaseCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Recognition Phase
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Workstream Progress Summary */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h4 className="text-sm font-semibold text-gray-400">Workstream Progress Summary</h4>
            {recognitionData?.progressCheckpoint?.stats && (
              <Badge variant="outline" className="bg-purple-500/10 text-purple-700 border-purple-500/30 text-xs">
                {recognitionData.progressCheckpoint.stats.completedJobs} completed
              </Badge>
            )}
          </div>
          {recognitionData?.progressCheckpoint?.checkpointSummary ? (
            <>
              <div className="bg-gradient-to-br from-purple-50 to-blue-50 p-4 rounded-lg border border-purple-500/30">
                <div className="prose prose-sm max-w-none text-sm">
                  <ReactMarkdown>{recognitionData.progressCheckpoint.checkpointSummary}</ReactMarkdown>
                </div>
              </div>
              <div className="text-xs text-gray-500 mt-2">
                AI-generated summary of all completed work in this workstream, tailored for relevance to the current job.
              </div>
            </>
          ) : (
            <div className="text-sm text-gray-500 italic">No workstream progress available</div>
          )}
        </div>

        {/* Initial Situation Section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h4 className="text-sm font-semibold text-gray-400">Initial Situation (Vector Search Context)</h4>
            {recognitionData?.embeddingStatus && (
              <Badge 
                variant={recognitionData.embeddingStatus === 'success' ? 'default' : 'destructive'}
                className="text-xs"
              >
                {recognitionData.embeddingStatus === 'success' ? (
                  <><CheckCircle2 className="w-3 h-3 mr-1" /> Embedding Created</>
                ) : (
                  <><XCircle className="w-3 h-3 mr-1" /> Embedding Failed</>
                )}
              </Badge>
            )}
          </div>
          {recognitionData?.initialSituation ? (
            <>
              <div className="bg-muted p-3 rounded border border">
                <pre className="text-xs overflow-auto max-h-[400px]">
                  {JSON.stringify(recognitionData.initialSituation, null, 2)}
                </pre>
              </div>
              <div className="text-xs text-gray-500 mt-2">
                This situation artifact was created before execution and used for semantic similarity search.
              </div>
            </>
          ) : (
            <div className="text-sm text-gray-500 italic">
              No initial situation available
            </div>
          )}
        </div>

        {/* Similar Jobs Section */}
        <div>
          <h4 className="text-sm font-semibold text-gray-400 mb-2">Similar Jobs Found</h4>
          {recognitionData?.similarJobs && recognitionData.similarJobs.length > 0 ? (
            <div className="space-y-2">
              {recognitionData.similarJobs.map((job) => (
                <div key={job.requestId} className="flex items-center justify-between bg-card p-3 rounded border border hover:border-blue-300 transition-colors">
                  <Link
                    href={`/requests/${job.requestId}`}
                    className="text-primary hover:text-primary hover:underline font-medium text-sm flex-1"
                  >
                    {job.jobName || `${job.requestId.slice(0, 12)}...`}
                  </Link>
                  <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">
                    {(job.score * 100).toFixed(0)}% match
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-gray-500 italic">No similar jobs found</div>
          )}
        </div>

        {/* Synthesized Learnings */}
        <div>
          <h4 className="text-sm font-semibold text-gray-400 mb-2">Synthesized Learnings</h4>
          {recognitionData?.learnings ? (
            <div className="bg-muted p-4 rounded text-sm overflow-auto prose prose-sm max-w-none">
              {typeof recognitionData.learnings === 'string' ? (
                <ReactMarkdown>{recognitionData.learnings}</ReactMarkdown>
              ) : (
                <pre className="text-xs overflow-auto">
                  {JSON.stringify(recognitionData.learnings, null, 2)}
                </pre>
              )}
            </div>
          ) : (
            <div className="text-sm text-gray-500 italic">No learnings synthesized</div>
          )}
        </div>

      </CardContent>
    </Card>
  )
}
