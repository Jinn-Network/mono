'use client'

import { useEffect, useState, ReactNode } from 'react'
import { fetchIpfsContent, getJobDefinition, getRequest, queryRequests, queryDeliveries, queryArtifacts, queryMessages, type Request as SubgraphRequest, type JobDefinition as SubgraphJobDefinition, type Delivery as SubgraphDelivery } from '@/lib/subgraph'
import { parseInvariants } from '@/lib/invariant-utils'
import { InvariantCard, type Invariant, type LegacyInvariant } from '@jinn/shared-ui'
import { useRealtimeData } from '@/hooks/use-realtime-data'
import { RecognitionPhaseCard } from './recognition-phase-card'
import { WorkerTelemetryCard } from '../worker-telemetry-card'
import { DependenciesSection } from '../dependencies-section'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import { ExternalLink, FileText, GitBranch, ArrowRight, ArrowLeft, Wrench, Zap, Cpu, Clock, Check, ArrowUp, HelpCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { RequestsTable } from '../requests-table'
import { RequestsTableSkeleton } from '../loading-skeleton'
import { StatusIcon } from '../status-icon'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// Component for showing parent dispatch trigger
function ParentDispatchIndicator({
  requestId,
  sourceJobDefinitionId,
  jobStatus
}: {
  requestId: string
  sourceJobDefinitionId: string | null
  jobStatus: string | null
}) {
  const [parentDispatched, setParentDispatched] = useState(false)
  const [newParentRequestId, setNewParentRequestId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [parentJobDef, setParentJobDef] = useState<SubgraphJobDefinition | null>(null)

  useEffect(() => {
    if (!sourceJobDefinitionId) {
      setLoading(false)
      return
    }

    // Only show if this job reached terminal state (would have triggered parent)
    if (jobStatus !== 'COMPLETED' && jobStatus !== 'FAILED') {
      setLoading(false)
      return
    }

    const checkParentDispatch = async () => {
      try {
        // Fetch parent job definition info
        const parentDef = await getJobDefinition(sourceJobDefinitionId)
        if (parentDef) {
          setParentJobDef(parentDef)
        }

        // Query for messages sent to parent job definition from this request
        const messages = await queryMessages({
          where: {
            requestId: requestId,
            to: sourceJobDefinitionId
          },
          limit: 1
        })

        if (messages.items.length > 0) {
          setParentDispatched(true)

          // Try to find the new parent request that was created
          // Query for recent requests of the parent job definition
          const parentRequests = await queryRequests({
            where: { jobDefinitionId: sourceJobDefinitionId },
            orderBy: 'blockTimestamp',
            orderDirection: 'desc',
            limit: 5
          })

          // Find the request that came after this job's completion
          const messageTimestamp = BigInt(messages.items[0].blockTimestamp)
          const newRequest = parentRequests.items.find(r =>
            BigInt(r.blockTimestamp) >= messageTimestamp
          )

          if (newRequest) {
            setNewParentRequestId(newRequest.id)
          }
        }
      } catch (error) {
        console.error('Error checking parent dispatch:', error)
      } finally {
        setLoading(false)
      }
    }

    checkParentDispatch()
  }, [requestId, sourceJobDefinitionId, jobStatus])

  if (loading || !parentDispatched || !sourceJobDefinitionId) return null

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/10 p-4 mt-4">
      <div className="flex items-center gap-2 mb-2">
        <ArrowUp className="h-5 w-5 text-primary" />
        <span className="font-medium text-foreground">
          Parent Job Re-Triggered
        </span>
      </div>
      <p className="text-sm text-primary">
        This job&apos;s <Badge variant="outline" className="mx-1">{jobStatus}</Badge> status triggered parent job{' '}
        {parentJobDef && (
          <Link
            href={`/job-definitions/${sourceJobDefinitionId}`}
            className="font-medium underline hover:text-foreground"
          >
            {parentJobDef.name}
          </Link>
        )}
        {' '}to automatically re-run.
        {newParentRequestId && (
          <>
            {' '}
            <Link
              href={`/requests/${newParentRequestId}`}
              className="font-medium underline hover:text-foreground"
            >
              View parent&apos;s new run →
            </Link>
          </>
        )}
      </p>
    </div>
  )
}

// Component for showing parent re-run status in Job Info card
function ParentReRunField({
  requestId,
  sourceJobDefinitionId,
  jobStatus,
  delivered,
  workerTelemetry
}: {
  requestId: string
  sourceJobDefinitionId: string | null
  jobStatus: string | null
  delivered: boolean
  workerTelemetry: {
    events?: Array<{
      phase?: string
      event?: string
      metadata?: {
        newRequestId?: string
      }
    }>
  } | null
}) {
  const [newRequestId, setNewRequestId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // No parent job
    if (!sourceJobDefinitionId) {
      setLoading(false)
      return
    }

    // Job not delivered yet
    if (!delivered) {
      setLoading(false)
      return
    }

    // Job not in terminal state (parent only triggered on COMPLETED/FAILED)
    if (jobStatus !== 'COMPLETED' && jobStatus !== 'FAILED') {
      setLoading(false)
      return
    }

    const find = async () => {
      try {
        // First, try to get newRequestId from worker telemetry (most reliable)
        if (workerTelemetry?.events) {
          const dispatchSuccessEvent = workerTelemetry.events.find(
            (e) => e.phase === 'parent_dispatch' && e.event === 'dispatch_success'
          )
          if (dispatchSuccessEvent?.metadata?.newRequestId) {
            setNewRequestId(dispatchSuccessEvent.metadata.newRequestId)
            setLoading(false)
            return
          }
        }

        // Fallback: query messages and find parent request
        const messages = await queryMessages({
          where: { requestId, to: sourceJobDefinitionId },
          limit: 1
        })

        if (messages.items.length > 0) {
          const parentRequests = await queryRequests({
            where: { jobDefinitionId: sourceJobDefinitionId },
            orderBy: 'blockTimestamp',
            orderDirection: 'desc',
            limit: 5
          })

          const messageTimestamp = BigInt(messages.items[0].blockTimestamp)
          const newRequest = parentRequests.items.find(r =>
            BigInt(r.blockTimestamp) >= messageTimestamp
          )

          if (newRequest) setNewRequestId(newRequest.id)
        }
      } catch (error) {
        console.error('Error finding parent re-run:', error)
      } finally {
        setLoading(false)
      }
    }
    find()
  }, [requestId, sourceJobDefinitionId, jobStatus, delivered, workerTelemetry])

  // Show appropriate empty states
  if (!sourceJobDefinitionId) {
    return <div className="text-sm text-gray-500">No parent job</div>
  }

  if (!delivered) {
    return <div className="text-sm text-gray-500">Pending delivery</div>
  }

  if (jobStatus !== 'COMPLETED' && jobStatus !== 'FAILED') {
    return <div className="text-sm text-gray-500">Not in terminal state</div>
  }

  if (loading) {
    return <div className="text-sm text-gray-500">Checking...</div>
  }

  if (!newRequestId) {
    return <div className="text-sm text-gray-500">Not triggered yet</div>
  }

  return (
    <Link
      href={`/requests/${newRequestId}`}
      className="text-primary hover:text-primary hover:underline text-sm font-mono break-all flex items-center gap-1"
    >
      <span className="break-all">{newRequestId}</span>
      <ArrowRight className="w-3 h-3 flex-shrink-0" />
    </Link>
  )
}

