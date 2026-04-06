'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Check } from 'lucide-react'

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

interface ReflectionPhaseCardProps {
  requestId: string
  situationData: SituationData | null
}

export function ReflectionPhaseCard({ requestId, situationData }: ReflectionPhaseCardProps) {
  if (!situationData) {
    return (
      <Card className="border-orange-200 bg-orange-50/50">
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            💭 Reflection Phase (Post-Job)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-gray-400">
            No reflection data available yet. Reflection occurs after job completion.
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-orange-200 bg-orange-50/50">
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2">
          💭 Reflection Phase (Post-Job)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-gray-400 mb-2">Situation Data</h4>
          <div className="bg-card p-3 rounded border space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Check className="w-4 h-4 text-green-700 dark:text-green-400" />
              <span className="font-medium text-gray-900">JSON created</span>
            </div>
            {situationData.embedding && (
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-700 dark:text-green-400" />
                <span className="font-medium text-gray-900">Embedding created</span>
              </div>
            )}
            <div className="mt-3 pt-3 border-t">
              <div>
                <span className="text-gray-400">Execution Trace:</span>{' '}
                <span className="font-medium text-gray-900">{situationData.execution.trace.length} steps captured</span>
              </div>
              <div>
                <span className="text-gray-400">Generated:</span>{' '}
                <span className="font-medium text-gray-900">
                  {new Date(situationData.meta.generatedAt).toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-orange-100 border border-orange-200 rounded p-3">
          <h4 className="text-sm font-semibold text-gray-800 mb-2">💡 What happens next?</h4>
          <p className="text-xs text-gray-400 leading-relaxed">
            This situation is now indexed in the memory system. When future jobs have similar objectives,
            the recognition phase will retrieve this execution pattern and synthesize learnings to inject
            into the prompt.
          </p>
        </div>

        <div className="text-xs text-gray-500 bg-card p-3 rounded border">
          <p className="font-medium mb-1">Full inspection via CLI:</p>
          <code className="block bg-muted p-2 rounded mt-1 text-gray-800">
            tsx scripts/memory/inspect-situation.ts {requestId}
          </code>
        </div>
      </CardContent>
    </Card>
  )
}

