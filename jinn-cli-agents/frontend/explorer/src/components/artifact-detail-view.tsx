'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { MarkdownField } from '@/components/markdown-field'
import { IdLink } from '@/components/id-link'
import { DbRecord } from '@/lib/types'
import { Artifact } from '@/lib/subgraph'

interface ArtifactDetailViewProps {
  record: DbRecord | (Artifact & { content?: string })
}

interface TriggeredJob {
  id: string
  job_name: string
  status: string
  created_at: string
  job_report_id?: string
}

function humanizeFieldName(fieldName: string): string {
  return fieldName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function ObjectViewer({ data }: { data: unknown }) {
  if (data === null || data === undefined) {
    return <span className="text-gray-400 italic">null</span>
  }

  if (typeof data === 'object') {
    return (
      <div className="space-y-2">
        <pre className="text-sm bg-muted p-3 rounded overflow-auto max-h-96">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    )
  }

  return <span>{String(data)}</span>
}

function TriggeredJobsList({ artifactId, isDbArtifact }: { artifactId: string; isDbArtifact: boolean }) {
  const [triggeredJobs, setTriggeredJobs] = useState<TriggeredJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchTriggeredJobs = async () => {
      try {
        // Only fetch for DB artifacts - subgraph artifacts don't have triggered jobs
        if (!isDbArtifact) {
          setTriggeredJobs([])
          setLoading(false)
          return
        }
        
        // We no longer use artifact → job linkage in DB queries. Show none for now.
        const data: TriggeredJob[] = []

        setTriggeredJobs(data || [])
      } catch (err) {
        console.error('Error fetching triggered jobs:', err)
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchTriggeredJobs()
  }, [artifactId, isDbArtifact])

  if (loading) {
    return <div className="text-sm text-gray-500">Loading triggered jobs...</div>
  }

  if (error) {
    return <div className="text-sm text-red-500">Error loading triggered jobs: {error}</div>
  }

  if (triggeredJobs.length === 0) {
    return null // Don't show section if no jobs
  }

  return (
    <div className="space-y-3">
      {triggeredJobs.map((job) => (
        <div key={job.id} className="border rounded-lg p-3 bg-muted">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IdLink collection="job_board" id={job.id} />
              <span className="font-medium">{job.job_name}</span>
              <span className={`px-2 py-1 rounded text-xs font-medium ${
                job.status === 'COMPLETED' ? 'bg-green-500/10 text-green-700 dark:text-green-400' :
                job.status === 'FAILED' ? 'bg-red-500/10 text-red-700 dark:text-red-400' :
                job.status === 'IN_PROGRESS' ? 'bg-primary/20 text-primary' :
                'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
              }`}>
                {job.status}
              </span>
            </div>
            <div className="text-xs text-gray-500">
              {new Date(job.created_at).toLocaleString()}
            </div>
          </div>
          {job.job_report_id && (
            <div className="mt-2 text-sm">
              Report: <IdLink id={job.job_report_id} fieldName="job_report_id" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function ArtifactDetailView({ record }: ArtifactDetailViewProps) {
  if (!record) {
    return null
  }

  // Check if this is a DB artifact (has source_job_name) or Subgraph artifact
  const isDbArtifact = 'source_job_name' in record
  
  // Extract the main content fields
  const content = 'content' in record ? record.content : null
  const topic = 'topic' in record ? record.topic : null
  const name = 'name' in record ? record.name : null
  const cid = 'cid' in record ? record.cid : null
  const requestId = 'requestId' in record ? record.requestId : null
  const ventureId = 'ventureId' in record ? record.ventureId : null
  const workstreamId = 'workstreamId' in record ? record.workstreamId : null
  const templateId = 'templateId' in record ? record.templateId : null
  const blockTimestamp = 'blockTimestamp' in record ? record.blockTimestamp : null
  // const contentPreview = 'contentPreview' in record ? record.contentPreview : null
  
  // DB-specific fields
  const status = 'status' in record ? record.status : null
  const source_job_name = 'source_job_name' in record ? record.source_job_name : null
  const thread_id = 'thread_id' in record ? record.thread_id : null
  const created_at = 'created_at' in record ? record.created_at : null
  const updated_at = 'updated_at' in record ? record.updated_at : null
  
  const id = record.id

  // Fields to hide from the detail view
  const hiddenFields = ['id', 'content', 'contentPreview'] // Content is shown separately
  
  // Prepare details for the right sidebar
  const detailFields: Record<string, unknown> = {
    name,
    topic,
    cid,
    requestId,
    ventureId,
    workstreamId,
    templateId,
    blockTimestamp,
    status,
    source_job_name,
    thread_id,
    created_at,
    updated_at,
  }

  // Filter out hidden fields and null/undefined values
  const visibleDetailFields = Object.entries(detailFields).filter(([key, value]) => 
    !hiddenFields.includes(key) && value !== null && value !== undefined
  )

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* Main Content Area - spans 3 columns */}
      <div className="lg:col-span-3 space-y-6">
        {/* Content Card - Top Priority */}
        {content && (
          <Card>
            <CardHeader>
              <CardTitle>Content</CardTitle>
            </CardHeader>
            <CardContent>
              <MarkdownField content={typeof content === 'string' ? content : JSON.stringify(content, null, 2)} />
            </CardContent>
          </Card>
        )}

        {/* Triggered Jobs Card - Only for DB artifacts */}
        {isDbArtifact && (
          <Card>
            <CardHeader>
              <CardTitle>Jobs Triggered by This Artifact</CardTitle>
            </CardHeader>
            <CardContent>
              <TriggeredJobsList artifactId={String(id)} isDbArtifact={isDbArtifact} />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Details Sidebar - Right aligned */}
      <div className="lg:col-span-1">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {visibleDetailFields.map(([key, value]) => (
                <div key={key} className="border-b border-gray-100 pb-3 last:border-b-0 last:pb-0">
                  <div className="font-medium text-gray-900 text-sm mb-1" title={`Field: ${key}`}>
                    {humanizeFieldName(key)}:
                  </div>
                  <div className="text-sm">
                    {/* Special handling for thread_id */}
                    {key === 'thread_id' && value && typeof value === 'string' ? (
                      <IdLink id={value} fieldName="thread_id" />
                    ) : /* Special handling for different data types */
                    typeof value === 'boolean' ? (
                      <span className={`inline-flex items-center px-2 py-1 rounded text-xs ${
                        value 
                          ? 'text-green-700 dark:text-green-400 bg-green-500/10 border border-green-500/30' 
                          : 'text-red-700 dark:text-red-400 bg-red-500/10 border border-red-500/30'
                      }`}>
                        {value ? '✓ true' : '✗ false'}
                      </span>
                    ) : typeof value === 'number' ? (
                      <span className="font-mono">
                        {value.toLocaleString()}
                      </span>
                    ) : typeof value === 'object' && value !== null ? (
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="outline" size="sm" className="text-xs">
                            View {Array.isArray(value) ? 'Array' : 'Object'}
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
                          <DialogHeader>
                            <DialogTitle>{humanizeFieldName(key)}</DialogTitle>
                          </DialogHeader>
                          <ObjectViewer data={value} />
                        </DialogContent>
                      </Dialog>
                    ) : (
                      <span className="break-words">
                        {String(value)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}