// Component for displaying child jobs spawned during execution
function ChildJobsSection({ parentRequestId }: { parentRequestId: string }) {
  const [childJobs, setChildJobs] = useState<SubgraphRequest[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchChildren = async () => {
      try {
        // Query subgraph for all jobs where sourceRequestId matches this job
        const jobsResponse = await queryRequests({
          where: { sourceRequestId: parentRequestId },
          orderBy: 'blockTimestamp',
          orderDirection: 'desc'
        })
        setChildJobs(jobsResponse.items)
      } catch (error) {
        console.error('Error fetching child jobs:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchChildren()
  }, [parentRequestId])

  // Only show if there are child jobs
  if (!loading && childJobs.length === 0) {
    return null
  }

  return (
    <div>
      <div className="text-sm font-medium text-gray-400 mb-2">
        Child Jobs Spawned ({childJobs.length})
      </div>
      {loading ? (
        <RequestsTableSkeleton />
      ) : (
        <RequestsTable records={childJobs} />
      )}
    </div>
  )
}

interface Request {
  id: string
  mech?: string
  sender?: string
  jobName?: string
  ipfsHash?: string
  deliveryIpfsHash?: string
  enabledTools?: string[] | string
  blockNumber?: string
  blockTimestamp?: string
  transactionHash?: string
  delivered?: boolean
  jobDefinitionId?: string
  sourceRequestId?: string
  sourceJobDefinitionId?: string
  dependencies?: string[]
  workstreamId?: string
}

interface MemoryInspectionResponse {
  requestId: string
  situation: {
    context?: {
      parentRequestId?: string
      childRequestIds?: string[]
      siblingRequestIds?: string[]
    }
    execution?: {
      status?: string
      trace?: unknown
      finalOutputSummary?: string
    }
    artifacts?: unknown[]
    meta?: {
      generatedAt?: string
    }
  } | null
  recognition: {
    searchQuery?: string
    similarJobs?: Array<{
      requestId: string
      score: number
      jobName?: string
    }>
    learnings: string | object[]
    timestamp: string
  } | null
  hasSituation: boolean
  hasRecognition: boolean
}

interface JobDetailLayoutProps {
  record: Request
}

interface WorkerTelemetryLog {
  version: string
  requestId: string
  jobName?: string
  startTime: string
  endTime?: string
  totalDuration_ms?: number
  events: Array<{
    timestamp: string
    phase: string
    event: string
    duration_ms?: number
    metadata?: Record<string, unknown>
    error?: string
  }>
  summary: {
    totalEvents: number
    phases: string[]
    errors: number
  }
}

interface ToolCallResult {
  cid?: string
  name?: string
  topic?: string
  contentPreview?: string
}

interface ToolCall {
  tool?: string
  success?: boolean
  duration_ms?: number
  result?: ToolCallResult
  input?: unknown
  params?: unknown
  args?: unknown
}

interface TelemetryData {
  tokens?: number
  duration?: number
  totalTokens?: number
  errorMessage?: string
  errorType?: string
  raw?: {
    model?: string
    inputTokens?: number
    events?: string[]
    lastApiRequest?: string
    requestText?: string[]
  }
  requestText?: string[]
  responseText?: string[]
  toolCalls?: ToolCall[]
}

interface DeliveryData {
  output?: string
  structuredSummary?: string
  artifacts?: unknown[]
  telemetry?: TelemetryData
  reflection?: {
    telemetry?: TelemetryData
  }
  workerTelemetry?: WorkerTelemetryLog
}

interface Artifact {
  id: string
  topic?: string
  name?: string
  cid?: string
  contentPreview?: string
}

type RawSectionProps = {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}

type RawContentBlockProps = {
  content: unknown
  label: string
  preserveWhitespace?: boolean
}

function RawSection({ title, description, action, children }: RawSectionProps) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base leading-6">{title}</CardTitle>
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  )
}

function RawState({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-muted-foreground" aria-live="polite">
      {children}
    </p>
  )
}

function RawContentBlock({ content, label, preserveWhitespace }: RawContentBlockProps) {
  const rendered = typeof content === 'string' ? content : JSON.stringify(content, null, 2)

  return (
    <ScrollArea className="max-h-[400px] rounded-md border bg-muted/50">
      <pre
        className={`p-4 text-xs font-mono leading-relaxed text-foreground ${preserveWhitespace ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
          }`}
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        {rendered}
      </pre>
    </ScrollArea>
  )
}

