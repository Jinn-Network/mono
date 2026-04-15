'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { SubgraphRecord } from '@/hooks/use-subgraph-collection'
import { CollectionName } from '@/lib/types'
import { IdLink } from '@/components/id-link'
import { useEffect, useState } from 'react'
import { getJobName, fetchIpfsContent } from '@/lib/subgraph'
import ReactMarkdown from 'react-markdown'
import { JobDetailLayout } from './job-phases/job-detail-layout'
import { JobDefinitionDetailLayout } from './job-definition-detail-layout'

interface Request {
  id: string
  mech: string
  sender: string
  jobDefinitionId?: string
  sourceRequestId?: string
  sourceJobDefinitionId?: string
  requestData?: string
  ipfsHash?: string
  deliveryIpfsHash?: string
  transactionHash?: string
  blockNumber: string
  blockTimestamp: string
  delivered: boolean
  jobName?: string
  enabledTools: string[]
  additionalContext?: Record<string, unknown>
  // Marketplace delivery fields (global Jinn explorer)
  deliveryMech?: string
  deliveryTxHash?: string
  deliveryBlockNumber?: string
  deliveryBlockTimestamp?: string
}

interface JobDefinition {
  id: string
  name: string
  enabledTools?: string[]
  promptContent?: string
  sourceJobDefinitionId?: string
  sourceRequestId?: string
  lastStatus?: string
  lastInteraction?: string
  latestStatusUpdate?: string
}