export function JobDetailLayout({ record }: JobDetailLayoutProps) {
  const [memoryData, setMemoryData] = useState<MemoryInspectionResponse | null>(null)
  const [loadingMemory, setLoadingMemory] = useState(true)
  const [deliveryData, setDeliveryData] = useState<DeliveryData | null>(null)
  const [loadingDelivery, setLoadingDelivery] = useState(false)
  const [jobDefinition, setJobDefinition] = useState<SubgraphJobDefinition | null>(null)
  const [sourceRequest, setSourceRequest] = useState<SubgraphRequest | null>(null)
  const [sourceJobDef, setSourceJobDef] = useState<SubgraphJobDefinition | null>(null)
  const [promptContent, setPromptContent] = useState<string | null>(null)
  const [requestIpfsRawContent, setRequestIpfsRawContent] = useState<string | null>(null)
  const [ipfsEnabledTools, setIpfsEnabledTools] = useState<string[]>([])
  const [deliveryContent, setDeliveryContent] = useState<string | null>(null)
  const [workstreamId, setWorkstreamId] = useState<string | null>(null)
  const [loadingWorkstream, setLoadingWorkstream] = useState(true)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [loadingArtifacts, setLoadingArtifacts] = useState(true)
  const [workerTelemetry, setWorkerTelemetry] = useState<WorkerTelemetryLog | null>(null)
  const [loadingWorkerTelemetry, setLoadingWorkerTelemetry] = useState(true)
  const [deliveryRecord, setDeliveryRecord] = useState<SubgraphDelivery | null>(null)

  // Get workstream ID from Ponder (already indexed and computed)
  useEffect(() => {
    setLoadingWorkstream(true)
    const requestRecord = record
    // Use the workstreamId field from the request if available
    if ('workstreamId' in requestRecord && requestRecord.workstreamId) {
      setWorkstreamId(requestRecord.workstreamId as string)
      setLoadingWorkstream(false)
    } else {
      // Fallback to own ID if workstreamId not available (shouldn't happen)
      setWorkstreamId(record.id)
    }
    setLoadingWorkstream(false)
  }, [record.id])

  useEffect(() => {
    const fetchMemoryData = async () => {
      try {
        setLoadingMemory(true)
        const response = await fetch(`/api/memory-inspection?requestId=${encodeURIComponent(record.id)}`)

        if (response.ok) {
          const result: MemoryInspectionResponse = await response.json()
          setMemoryData(result)
        }
      } catch (error) {
        console.error('Error fetching memory data:', error)
      } finally {
        setLoadingMemory(false)
      }
    }

    if (record.delivered) {
      fetchMemoryData()
    } else {
      setLoadingMemory(false)
    }
  }, [record.id, record.delivered])

  // Fetch artifacts from subgraph
  const fetchArtifacts = async () => {
    try {
      setLoadingArtifacts(true)
      const artifactsResponse = await queryArtifacts({
        where: { requestId: record.id },
        orderBy: 'blockTimestamp',
        orderDirection: 'desc'
      })
      setArtifacts(artifactsResponse.items)
    } catch (error) {
      console.error('Error fetching artifacts:', error)
    } finally {
      setLoadingArtifacts(false)
    }
  }

  useEffect(() => {
    fetchArtifacts()
  }, [record.id])

  // Real-time updates for all relevant data
  const { isConnected: isRealtimeConnected } = useRealtimeData(
    undefined, // Listen to all tables
    {
      enabled: true,
      onEvent: () => {
        console.log('[JobDetailLayout] Real-time update detected')
        fetchArtifacts()
      }
    }
  )

  // Fetch worker telemetry artifact
  useEffect(() => {
    const fetchWorkerTelemetry = async () => {
      if (!record.delivered) {
        setLoadingWorkerTelemetry(false)
        return
      }

      try {
        setLoadingWorkerTelemetry(true)
        // Find WORKER_TELEMETRY artifact
        const telemetryArtifact = artifacts.find(a => a.topic === 'WORKER_TELEMETRY')

        if (telemetryArtifact?.cid) {
          const result = await fetchIpfsContent(telemetryArtifact.cid)
          if (result) {
            const parsed = JSON.parse(result.content)
            // Handle content wrapper if needed
            if (parsed.content && typeof parsed.content === 'string') {
              try {
                setWorkerTelemetry(JSON.parse(parsed.content))
              } catch {
                setWorkerTelemetry(parsed)
              }
            } else {
              setWorkerTelemetry(parsed)
            }
          }
        }
      } catch (error) {
        console.error('Error fetching worker telemetry:', error)
      } finally {
        setLoadingWorkerTelemetry(false)
      }
    }

    if (!loadingArtifacts && artifacts.length > 0) {
      fetchWorkerTelemetry()
    } else if (!loadingArtifacts) {
      setLoadingWorkerTelemetry(false)
    }
  }, [record.id, record.delivered, artifacts, loadingArtifacts])

  // Always fetch delivery data when job is delivered (contains telemetry & final output)
  useEffect(() => {
    const fetchDelivery = async () => {
      if (!record.deliveryIpfsHash || !record.delivered || loadingMemory) {
        console.log('[JobDetailLayout] Skipping delivery fetch:', {
          hasHash: !!record.deliveryIpfsHash,
          delivered: record.delivered,
          loadingMemory
        })
        return
      }

      try {
        console.log('[JobDetailLayout] Fetching delivery data:', record.deliveryIpfsHash)
        setLoadingDelivery(true)
        const result = await fetchIpfsContent(record.deliveryIpfsHash, record.id)
        console.log('[JobDetailLayout] Delivery fetch result:', result)
        if (result) {
          const parsed = JSON.parse(result.content)
          console.log('[JobDetailLayout] Parsed delivery data:', parsed)
          setDeliveryData(parsed)
        }
      } catch (error) {
        console.error('[JobDetailLayout] Error fetching delivery data:', error)
      } finally {
        setLoadingDelivery(false)
      }
    }

    fetchDelivery()
  }, [record.deliveryIpfsHash, record.id, record.delivered, loadingMemory])

  // Prefer worker telemetry snapshot embedded in delivery payload when available
  useEffect(() => {
    if (deliveryData?.workerTelemetry?.events?.length) {
      const currentEvents = workerTelemetry?.events?.length || 0
      const deliveryEvents = deliveryData.workerTelemetry.events.length
      if (!workerTelemetry || deliveryEvents > currentEvents) {
        setWorkerTelemetry(deliveryData.workerTelemetry)
      }
    }
  }, [deliveryData, workerTelemetry])

  // Fetch job definition
  useEffect(() => {
    if (record.jobDefinitionId) {
      getJobDefinition(record.jobDefinitionId).then(setJobDefinition)
    }
  }, [record.jobDefinitionId])

  // Fetch source request
  useEffect(() => {
    if (record.sourceRequestId) {
      getRequest(record.sourceRequestId).then(setSourceRequest)
    }
  }, [record.sourceRequestId])

  // Fetch source job definition
  useEffect(() => {
    if (record.sourceJobDefinitionId) {
      getJobDefinition(record.sourceJobDefinitionId).then(setSourceJobDef)
    }
  }, [record.sourceJobDefinitionId])

  // Fetch blueprint content from IPFS
  useEffect(() => {
    if (record.ipfsHash) {
      fetchIpfsContent(record.ipfsHash).then(result => {
        if (result) {
          // Preserve full IPFS payload for raw view (includes metadata like networkId)
          setRequestIpfsRawContent(result.content)

          try {
            const parsed = JSON.parse(result.content)
            // Extract blueprint (new architecture) or fall back to prompt (legacy)
            const blueprint = parsed.blueprint || parsed.prompt || result.content
            setPromptContent(blueprint)
            // Extract enabledTools from root level of IPFS JSON
            if (Array.isArray(parsed.enabledTools)) {
              setIpfsEnabledTools(parsed.enabledTools)
            }
          } catch {
            // If parsing fails, use raw content
            setPromptContent(result.content)
          }
        }
      })
    }
  }, [record.ipfsHash])

  // Fetch delivery content from IPFS
  useEffect(() => {
    if (record.deliveryIpfsHash && record.delivered) {
      fetchIpfsContent(record.deliveryIpfsHash, record.id).then(result => {
        if (result) setDeliveryContent(result.content)
      })
    }
  }, [record.deliveryIpfsHash, record.id, record.delivered])

  // Fetch delivery record from Ponder for status updates
  useEffect(() => {
    if (record.delivered) {
      queryDeliveries({ where: { requestId: record.id }, limit: 1 })
        .then(res => {
          if (res.items.length > 0) setDeliveryRecord(res.items[0])
        })
        .catch(err => console.error('Error fetching delivery record:', err))
    }
  }, [record.id, record.delivered])

  // Extract execution data - prioritize delivery data as ground truth
  const executionData = record.delivered ? {
    status: deliveryRecord?.jobInstanceStatusUpdate || memoryData?.situation?.execution?.status || 'COMPLETED',
    trace: deliveryData?.telemetry?.toolCalls,
    finalOutput: (() => {
      // Try deliveryData.output first
      if (deliveryData?.output) {
        return typeof deliveryData.output === 'string' ? deliveryData.output : JSON.stringify(deliveryData.output);
      }
      // If there's an error, show the error details
      if (deliveryData?.telemetry?.errorMessage || deliveryData?.telemetry?.errorType) {
        return `Error: ${deliveryData.telemetry.errorType || 'Unknown'}\n\n${deliveryData.telemetry.errorMessage || 'No error message available'}`;
      }
      // Fallback to situation summary
      return memoryData?.situation?.execution?.finalOutputSummary;
    })(),
    artifacts: memoryData?.situation?.artifacts || deliveryData?.artifacts || [],
    tokens: deliveryData?.telemetry?.tokens,
    duration: deliveryData?.telemetry?.duration,
    telemetry: deliveryData?.telemetry,
    hasError: !!(deliveryData?.telemetry?.errorMessage || deliveryData?.telemetry?.errorType)
  } : undefined

  // Compute tool metrics from agent telemetry
  const toolMetrics = (() => {
    const toolCalls = executionData?.telemetry?.toolCalls || []
    if (toolCalls.length === 0) return null

    const byTool: Record<string, { calls: number; successes: number; failures: number; totalDuration_ms: number; avgDuration_ms: number }> = {}
    let totalCalls = 0
    let successCount = 0
    let failureCount = 0

    for (const call of toolCalls) {
      if (!call || typeof call !== 'object') continue

      totalCalls++
      const tool = call.tool || 'unknown'
      const success = call.success !== false

      if (success) {
        successCount++
      } else {
        failureCount++
      }

      if (!byTool[tool]) {
        byTool[tool] = {
          calls: 0,
          successes: 0,
          failures: 0,
          totalDuration_ms: 0,
          avgDuration_ms: 0
        }
      }

      byTool[tool].calls++
      if (success) {
        byTool[tool].successes++
      } else {
        byTool[tool].failures++
      }

      const duration = call.duration_ms || 0
      byTool[tool].totalDuration_ms += duration
      byTool[tool].avgDuration_ms = byTool[tool].totalDuration_ms / byTool[tool].calls
    }

    return {
      totalCalls,
      successCount,
      failureCount,
      byTool
    }
  })()

  console.log('[JobDetailLayout] Execution data state:', {
    hasSituation: memoryData?.hasSituation,
    hasDeliveryData: !!deliveryData,
    hasExecutionData: !!executionData,
    hasTelemetry: !!deliveryData?.telemetry,
    hasTrace: !!deliveryData?.telemetry?.toolCalls,
    hasOutput: !!deliveryData?.output,
    loadingMemory,
    loadingDelivery,
    delivered: record.delivered
  })

  return (
    <Tabs defaultValue="pretty" className="w-full">
      <TabsList className="mb-6 bg-muted p-1 rounded-lg">
        <TabsTrigger value="pretty" className="data-[state=active]:bg-card data-[state=active]:shadow">
          Pretty
        </TabsTrigger>
        <TabsTrigger value="raw" className="data-[state=active]:bg-card data-[state=active]:shadow">
          Raw
        </TabsTrigger>
      </TabsList>

      <TabsContent value="pretty" className="mt-0">
        <div className="flex gap-6">
          {/* Main Content - 8/12 width */}
          <div className="flex-1 space-y-6" style={{ maxWidth: '66.666%' }}>
            {/* Request */}
            <Card>
              <CardHeader>
                <CardTitle>Request</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-2">Blueprint</div>
                    {promptContent ? (
                      (() => {
                        try {
                          const parsed = JSON.parse(promptContent)
                          const blueprintContent = parsed.blueprint || parsed.prompt || promptContent

                          // Check if blueprint itself is JSON with invariants/assertions structure
                          try {
                            const blueprintParsed = typeof blueprintContent === 'string'
                              ? JSON.parse(blueprintContent)
                              : blueprintContent

                            const items = parseInvariants(blueprintParsed)
                            if (items.length > 0) {
                              // Render structured blueprint with invariants using shared components
                              return (
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                                  {items.map((item, idx) => (
                                    <InvariantCard
                                      key={item.id || idx}
                                      invariant={item as Invariant | LegacyInvariant}
                                    />
                                  ))}
                                </div>
                              )
                            }
                          } catch {
                            // Not a structured blueprint, fall through
                          }

                          // Render as markdown if not structured
                          return (
                            <div className="bg-muted p-4 rounded text-sm max-h-[300px] overflow-auto prose prose-sm max-w-none">
                              <ReactMarkdown>{typeof blueprintContent === 'string' ? blueprintContent : JSON.stringify(blueprintContent, null, 2)}</ReactMarkdown>
                            </div>
                          )
                        } catch {
                          // If not JSON, render as-is
                          return (
                            <div className="bg-muted p-4 rounded text-sm max-h-[300px] overflow-auto prose prose-sm max-w-none">
                              <ReactMarkdown>{promptContent}</ReactMarkdown>
                            </div>
                          )
                        }
                      })()
                    ) : (
                      <div className="text-gray-500 text-sm">Loading...</div>
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-2">Enabled Tools</div>
                    {(() => {
                      // Use IPFS-sourced enabledTools as primary source, fallback to record.enabledTools
                      let tools: string[] = ipfsEnabledTools.length > 0
                        ? ipfsEnabledTools
                        : []

                      // Fallback to record.enabledTools if IPFS didn't provide tools
                      if (tools.length === 0 && record.enabledTools) {
                        if (typeof record.enabledTools === 'string') {
                          tools = record.enabledTools.split(',').map((t: string) => t.trim()).filter(Boolean)
                        } else if (Array.isArray(record.enabledTools)) {
                          tools = record.enabledTools
                        }
                      }

                      if (tools.length === 0) {
                        return <div className="text-gray-500 text-sm">None</div>
                      }

                      return (
                        <div className="flex flex-wrap gap-2">
                          {tools.map((tool, idx) => (
                            <span
                              key={idx}
                              className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium bg-primary/10 text-primary border border-primary/30"
                            >
                              {tool}
                            </span>
                          ))}
                        </div>
                      )
                    })()}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Recognition Phase */}
            <RecognitionPhaseCard
              recognitionData={memoryData?.recognition || null}
              hasRecognition={memoryData?.hasRecognition || false}
            />

            {/* Execution/Delivery */}
            <Card>
              <CardHeader>
                <CardTitle>Execution/Delivery</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  {deliveryData || executionData ? (
                    <>
                      {executionData?.finalOutput && (
                        <div>
                          <div className="text-sm font-medium text-gray-400 mb-2">Final Output</div>
                          <div className="bg-muted p-4 rounded text-sm overflow-auto prose prose-sm max-w-none">
                            <ReactMarkdown>
                              {deliveryData?.structuredSummary || executionData.finalOutput}
                            </ReactMarkdown>
                          </div>
                          {deliveryData?.structuredSummary && deliveryData.structuredSummary !== executionData.finalOutput && (
                            <details className="mt-2">
                              <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-800">
                                View full raw output
                              </summary>
                              <div className="mt-2 bg-muted p-4 rounded text-sm overflow-auto prose prose-sm max-w-none">
                                <ReactMarkdown>{executionData.finalOutput}</ReactMarkdown>
                              </div>
                            </details>
                          )}
                        </div>
                      )}

                      <div>
                        <div className="text-sm font-medium text-gray-400 mb-3">Agentic Task Trace</div>

                        {executionData?.telemetry ? (
                          <>
                            {/* Stats Cards */}
                            <div className="grid grid-cols-4 gap-3 mb-4">
                              {/* Model */}
                              <div className="bg-muted border rounded-lg p-3">
                                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                  <Cpu className="w-3 h-3" />
                                  <span>Model</span>
                                </div>
                                <div className="text-sm font-semibold">
                                  {executionData.telemetry.raw?.model || 'N/A'}
                                </div>
                              </div>

                              {/* Input Tokens */}
                              <div className="bg-muted border rounded-lg p-3">
                                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                  <Zap className="w-3 h-3" />
                                  <span>Input Tokens</span>
                                </div>
                                <div className="text-sm font-semibold">
                                  {executionData.telemetry.raw?.inputTokens?.toLocaleString() || 'N/A'}
                                </div>
                              </div>

                              {/* Total Tokens */}
                              <div className="bg-muted border rounded-lg p-3">
                                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                  <Zap className="w-3 h-3" />
                                  <span>Total Tokens</span>
                                </div>
                                <div className="text-sm font-semibold">
                                  {executionData.telemetry.totalTokens?.toLocaleString() || 'N/A'}
                                </div>
                              </div>

                              {/* Duration */}
                              <div className="bg-muted border rounded-lg p-3">
                                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                  <Clock className="w-3 h-3" />
                                  <span>Duration</span>
                                </div>
                                <div className="text-sm font-semibold">
                                  {executionData.telemetry.duration || executionData?.duration || 'N/A'}ms
                                </div>
                              </div>
                            </div>

                            {/* Tool Metrics Summary */}
                            {toolMetrics && (
                              <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 mb-4">
                                <div className="flex items-center gap-2 text-sm font-medium text-primary mb-3">
                                  <Wrench className="w-4 h-4" />
                                  <span>Tool Call Metrics</span>
                                </div>
                                <div className="grid grid-cols-3 gap-4 mb-3">
                                  <div>
                                    <div className="text-xs text-primary">Total Calls</div>
                                    <div className="text-lg font-semibold text-foreground">
                                      {toolMetrics.totalCalls}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-xs text-green-600">Successes</div>
                                    <div className="text-lg font-semibold text-green-700">
                                      {toolMetrics.successCount}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-xs text-red-600">Failures</div>
                                    <div className="text-lg font-semibold text-red-700">
                                      {toolMetrics.failureCount}
                                    </div>
                                  </div>
                                </div>
                                {Object.keys(toolMetrics.byTool).length > 0 && (
                                  <details>
                                    <summary className="text-xs text-primary cursor-pointer hover:text-primary">
                                      View breakdown by tool
                                    </summary>
                                    <div className="mt-2 space-y-1">
                                      {Object.entries(toolMetrics.byTool)
                                        .sort(([, a], [, b]) => b.calls - a.calls)
                                        .map(([tool, stats]) => (
                                          <div key={tool} className="flex items-center justify-between text-xs bg-card/50 rounded px-2 py-1 border">
                                            <span className="font-mono text-primary">{tool}</span>
                                            <div className="flex items-center gap-3">
                                              <span className="text-muted-foreground">{stats.calls} calls</span>
                                              {stats.failures > 0 && (
                                                <span className="text-red-600">{stats.failures} failed</span>
                                              )}
                                              <span className="text-muted-foreground">avg {Math.round(stats.avgDuration_ms)}ms</span>
                                            </div>
                                          </div>
                                        ))}
                                    </div>
                                  </details>
                                )}
                              </div>
                            )}

                            {/* Event Timeline */}
                            <div className="space-y-2">
                              {(() => {
                                const events = executionData.telemetry.raw?.events || []
                                const requestText = executionData.telemetry.requestText || []
                                const responseText = executionData.telemetry.responseText || []
                                const toolCalls = executionData.telemetry.toolCalls || []

                                let apiPairIndex = 0
                                let toolCallIndex = 0
                                let userPromptIndex = 0

                                let displayIndex = 0

                                return events.map((event, idx: number) => {
                                  if (typeof event !== 'string') return null
                                  const eventType = event.split('.')[1] || event

                                  // Skip config and model_routing events
                                  if (eventType === 'config' || eventType === 'model_routing') {
                                    return null
                                  }

                                  displayIndex++

                                  let icon = null
                                  let label = ''
                                  let content = null
                                  let colorClass = 'text-gray-400'

                                  if (eventType === 'user_prompt') {
                                    icon = <FileText className="w-4 h-4" />
                                    label = 'User Prompt'
                                    content = requestText[userPromptIndex]
                                    userPromptIndex++
                                    colorClass = 'text-primary'
                                  } else if (eventType === 'api_request') {
                                    icon = <ArrowRight className="w-4 h-4" />
                                    label = `API Request #${apiPairIndex + 1}`
                                    content = requestText[apiPairIndex]
                                    colorClass = 'text-green-600'
                                  } else if (eventType === 'api_response') {
                                    icon = <ArrowLeft className="w-4 h-4" />
                                    label = `API Response #${apiPairIndex + 1}`
                                    content = responseText[apiPairIndex]
                                    apiPairIndex++
                                    colorClass = 'text-green-600'
                                  } else if (eventType === 'tool_call') {
                                    const toolCall = toolCalls[toolCallIndex]
                                    icon = <Wrench className="w-4 h-4" />
                                    label = `Tool Call: ${(typeof toolCall === 'object' && toolCall?.tool) || 'Unknown'}`
                                    content = toolCall
                                    toolCallIndex++
                                    colorClass = 'text-purple-600'
                                  }

                                  return (
                                    <details key={idx} className="group border rounded-lg">
                                      <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted transition-colors">
                                        <span className="text-xs font-mono text-gray-400 w-6">{displayIndex}</span>
                                        <span className={colorClass}>{icon}</span>
                                        <Badge variant="outline" className="text-xs">
                                          {label}
                                        </Badge>
                                        {eventType === 'tool_call' && content && typeof content === 'object' && (
                                          <span className={`text-xs ml-auto ${content.success ? 'text-green-600' : 'text-red-600'}`}>
                                            {content.success ? '✓ Success' : '✗ Failed'}
                                          </span>
                                        )}
                                      </summary>
                                      <div className="px-4 pb-4 pt-2 border-t">
                                        {eventType === 'tool_call' && content && typeof content === 'object' ? (
                                          <div className="space-y-3">
                                            <div className="grid grid-cols-2 gap-3 text-xs">
                                              <div>
                                                <span className="text-gray-400">Tool:</span>
                                                <span className="ml-2 font-medium">{content.tool}</span>
                                              </div>
                                              <div>
                                                <span className="text-gray-400">Duration:</span>
                                                <span className="ml-2 font-medium">{content.duration_ms}ms</span>
                                              </div>
                                            </div>
                                            {content.args !== undefined && (
                                              <div>
                                                <div className="text-xs text-muted-foreground mb-1">Arguments:</div>
                                                <pre className="bg-muted p-3 rounded overflow-auto max-h-[200px] text-xs font-mono">
                                                  {typeof content.args === 'object' ? JSON.stringify(content.args, null, 2) : String(content.args)}
                                                </pre>
                                              </div>
                                            )}
                                            {content.result !== undefined && (
                                              <div>
                                                <div className="text-xs text-gray-400 mb-1">Result:</div>
                                                <pre className="bg-muted p-3 rounded overflow-auto max-h-[200px] text-xs font-mono">
                                                  {typeof content.result === 'object' ? JSON.stringify(content.result, null, 2) : String(content.result)}
                                                </pre>
                                              </div>
                                            )}
                                          </div>
                                        ) : content ? (
                                          <pre className="bg-muted p-3 rounded overflow-auto max-h-[300px] text-xs font-mono whitespace-pre-wrap">
                                            {(() => {
                                              if (typeof content === 'string') {
                                                try {
                                                  const parsed = JSON.parse(content)
                                                  return JSON.stringify(parsed, null, 2)
                                                } catch {
                                                  return content
                                                }
                                              }
                                              return JSON.stringify(content, null, 2)
                                            })()}
                                          </pre>
                                        ) : (
                                          <div className="text-xs text-gray-500">No additional data</div>
                                        )}
                                      </div>
                                    </details>
                                  )
                                }).filter(Boolean)
                              })()}
                            </div>

                            {/* Full Telemetry JSON */}
                            <details className="mt-4">
                              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                                View full telemetry JSON
                              </summary>
                              <pre className="mt-2 bg-muted p-3 rounded overflow-auto max-h-[300px] text-xs font-mono">
                                {JSON.stringify(executionData.telemetry, null, 2)}
                              </pre>
                            </details>
                          </>
                        ) : (
                          <div className="text-sm text-gray-500 italic">
                            Telemetry not available
                          </div>
                        )}
                      </div>

                      {/* Artifacts */}
                      <div>
                        <div className="text-sm font-medium text-gray-400 mb-2">Artifacts</div>
                        {(() => {
                          const filteredArtifacts = artifacts.filter(
                            (a) => a.topic !== 'MEMORY' && a.topic !== 'SITUATION' && a.topic !== 'WORKER_TELEMETRY'
                          )

                          if (loadingArtifacts) {
                            return <div className="text-gray-500 text-sm">Loading artifacts...</div>
                          }

                          if (filteredArtifacts.length === 0) {
                            return <div className="text-gray-500 text-sm">No artifacts created</div>
                          }

                          return (
                            <div className="rounded-md border overflow-hidden">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Name</TableHead>
                                    <TableHead>Topic</TableHead>
                                    <TableHead>Preview</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {filteredArtifacts.map((artifact) => (
                                    <TableRow key={artifact.id}>
                                      <TableCell>
                                        <Link
                                          href={`/artifacts/${artifact.id}`}
                                          className="text-primary hover:text-primary hover:underline"
                                        >
                                          {artifact.name || 'Unnamed'}
                                        </Link>
                                      </TableCell>
                                      <TableCell className="text-muted-foreground">{artifact.topic || '-'}</TableCell>
                                      <TableCell className="text-muted-foreground text-xs">
                                        {artifact.contentPreview
                                          ? (artifact.contentPreview.length > 50
                                            ? artifact.contentPreview.substring(0, 50) + '...'
                                            : artifact.contentPreview)
                                          : '-'}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          )
                        })()}
                      </div>

                      {/* Child Jobs Spawned */}
                      <ChildJobsSection parentRequestId={record.id} />

                      {/* Parent Dispatch Indicator */}
                      <ParentDispatchIndicator
                        requestId={record.id}
                        sourceJobDefinitionId={record.sourceJobDefinitionId || null}
                        jobStatus={executionData?.status || null}
                      />
                    </>
                  ) : (
                    <div className="text-gray-500 text-sm">No data available</div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Reflection */}
            <Card>
              <CardHeader>
                <CardTitle>Reflection</CardTitle>
              </CardHeader>
              <CardContent>
                {record.delivered ? (
                  <div className="space-y-4">
                    <div>
                      <div className="text-sm font-medium text-gray-400 mb-2">Memory Artifacts</div>
                      {(() => {
                        // Try to get memory artifacts from multiple sources:
                        // 1. From Ponder artifacts (on-chain)
                        const ponderMemoryArtifacts = artifacts.filter((a) => a.topic === 'MEMORY')

                        // 2. From delivery reflection data (new flow)
                        const reflectionMemoryArtifacts: Artifact[] = []
                        if (deliveryData?.reflection?.telemetry?.toolCalls) {
                          deliveryData.reflection.telemetry.toolCalls.forEach((call) => {
                            if (call.tool === 'create_artifact' && call.result && call.success) {
                              reflectionMemoryArtifacts.push({
                                id: call.result.cid || 'inline',
                                name: call.result.name,
                                topic: call.result.topic || 'MEMORY',
                                cid: call.result.cid,
                                contentPreview: call.result.contentPreview
                              })
                            }
                          })
                        }

                        const allMemoryArtifacts = [...ponderMemoryArtifacts, ...reflectionMemoryArtifacts]

                        if (loadingArtifacts || loadingDelivery) {
                          return <div className="text-gray-500 text-sm">Loading...</div>
                        }

                        if (allMemoryArtifacts.length === 0) {
                          return <div className="text-gray-500 text-sm">No memory artifacts created</div>
                        }

                        return (
                          <div className="space-y-2">
                            {allMemoryArtifacts.map((artifact) => (
                              <div key={artifact.id || artifact.cid}>
                                {artifact.cid ? (
                                  <a
                                    href={`https://gateway.autonolas.tech/ipfs/${artifact.cid}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:text-primary hover:underline text-sm inline-flex items-center gap-1"
                                  >
                                    {artifact.name || 'Unnamed Memory Artifact'}
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                ) : (
                                  <Link
                                    href={`/artifacts/${artifact.id}`}
                                    className="text-primary hover:text-primary hover:underline text-sm"
                                  >
                                    {artifact.name || 'Unnamed Memory Artifact'}
                                  </Link>
                                )}
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                    </div>

                    {memoryData?.hasSituation ? (
                      <>
                        <div>
                          <div className="text-sm font-medium text-gray-400 mb-2">Situation Data</div>
                          <div className="flex items-center gap-4 text-sm text-gray-400">
                            <div className="flex items-center gap-2">
                              <Check className="w-4 h-4 text-green-600" />
                              <span>JSON created</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Check className="w-4 h-4 text-green-600" />
                              <span>Embedding created</span>
                            </div>
                          </div>
                        </div>

                        <details className="mt-4">
                          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                            Show raw JSON
                          </summary>
                          <pre className="mt-2 bg-muted p-3 rounded overflow-auto max-h-[300px] text-xs font-mono">
                            {JSON.stringify(memoryData.situation, null, 2)}
                          </pre>
                        </details>
                      </>
                    ) : (
                      <div className="text-sm text-gray-400">Situation data not available</div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-gray-400">Job not yet delivered</div>
                )}
              </CardContent>
            </Card>

            {/* Worker Telemetry */}
            <WorkerTelemetryCard
              telemetryLog={workerTelemetry}
              loading={loadingWorkerTelemetry}
            />
          </div>

          {/* Sidebar - 4/12 width */}
          <div className="w-80 space-y-6">
            {/* Job Run Info Card */}
            <Card>
              <CardHeader>
                <CardTitle>Job Run Info</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {/* View in Workstream Link */}
                  {loadingWorkstream ? (
                    <div className="text-gray-500 text-sm">Loading workstream...</div>
                  ) : workstreamId ? (
                    <div className="pb-2 border-b">
                      <Link
                        href={`/workstreams/${workstreamId}`}
                        className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary hover:underline"
                      >
                        <GitBranch className="w-4 h-4" />
                        View in Workstream
                      </Link>
                    </div>
                  ) : null}

                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-1">Requested Time</div>
                    <div className="text-sm text-gray-400">
                      {new Date(Number(record.blockTimestamp) * 1000).toLocaleString()}
                    </div>
                  </div>

                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-1">Requested Block</div>
                    <a
                      href={`https://basescan.org/block/${record.blockNumber}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:text-primary hover:underline text-sm"
                    >
                      {record.blockNumber}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>

                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-1">Job Run ID</div>
                    <div className="text-sm text-gray-400 font-mono break-all">
                      {record.id}
                    </div>
                  </div>

                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-1">Mech Address</div>
                    <a
                      href={`https://basescan.org/address/${record.mech}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-start gap-1 text-primary hover:text-primary hover:underline text-sm font-mono break-all"
                    >
                      <span className="break-all">{record.mech}</span>
                      <ExternalLink className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    </a>
                  </div>

                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-1">Sender Address</div>
                    <a
                      href={`https://basescan.org/address/${record.sender}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-start gap-1 text-primary hover:text-primary hover:underline text-sm font-mono break-all"
                    >
                      <span className="break-all">{record.sender}</span>
                      <ExternalLink className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    </a>
                  </div>

                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-1">Delivered Status</div>
                    <span className={`inline-flex items-center px-2 py-1 rounded text-xs border ${record.delivered
                      ? 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30'
                      : 'bg-muted text-muted-foreground border-muted-foreground/30'
                      }`}>
                      {record.delivered ? '✓ Delivered' : '⏳ Pending'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Job Info Card */}
            <Card>
              <CardHeader>
                <CardTitle>Job Info</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-1">Job ID</div>
                    {record.jobDefinitionId ? (
                      <Link
                        href={`/jobDefinitions/${record.jobDefinitionId}`}
                        className="text-primary hover:text-primary hover:underline text-sm font-mono break-all"
                      >
                        {record.jobDefinitionId}
                      </Link>
                    ) : (
                      <div className="text-gray-500 text-sm">N/A</div>
                    )}
                  </div>

                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-1">Source Job Run ID</div>
                    {record.sourceRequestId ? (
                      <Link
                        href={`/requests/${record.sourceRequestId}`}
                        className="text-primary hover:text-primary hover:underline text-sm font-mono break-all"
                      >
                        {record.sourceRequestId}
                      </Link>
                    ) : (
                      <div className="text-gray-500 text-sm">N/A</div>
                    )}
                  </div>

                  <div>
                    <div className="text-sm font-medium text-gray-400 mb-1">Source Job ID</div>
                    {record.sourceJobDefinitionId ? (
                      <Link
                        href={`/jobDefinitions/${record.sourceJobDefinitionId}`}
                        className="text-primary hover:text-primary hover:underline text-sm font-mono break-all"
                      >
                        {record.sourceJobDefinitionId}
                      </Link>
                    ) : (
                      <div className="text-gray-500 text-sm">N/A</div>
                    )}
                  </div>

                  {/* Parent Re-Run Status - NEW */}
                  <div>
                    <div className="flex items-center gap-1 mb-1">
                      <div className="text-sm font-medium text-gray-400">Parent Re-Run</div>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="w-3.5 h-3.5 text-gray-400 hover:text-gray-400 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="max-w-xs">New parent job run triggered by this completion (COMPLETED/FAILED status automatically re-dispatches parent)</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <ParentReRunField
                      requestId={record.id}
                      sourceJobDefinitionId={record.sourceJobDefinitionId || null}
                      jobStatus={executionData?.status || null}
                      delivered={record.delivered || false}
                      workerTelemetry={workerTelemetry}
                    />
                  </div>

                  {/* Status Update - moved from Execution/Delivery card */}
                  <div>
                    <div className="flex items-center gap-1 mb-1">
                      <div className="text-sm font-medium text-gray-400">Status Update</div>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="w-3.5 h-3.5 text-gray-400 hover:text-gray-400 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="max-w-xs">Job definition status after this run (COMPLETED, FAILED, DELEGATING, or WAITING)</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    {(deliveryData || executionData) && executionData?.status ? (
                      <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${executionData.status === 'COMPLETED'
                        ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                        : executionData.status === 'FAILED'
                          ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                          : executionData.status === 'DELEGATING'
                            ? 'bg-primary/20 text-primary'
                            : executionData.status === 'WAITING'
                              ? 'bg-purple-500/10 text-purple-700 dark:text-purple-400'
                              : executionData.status === 'PENDING'
                                ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
                                : 'bg-muted text-muted-foreground'
                        }`}>
                        <StatusIcon status={executionData.status} size={14} />
                        {executionData.status}
                      </span>
                    ) : (
                      <div className="text-gray-500 text-sm">Not yet available</div>
                    )}
                  </div>

                  {/* Dependencies Subsection */}
                  <DependenciesSection
                    requestId={record.id}
                    dependencies={record.dependencies}
                    renderAsSubsection={true}
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="raw" className="mt-0">
        <div className="space-y-6">
          <RawSection
            title="Job Data"
            description={
              <>
                Composite record from Ponder&apos;s <code className="text-xs bg-muted px-1 rounded">request</code> table.{' '}
                Combines the original <code className="text-xs bg-muted px-1 rounded">MarketplaceRequest</code> event data{' '}
                with enrichments from the <code className="text-xs bg-muted px-1 rounded">OlasMech:Deliver</code> event{' '}
                (e.g., <code className="text-xs bg-muted px-1 rounded">deliveryIpfsHash</code>, <code className="text-xs bg-muted px-1 rounded">delivered: true</code>).
              </>
            }
          >
            <RawContentBlock content={record} label="Job data" />
          </RawSection>

          <RawSection
            title="Job Definition Record"
            description={
              <>
                Record from Ponder&apos;s <code className="text-xs bg-muted px-1 rounded">jobDefinition</code> table,{' '}
                referenced by <code className="text-xs bg-muted px-1 rounded">request.jobDefinitionId</code>
              </>
            }
            action={
              record.jobDefinitionId ? (
                <Link
                  href={`/jobDefinitions/${record.jobDefinitionId}`}
                  className="text-sm text-primary hover:text-primary hover:underline whitespace-nowrap"
                >
                  View Full →
                </Link>
              ) : null
            }
          >
            {!record.jobDefinitionId ? (
              <RawState>No job definition for this request</RawState>
            ) : jobDefinition ? (
              <RawContentBlock content={jobDefinition} label="Job definition record" />
            ) : (
              <RawState>Loading...</RawState>
            )}
          </RawSection>

          <RawSection
            title="Request IPFS Content"
            description={
              <>
                Fetched from <code className="text-xs bg-muted px-1 rounded">request.ipfsHash</code> - the blueprint specification
                uploaded when posting the <code className="text-xs bg-muted px-1 rounded">MarketplaceRequest</code> event
              </>
            }
          >
            {!record.ipfsHash ? (
              <RawState>No IPFS hash for this request</RawState>
            ) : requestIpfsRawContent ? (
              <RawContentBlock
                content={requestIpfsRawContent}
                preserveWhitespace
                label="Request IPFS content"
              />
            ) : promptContent ? (
              <RawContentBlock content={promptContent} preserveWhitespace label="Request IPFS content" />
            ) : (
              <RawState>Loading...</RawState>
            )}
          </RawSection>

          <RawSection
            title="Source Request Record"
            description={
              <>
                Parent request record from Ponder&apos;s <code className="text-xs bg-muted px-1 rounded">request</code> table,{' '}
                referenced by <code className="text-xs bg-muted px-1 rounded">request.sourceRequestId</code> (for Work Protocol jobs)
              </>
            }
            action={
              record.sourceRequestId ? (
                <Link
                  href={`/requests/${record.sourceRequestId}`}
                  className="text-sm text-primary hover:text-primary hover:underline whitespace-nowrap"
                >
                  View Full →
                </Link>
              ) : null
            }
          >
            {!record.sourceRequestId ? (
              <RawState>No source request for this job</RawState>
            ) : sourceRequest ? (
              <RawContentBlock content={sourceRequest} label="Source request data" />
            ) : (
              <RawState>Loading...</RawState>
            )}
          </RawSection>

          <RawSection
            title="Source Job Definition Record"
            description={
              <>
                Parent job definition record from Ponder&apos;s <code className="text-xs bg-muted px-1 rounded">jobDefinition</code> table,{' '}
                referenced by <code className="text-xs bg-muted px-1 rounded">request.sourceJobDefinitionId</code> (for Work Protocol jobs)
              </>
            }
            action={
              record.sourceJobDefinitionId ? (
                <Link
                  href={`/jobDefinitions/${record.sourceJobDefinitionId}`}
                  className="text-sm text-primary hover:text-primary hover:underline whitespace-nowrap"
                >
                  View Full →
                </Link>
              ) : null
            }
          >
            {!record.sourceJobDefinitionId ? (
              <RawState>No source job definition for this request</RawState>
            ) : sourceJobDef ? (
              <RawContentBlock content={sourceJobDef} label="Source job definition record" />
            ) : (
              <RawState>Loading...</RawState>
            )}
          </RawSection>

          <RawSection
            title="Delivery IPFS Content"
            description={
              <>
                Fetched from <code className="text-xs bg-muted px-1 rounded">request.deliveryIpfsHash</code> - the result payload uploaded
                when the worker delivered via the <code className="text-xs bg-muted px-1 rounded">OlasMech:Deliver</code> event
              </>
            }
          >
            {!record.delivered ? (
              <RawState>Job not yet delivered</RawState>
            ) : !record.deliveryIpfsHash ? (
              <RawState>No delivery IPFS hash for this job</RawState>
            ) : deliveryData ? (
              <RawContentBlock content={deliveryData} preserveWhitespace label="Delivery IPFS payload" />
            ) : deliveryContent ? (
              <RawContentBlock content={deliveryContent} preserveWhitespace label="Delivery IPFS payload" />
            ) : (
              <RawState>Loading...</RawState>
            )}
          </RawSection>

          <RawSection
            title="Memory System Data"
            description={
              <>
                Reflection artifacts (<code className="text-xs bg-muted px-1 rounded">MEMORY</code>,{' '}
                <code className="text-xs bg-muted px-1 rounded">SITUATION</code>) and recognition phase data fetched from artifact IPFS
                content and enriched with embeddings
              </>
            }
          >
            {!memoryData || (!memoryData.hasSituation && !memoryData.hasRecognition) ? (
              <RawState>No memory system data for this job</RawState>
            ) : (
              <RawContentBlock
                content={{
                  situation: memoryData.situation,
                  recognition: memoryData.recognition,
                  hasSituation: memoryData.hasSituation,
                  hasRecognition: memoryData.hasRecognition
                }}
                label="Memory system data"
              />
            )}
          </RawSection>
        </div>
      </TabsContent>
    </Tabs>
  )
}