// Artifact detail layout component
function ArtifactDetailLayout({ record, fields }: { record: SubgraphRecord; fields: [string, unknown][] }) {
  const [artifactContent, setArtifactContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [parsedData, setParsedData] = useState<{ type?: string; tags?: string[] } | null>(null)

  useEffect(() => {
    // Fetch IPFS content if CID is available
    // For artifacts, DON'T pass requestId - the CID is a direct reference to the content
    if ('cid' in record && record.cid) {
      fetchIpfsContent(record.cid as string).then(result => {
        if (result) {
          // Try to parse JSON to extract `.content` field and metadata
          try {
            const parsed = JSON.parse(result.content)
            if (parsed && typeof parsed === 'object') {
              // Extract the `.content` field if it exists
              const contentValue = parsed.content
              setArtifactContent(typeof contentValue === 'string' ? contentValue : JSON.stringify(contentValue, null, 2))

              // Store type and tags for metadata display
              setParsedData({
                type: parsed.type,
                tags: parsed.tags
              })
            } else {
              setArtifactContent(result.content)
            }
          } catch {
            // If not JSON or parsing fails, show raw content
            setArtifactContent(result.content)
          }
        }
        setLoading(false)
      })
    } else {
      setLoading(false)
    }
  }, [record])

  // Fields to exclude from metadata (shown in main content, redundant, or not needed)
  const metadataExcludeFields = ['content', 'contentPreview', 'name', 'sourceRequestId', 'type', 'tags']
  const metadataFields = fields.filter(([key]) => !metadataExcludeFields.includes(key))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Main Content Area - 8/12 columns */}
      <div className="lg:col-span-8">
        <Card>
          <CardContent>
            {loading ? (
              <div className="text-gray-500">Loading content...</div>
            ) : artifactContent ? (
              <div className="markdown-content">
                <ReactMarkdown>{artifactContent}</ReactMarkdown>
              </div>
            ) : (
              <div className="text-gray-500">No content available</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Metadata Sidebar - 4/12 columns */}
      <div className="lg:col-span-4">
        <Card>
          <CardHeader>
            <CardTitle>Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Type field from parsed content */}
              {parsedData?.type && (
                <div className="border-b border-gray-100 pb-3">
                  <div className="text-sm font-medium text-gray-400 mb-1">
                    Type
                  </div>
                  <div className="text-sm break-words overflow-hidden">
                    {parsedData.type}
                  </div>
                </div>
              )}

              {/* Tags field from parsed content */}
              {parsedData?.tags && parsedData.tags.length > 0 && (
                <div className="border-b border-gray-100 pb-3">
                  <div className="text-sm font-medium text-gray-400 mb-1">
                    Tags
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {parsedData.tags.map((tag, index) => (
                      <Badge key={index} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Other metadata fields */}
              {metadataFields.map(([key, value]) => (
                <div key={key} className="border-b border-gray-100 pb-3 last:border-b-0 last:pb-0">
                  <div className="text-sm font-medium text-gray-400 mb-1">
                    {getFieldLabel(key, 'artifacts')}
                  </div>
                  <div className="text-sm break-words overflow-hidden">
                    <ValueDisplay value={value} fieldName={key} record={record} collectionName="artifacts" />
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

// Custom field ordering configuration - fields appear in this order for each collection
const FIELD_ORDER: Record<string, string[]> = {
  jobDefinitions: [
    'id',
    'name',
    'promptContent',
    'sourceJobDefinitionId',
    'sourceRequestId',
    'enabledTools',
    'blockTimestamp',
    'blockNumber',
    'transactionHash'
  ],
  requests: [
    'id',
    'jobName',
    'ipfsHash', // This is the prompt field (getFieldLabel converts to "Prompt")
    'sourceJobDefinitionId',
    'sourceRequestId',
    'additionalContext',
    'enabledTools',
    'mech',
    'sender',
    'blockTimestamp',
    'blockNumber',
    'transactionHash',
    'delivered',
    'deliveryIpfsHash',
    // Marketplace delivery fields (global Jinn explorer)
    'deliveryMech',
    'deliveryTxHash',
    'deliveryBlockNumber',
    'deliveryBlockTimestamp'
  ],
  deliveries: [
    'id',
    'requestId',
    'jobInstanceStatusUpdate',
    'executionSummary',
    'telemetry',
    'actionsTaken',
    'jobsDispatched',
    'ipfsHash',
    'deliveryRate',
    'mech',
    'deliveryMech',
    'blockTimestamp',
    'blockNumber',
    'transactionHash'
  ],
  artifacts: [
    'id',
    'topic',
    'name',
    'contentPreview',
    'requestId',
    'cid',
    'blockTimestamp'
  ],
  messages: [
    'id',
    'content',
    'to',
    'requestId',
    'blockTimestamp'
  ]
}

interface SubgraphDetailViewProps {
  record: SubgraphRecord
  collectionName: CollectionName
}

function formatBlockTimestamp(timestamp: string): string {
  try {
    // Convert from seconds to milliseconds
    const date = new Date(Number(timestamp) * 1000)
    return date.toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    })
  } catch {
    return timestamp
  }
}

function JobNameDisplay({ jobDefinitionId }: { jobDefinitionId: string }) {
  const [jobName, setJobName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getJobName(jobDefinitionId).then(name => {
      setJobName(name)
      setLoading(false)
    })
  }, [jobDefinitionId])

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-gray-500">Loading job name...</div>
        <IdLink id={jobDefinitionId} collection="jobDefinitions" showFullId={true} />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {jobName && (
        <div className="text-sm font-medium text-gray-900">{jobName}</div>
      )}
      <IdLink id={jobDefinitionId} collection="jobDefinitions" showFullId={true} />
    </div>
  )
}

// Structured delivery content display
function DeliveryContentDisplay({ cid, requestId }: { cid: string; requestId: string }) {
  const [parsed, setParsed] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchIpfsContent(cid, requestId).then(result => {
      if (result) {
        try {
          const data = JSON.parse(result.content)
          setParsed(data)
        } catch {
          setError('Failed to parse JSON content')
        }
      } else {
        setError('Failed to fetch content')
      }
      setLoading(false)
    })
  }, [cid, requestId])

  if (loading) return <div className="text-sm text-gray-500">Loading delivery content...</div>
  if (error) return <div className="text-sm text-red-600">{error}</div>
  if (!parsed) return null

  const telemetry = (parsed.telemetry || {}) as Record<string, unknown>
  const toolCalls = (telemetry.toolCalls as Array<Record<string, unknown>>) || []
  const dispatchedJobs = toolCalls.filter((tc) => (tc.tool === 'dispatch_new_job' && tc.success))
  const duration = telemetry.duration as number | undefined
  const durationSec = duration ? (duration / 1000).toFixed(1) : '0'

  // Try to extract function calls from raw API request history
  const raw = telemetry.raw as Record<string, unknown> | undefined
  const rawRequests = (raw?.lastApiRequest || (raw?.requestText as string[])?.[0] || '') as string
  const functionCallsMap = new Map<string, unknown>()

  try {
    if (typeof rawRequests === 'string' && rawRequests.includes('functionCall')) {
      const requestData = JSON.parse(rawRequests) as unknown[]
      if (Array.isArray(requestData)) {
        requestData.forEach((turn: unknown) => {
          const turnObj = turn as Record<string, unknown>
          if (turnObj.parts && Array.isArray(turnObj.parts)) {
            turnObj.parts.forEach((part: unknown) => {
              const partObj = part as Record<string, unknown>
              if (partObj.functionCall) {
                const fc = partObj.functionCall as Record<string, unknown>
                functionCallsMap.set(fc.name as string, fc.args)
              }
            })
          }
        })
      }
    }
  } catch {
    // Silently ignore parsing errors
  }

  // Render individual flat fields without wrapper - each field is self-contained
  return (
    <>
      {/* Execution Summary Field */}
      {parsed.output && (
        <div data-field="executionSummary" className="prose prose-sm max-w-none bg-white p-4 rounded border">
          <ReactMarkdown>{parsed.output as string}</ReactMarkdown>
        </div>
      )}

      {/* Telemetry Field - rendered as inline badges */}
      <div data-field="telemetry" className="flex flex-wrap gap-3">
        <span className="inline-flex items-center px-3 py-1 rounded-md bg-primary/10 border border-primary/30 text-sm">
          <span className="text-gray-400">Tokens:</span>
          <strong className="ml-1 text-gray-900">{telemetry.totalTokens?.toLocaleString() || 0}</strong>
        </span>
        <span className="inline-flex items-center px-3 py-1 rounded-md bg-green-50 border border-green-200 text-sm">
          <span className="text-gray-400">Duration:</span>
          <strong className="ml-1 text-gray-900">{durationSec}s</strong>
        </span>
        {(typeof raw?.model === 'string') && (
          <span className="inline-flex items-center px-3 py-1 rounded-md bg-purple-50 border border-purple-200 text-sm">
            <span className="text-gray-400">Model:</span>
            <strong className="ml-1 text-gray-900">{raw.model}</strong>
          </span>
        )}
      </div>

      {/* Actions Taken Field - collapsible list of tool calls */}
      {toolCalls.length > 0 && (
        <div data-field="actionsTaken" className="space-y-2">
          <div className="text-xs text-gray-500 mb-2">{toolCalls.length} action{toolCalls.length !== 1 ? 's' : ''} taken</div>
          {toolCalls.map((tc, idx: number) => (
            <details key={idx} className="bg-muted p-3 rounded border">
              <summary className="cursor-pointer text-sm font-medium">
                <span className={(tc.success as boolean) ? 'text-green-600' : 'text-red-600'}>
                  {(tc.success as boolean) ? '✓' : '✗'}
                </span>
                {' '}{tc.tool as string} <span className="text-gray-500">({tc.duration_ms as number}ms)</span>
              </summary>
              <div className="mt-2 text-xs space-y-1">
                <pre className="whitespace-pre-wrap overflow-auto max-h-48 bg-white p-2 rounded">
                  {JSON.stringify(tc.result || tc, null, 2)}
                </pre>
              </div>
            </details>
          ))}
        </div>
      )}

      {/* Jobs Dispatched Field - links to job definitions and requests */}
      {dispatchedJobs.length > 0 && (
        <div data-field="jobsDispatched" className="space-y-2">
          <div className="text-xs text-gray-500 mb-2">{dispatchedJobs.length} job{dispatchedJobs.length !== 1 ? 's' : ''} dispatched</div>
          {dispatchedJobs.map((job, idx: number) => {
            const result = (job.result || {}) as Record<string, unknown>
            const requestIds = (result.request_ids || []) as string[]
            const jobDefinitionId = (result.job_definition_id || result.jobDefinitionId) as string | undefined
            const txHash = result.transaction_hash as string | undefined
            // Try to get job name from function call args in raw API history
            const functionCallArgs = functionCallsMap.get('dispatch_new_job') as Record<string, unknown> | undefined
            const jobInput = (job.input || {}) as Record<string, unknown>
            const jobParams = (job.params || {}) as Record<string, unknown>
            const jobArgs = (job.args || {}) as Record<string, unknown>
            const jobName = (functionCallArgs?.jobName ||
              jobInput?.jobName ||
              jobParams?.jobName ||
              jobArgs?.jobName ||
              result.job_name ||
              result.jobName ||
              'Unnamed Job') as string
            return (
              <div key={idx} className="bg-white p-3 rounded border space-y-2">
                <div className="font-medium text-sm text-gray-900">
                  {idx + 1}. {jobName}
                </div>
                {jobDefinitionId && (
                  <div className="text-xs">
                    <span className="text-gray-400">Job Definition: </span>
                    <IdLink id={jobDefinitionId} collection="jobDefinitions" showFullId={false} />
                  </div>
                )}
                {requestIds.length > 0 && (
                  <div className="text-xs">
                    <span className="text-gray-400">Job Execution: </span>
                    <IdLink id={requestIds[0]} collection="requests" showFullId={false} />
                  </div>
                )}
                {txHash && (
                  <div className="text-xs">
                    <a
                      href={(result.transaction_url as string) || `https://basescan.org/tx/${txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary underline"
                    >
                      View Transaction
                    </a>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Raw JSON Field - always present but collapsed */}
      <div data-field="rawJson">
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-400 hover:text-gray-900">View Raw JSON</summary>
          <pre className="mt-2 p-3 bg-muted rounded border overflow-auto max-h-96">
            {JSON.stringify(parsed, null, 2)}
          </pre>
        </details>
      </div>
    </>
  )
}

// Structured request content display - shows only the prompt
function RequestContentDisplay({ cid }: { cid: string }) {
  const [parsed, setParsed] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchIpfsContent(cid).then(result => {
      if (result) {
        try {
          const data = JSON.parse(result.content)
          setParsed(data)
        } catch {
          setError('Failed to parse JSON content')
        }
      } else {
        setError('Failed to fetch content')
      }
      setLoading(false)
    })
  }, [cid])

  if (loading) return <div className="text-sm text-gray-500">Loading blueprint...</div>
  if (error) return <div className="text-sm text-red-600">Error loading: {error}</div>
  if (!parsed) return null

  // Blueprint is the primary job specification (new architecture)
  // Fall back to prompt for backward compatibility with legacy jobs
  const blueprint = (parsed.blueprint || parsed.prompt) as string | undefined

  return (
    <div className="space-y-4">
      {/* Blueprint Display */}
      {blueprint ? (
        <div className="prose prose-sm max-w-none bg-muted p-4 rounded border">
          <ReactMarkdown>{blueprint}</ReactMarkdown>
        </div>
      ) : (
        <p className="text-gray-500">No blueprint found in request</p>
      )}

      {/* Raw JSON Toggle for debugging */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-400 hover:text-gray-900">View Raw JSON</summary>
        <pre className="mt-2 p-3 bg-muted rounded border overflow-auto max-h-96">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      </details>
    </div>
  )
}

function ValueDisplay({ value, fieldName, record, collectionName }: { value: unknown; fieldName: string; record: SubgraphRecord; collectionName: CollectionName }) {
  if (value === null || value === undefined) {
    return <span className="text-gray-400 italic">null</span>
  }

  if (typeof value === 'boolean') {
    return (
      <span className={`inline-flex items-center px-2 py-1 rounded text-xs ${value
        ? 'text-green-600 bg-green-50 border border-green-200'
        : 'text-red-600 bg-red-50 border border-red-200'
        }`}>
        {value ? '✓ true' : '✗ false'}
      </span>
    )
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return (
      <span className="font-mono text-sm">
        {value.toLocaleString()}
      </span>
    )
  }

  if (typeof value === 'string') {
    // Handle block timestamps
    if (fieldName === 'blockTimestamp') {
      return (
        <div className="space-y-1">
          <div className="text-sm">{formatBlockTimestamp(value)}</div>
          <div className="text-xs text-gray-500 font-mono">Block: {value}</div>
        </div>
      )
    }

    // Handle Ethereum addresses
    if ((fieldName === 'mech' || fieldName === 'deliveryMech' || fieldName === 'sender' || fieldName === 'mechServiceMultisig') && value.startsWith('0x')) {
      return (
        <div className="font-mono text-sm break-all text-gray-400">
          {value}
        </div>
      )
    }

    // Handle transaction hashes
    if (fieldName === 'transactionHash' && value.startsWith('0x')) {
      return (
        <div className="font-mono text-sm break-all text-gray-400">
          {value}
        </div>
      )
    }

    // Handle IPFS hashes - use structured display for deliveries and requests
    if (fieldName === 'deliveryIpfsHash') {
      const requestId = 'requestId' in record ? String(record.requestId) :
        'id' in record ? String(record.id) : undefined
      if (requestId) {
        return <DeliveryContentDisplay cid={value} requestId={requestId} />
      }
    }

    // Handle delivery ipfsHash (when viewing deliveries directly)
    if (fieldName === 'ipfsHash' && collectionName === 'deliveries') {
      const requestId = 'requestId' in record ? String(record.requestId) :
        'id' in record ? String(record.id) : undefined
      if (requestId) {
        return <DeliveryContentDisplay cid={value} requestId={requestId} />
      }
    }

    // Handle request ipfsHash (request metadata)
    if (fieldName === 'ipfsHash') {
      return <RequestContentDisplay cid={value} />
    }

    // For artifact CIDs, show truncated with link
    if (fieldName === 'cid') {
      return (
        <div className="space-y-1">
          <div className="font-mono text-sm text-gray-400" title={value}>{value.slice(0, 20)}...{value.slice(-8)}</div>
          <a
            href={`https://gateway.autonolas.tech/ipfs/${value}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary underline text-xs inline-block"
          >
            View on Gateway
          </a>
        </div>
      )
    }

    // Handle job name as hyperlink to job definition
    if (fieldName === 'jobName' && value) {
      const jobDefId = 'jobDefinitionId' in record ? String(record.jobDefinitionId) : null
      if (jobDefId) {
        return (
          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-900">{value}</div>
            <IdLink id={jobDefId} collection="jobDefinitions" showFullId={true} />
          </div>
        )
      }
      // If no jobDefinitionId, render as plain text
      return <span className="text-sm font-medium">{value}</span>
    }

    // Handle foreign key relationships
    if (fieldName === 'requestId' || fieldName === 'sourceRequestId') {
      return <IdLink id={value} collection="requests" showFullId={true} />
    }
    if (fieldName === 'jobDefinitionId' || fieldName === 'sourceJobDefinitionId') {
      return <JobNameDisplay jobDefinitionId={value} />
    }
    if (fieldName === 'to') {
      // 'to' field in messages points to a job definition
      return <JobNameDisplay jobDefinitionId={value} />
    }

    // For long strings, show in a scrollable area
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
                  <span className="text-gray-400 font-mono text-xs mt-0.5">{index + 1}.</span>
                  <span className="flex-1">{String(item)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    )
  }

  // Handle objects (like additionalContext)
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      return <span className="text-gray-400 italic text-sm">Empty object</span>
    }

    return (
      <div className="space-y-2">
        <div className="text-xs text-gray-500">Object ({entries.length} properties)</div>
        <div className="bg-muted rounded border overflow-hidden">
          <div className="max-h-64 overflow-auto p-3">
            <pre className="text-xs font-mono whitespace-pre-wrap">
              {JSON.stringify(value, null, 2)}
            </pre>
          </div>
        </div>
      </div>
    )
  }

  return <span className="font-mono text-sm">{String(value)}</span>
}

// Helper to convert field names to user-friendly labels
function getFieldLabel(fieldName: string, collectionName: CollectionName): string {
  // Hide jobDefinitionId for requests collection (shown as job name link)
  if (collectionName === 'requests' && fieldName === 'jobDefinitionId') {
    return '' // Will be filtered out in rendering
  }

  const labelMap: Record<string, string> = {
    // IDs
    id: 'ID',

    // Job-related fields
    jobDefinitionId: 'Job Definition',
    jobName: 'Job Name',
    enabledTools: 'Enabled Tools',
    lastStatus: 'Last Status',
    latestStatusUpdate: 'Latest Status Update',
    jobInstanceStatusUpdate: 'Status Update',

    // Request/Delivery content fields
    deliveryIpfsHash: 'Execution Results',
    ipfsHash: collectionName === 'deliveries' ? 'Execution Results' : 'Blueprint',
    requestIpfsHash: 'Blueprint',
    promptContent: 'Blueprint',  // Legacy field
    blueprint: 'Blueprint',

    // Parent/Source relationships (renamed from Parent to Source)
    parentJobDefinitionId: 'Source Job Definition',
    parentRequestId: 'Source Job Execution',
    sourceJobDefinitionId: 'Source Job Definition',
    sourceRequestId: 'Source Job Execution',

    // Request field (displayed as Job Execution for consistency)
    requestId: 'Job Execution',

    // Flattened execution result fields
    executionSummary: 'Execution Summary',
    telemetry: 'Telemetry',
    actionsTaken: 'Actions Taken',
    jobsDispatched: 'Jobs Dispatched',

    // Blockchain fields
    blockNumber: 'Block Number',
    blockTimestamp: 'Timestamp',
    transactionHash: 'Transaction Hash',

    // Additional data fields
    additionalContext: 'Additional Context',
    requestData: 'Request Data',

    // Artifact fields
    name: 'Name',
    topic: 'Topic',
    cid: 'Content ID (CID)',
    contentPreview: 'Content Preview',
    content: 'Content',

    // Message fields
    to: 'To (Job Definition)',

    // Status/metadata fields
    delivered: 'Delivered',
    deliveryRate: 'Delivery Rate',

    // Address fields
    mech: 'Priority Mech Address',
    deliveryMech: 'Delivery Mech Address',
    sender: 'Sender Address',

    // Marketplace delivery fields (global Jinn explorer)
    deliveryTxHash: 'Delivery Transaction',
    deliveryBlockNumber: 'Delivery Block Number',
    deliveryBlockTimestamp: 'Delivery Timestamp',
  }

  // Return mapped label or convert camelCase to Title Case as fallback
  return labelMap[fieldName] || fieldName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim()
}

export function SubgraphDetailView({ record, collectionName }: SubgraphDetailViewProps) {
  // Get field order for this collection (with fallback to empty array)
  const fieldOrder = FIELD_ORDER[collectionName] || []

  // Get all fields from the record, filtering out mechServiceMultisig and fields with empty labels
  const allFields = Object.keys(record)
    .filter(key => key !== 'mechServiceMultisig') // Hide mech multisig service
    .filter(key => getFieldLabel(key, collectionName) !== '') // Hide fields with empty labels

  // Sort fields: ordered fields first (in specified order), then remaining fields alphabetically
  const orderedFieldNames = [
    ...fieldOrder.filter(f => allFields.includes(f)), // Ordered fields that exist
    ...allFields.filter(f => !fieldOrder.includes(f)).sort() // Remaining fields alphabetically
  ]

  // Create the fields array with [key, value] tuples
  const fields = orderedFieldNames.map(key => [key, (record as unknown as Record<string, unknown>)[key]] as [string, unknown])

  // Get display title - use name or jobName if available
  const displayTitle = ('name' in record && record.name) ||
    ('jobName' in record && record.jobName) ||
    (collectionName === 'jobDefinitions' ? 'Job Definition' :
      collectionName === 'requests' ? 'Job Execution' :
        collectionName === 'deliveries' ? 'Job Execution' :
          collectionName === 'artifacts' ? 'Artifact' :
            collectionName.slice(0, -1))

  // Use the new 4-phase layout for requests
  if (collectionName === 'requests') {
    return <JobDetailLayout record={record as unknown as Request} />
  }

  // Use Pretty/Raw tabs layout for job definitions
  if (collectionName === 'jobDefinitions') {
    return <JobDefinitionDetailLayout record={record as unknown as JobDefinition} />
  }

  // Special layout for artifacts: 8/12 content + 4/12 metadata
  if (collectionName === 'artifacts') {
    return <ArtifactDetailLayout record={record} fields={fields} />
  }

  // For other collections (deliveries, messages), use the original card-based layout
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{displayTitle}</CardTitle>
        </CardHeader>
        <CardContent>

          <div className="space-y-6">
            {fields.map(([key, value]) => (
              <div key={key} className="border-b border-gray-100 pb-4 last:border-b-0 last:pb-0">
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                  <div className="lg:col-span-1">
                    <span className="text-sm font-medium text-gray-900">{getFieldLabel(key, collectionName)}</span>
                  </div>
                  <div className="lg:col-span-3">
                    <ValueDisplay value={value} fieldName={key} record={record} collectionName={collectionName} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  )
}