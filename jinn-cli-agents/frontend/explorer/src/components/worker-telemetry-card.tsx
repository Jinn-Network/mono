'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Clock,
  AlertCircle,
  CheckCircle,
  Activity,
  GitBranch,
  GitCommit,
  Upload,
  FolderGit,
  Database,
  Globe,
  Cpu,
  Brain,
  Zap,
  FileText,
  ArrowUp,
  Archive,
  ExternalLink
} from 'lucide-react'

interface WorkerTelemetryEvent {
  timestamp: string
  phase: string
  event: string
  duration_ms?: number
  metadata?: Record<string, unknown>
  error?: string
}

interface WorkerTelemetryLog {
  version: string
  requestId: string
  jobName?: string
  startTime: string
  endTime?: string
  totalDuration_ms?: number
  events: WorkerTelemetryEvent[]
  summary: {
    totalEvents: number
    phases: string[]
    errors: number
  }
}

/** Get icon for phase */
function getPhaseIcon(phase: string) {
  switch (phase) {
    case 'initialization':
      return <FolderGit className="w-4 h-4" />
    case 'recognition':
      return <Brain className="w-4 h-4" />
    case 'agent_execution':
      return <Cpu className="w-4 h-4" />
    case 'reflection':
      return <Brain className="w-4 h-4" />
    case 'situation_creation':
      return <Database className="w-4 h-4" />
    case 'git_operations':
      return <GitBranch className="w-4 h-4" />
    case 'parent_dispatch':
      return <ArrowUp className="w-4 h-4" />
    case 'reporting':
      return <FileText className="w-4 h-4" />
    case 'telemetry_persistence':
      return <Archive className="w-4 h-4" />
    case 'delivery':
      return <Zap className="w-4 h-4" />
    default:
      return <Activity className="w-4 h-4" />
  }
}

/** Get icon for event type */
function getEventIcon(event: string) {
  if (event === 'repo_clone') return <FolderGit className="w-3 h-3" />
  if (event === 'branch_checkout') return <GitBranch className="w-3 h-3" />
  if (event === 'auto_commit') return <GitCommit className="w-3 h-3" />
  if (event === 'push' || event === 'push_skipped') return <Upload className="w-3 h-3" />
  if (event === 'branch_artifact_created') return <Database className="w-3 h-3" />
  if (event === 'ipfs_fetch') return <Globe className="w-3 h-3" />
  if (event === 'agent_complete') return <Cpu className="w-3 h-3" />
  return null
}

/** Format metadata for specific event types */
function formatEventMetadata(event: string, metadata: Record<string, unknown>): React.ReactElement | null {
  // Git clone event
  if (event === 'repo_clone') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        <Badge variant="outline" className="text-xs">
          {metadata.wasAlreadyCloned ? 'Already cloned' : 'Fresh clone'}
        </Badge>
        {!!metadata.fetchPerformed && (
          <Badge variant="outline" className="text-xs">Fetch performed</Badge>
        )}
      </div>
    )
  }

  // Dependency sync event
  if (event === 'dependency_sync') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        <Badge variant="outline" className={`text-xs ${metadata.hasConflicts ? 'text-yellow-600 border-yellow-200 bg-yellow-50' :
            metadata.synced ? 'text-green-600 border-green-200 bg-green-50' :
              'text-gray-500'
          }`}>
          {metadata.hasConflicts ? 'Conflicts Detected' :
            metadata.synced ? 'Synced' : 'Skipped'}
        </Badge>

        {!!metadata.dependencyJobDefId && (
          <a
            href={`/job-definitions/${metadata.dependencyJobDefId}`}
            className="text-xs text-primary hover:text-primary hover:underline inline-flex items-center gap-1"
          >
            Job {String(metadata.dependencyJobDefId).slice(0, 8)}...
            <ExternalLink className="w-3 h-3" />
          </a>
        )}

        {!!metadata.sourceBranch && (
          <span className="text-xs text-gray-500 font-mono">
            {String(metadata.sourceBranch)}
          </span>
        )}

        {!!metadata.hasConflicts && Array.isArray(metadata.conflictingFiles) && metadata.conflictingFiles.length > 0 && (
          <div className="w-full mt-1">
            <div className="text-xs text-yellow-600 mb-1">Conflicting files:</div>
            <ul className="text-xs text-gray-500 font-mono list-disc pl-4 space-y-0.5">
              {metadata.conflictingFiles.map((file: string) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  // Branch checkout event
  if (event === 'branch_checkout') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        <Badge variant="outline" className="text-xs font-mono">
          {String(metadata.branchName)}
        </Badge>
        <Badge variant="outline" className="text-xs">
          {metadata.checkoutMethod === 'new_from_base' ? 'Created new' :
            metadata.checkoutMethod === 'remote_tracking' ? 'From remote' : 'Local'}
        </Badge>
        {!!metadata.baseBranch && (
          <span className="text-xs text-gray-500">base: {String(metadata.baseBranch)}</span>
        )}
      </div>
    )
  }

  // Auto commit event
  if (event === 'auto_commit') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!metadata.commitHash && (
          <Badge variant="outline" className="text-xs font-mono">
            {String(metadata.commitHash).slice(0, 7)}
          </Badge>
        )}
        {typeof metadata.filesChanged === 'number' && (
          <span className="text-xs text-gray-500">{metadata.filesChanged} file(s) changed</span>
        )}
      </div>
    )
  }

  // Push event
  if (event === 'push') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        <CheckCircle className="w-3 h-3 text-green-500" />
        <span className="text-xs text-green-600">Pushed to remote</span>
        {!!metadata.branchUrl && (
          <a
            href={String(metadata.branchUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:text-primary hover:underline inline-flex items-center gap-1"
          >
            View branch
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {!!metadata.branchName && (
          <Badge variant="outline" className="text-xs font-mono">
            {String(metadata.branchName)}
          </Badge>
        )}
      </div>
    )
  }

  // Push skipped event
  if (event === 'push_skipped') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        <span className="text-xs text-gray-500">
          {metadata.reason ? String(metadata.reason) : 'Push skipped'}
        </span>
      </div>
    )
  }

  // IPFS fetch event
  if (event === 'ipfs_fetch') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!metadata.cid && (
          <span className="text-xs font-mono text-gray-500">
            {String(metadata.cid).slice(0, 12)}...
          </span>
        )}
        {typeof metadata.duration_ms === 'number' && (
          <span className="text-xs text-gray-500">{metadata.duration_ms}ms</span>
        )}
        {metadata.success === true && (
          <CheckCircle className="w-3 h-3 text-green-500" />
        )}
        {metadata.success === false && (
          <AlertCircle className="w-3 h-3 text-red-500" />
        )}
      </div>
    )
  }

  // Metadata fetched event
  if (event === 'metadata_fetched') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!metadata.hasJobName && (
          <Badge variant="outline" className="text-xs">Has job name</Badge>
        )}
        {!!metadata.hasBlueprint && (
          <Badge variant="outline" className="text-xs">Has blueprint</Badge>
        )}
        {!!metadata.hasCodeMetadata && (
          <Badge variant="outline" className="text-xs">Has code metadata</Badge>
        )}
      </div>
    )
  }

  // Prompt augmented event
  if (event === 'prompt_augmented') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {typeof metadata.learningsCount === 'number' && (
          <Badge variant="outline" className="text-xs">
            {metadata.learningsCount} learnings
          </Badge>
        )}
        {typeof metadata.prefixLength === 'number' && (
          <span className="text-xs text-gray-500">
            {metadata.prefixLength.toLocaleString()} chars added
          </span>
        )}
      </div>
    )
  }

  // Completed event (agent_execution)
  if (event === 'completed') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {typeof metadata.inputTokens === 'number' && (
          <Badge variant="outline" className="text-xs">
            In: {metadata.inputTokens.toLocaleString()} tokens
          </Badge>
        )}
        {typeof metadata.outputTokens === 'number' && (
          <Badge variant="outline" className="text-xs">
            Out: {metadata.outputTokens.toLocaleString()} tokens
          </Badge>
        )}
        {typeof metadata.totalTokens === 'number' && !metadata.inputTokens && (
          <Badge variant="outline" className="text-xs">
            {metadata.totalTokens.toLocaleString()} tokens
          </Badge>
        )}
        {typeof metadata.toolCalls === 'number' && (
          <Badge variant="outline" className="text-xs">
            {metadata.toolCalls} tool calls
          </Badge>
        )}
        {!!metadata.inferredStatus && (
          <Badge variant="outline" className={`text-xs ${metadata.inferredStatus === 'COMPLETED' ? 'text-green-600' :
              metadata.inferredStatus === 'FAILED' ? 'text-red-600' :
                'text-gray-400'
            }`}>
            Status: {String(metadata.inferredStatus)}
          </Badge>
        )}
      </div>
    )
  }

  // Reflection complete event
  if (event === 'reflection_complete') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!metadata.hasMemoryArtifacts && (
          <CheckCircle className="w-3 h-3 text-green-500" />
        )}
        {metadata.hasMemoryArtifacts ? (
          <span className="text-xs text-green-600">Memory artifacts created</span>
        ) : (
          <span className="text-xs text-gray-500">No memory artifacts</span>
        )}
        {typeof metadata.learningsCount === 'number' && metadata.learningsCount > 0 && (
          <Badge variant="outline" className="text-xs">
            {metadata.learningsCount} learnings
          </Badge>
        )}
      </div>
    )
  }

  // Situation artifact created event
  if (event === 'situation_artifact_created') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!metadata.cid && (
          <a
            href={`https://gateway.autonolas.tech/ipfs/${metadata.cid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-primary hover:text-primary hover:underline inline-flex items-center gap-1"
          >
            {String(metadata.cid).slice(0, 12)}...
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {!!metadata.hasEmbedding && (
          <Badge variant="outline" className="text-xs text-green-600">
            Embedding created
          </Badge>
        )}
      </div>
    )
  }

  // Branch artifact created event
  if (event === 'branch_artifact_created') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!metadata.branchUrl && (
          <a
            href={String(metadata.branchUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:text-primary hover:underline inline-flex items-center gap-1"
          >
            View branch
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {!!metadata.branchName && (
          <Badge variant="outline" className="text-xs font-mono">
            {String(metadata.branchName)}
          </Badge>
        )}
        {!!metadata.baseBranch && (
          <span className="text-xs text-gray-500">base: {String(metadata.baseBranch)}</span>
        )}
        {!!metadata.cid && (
          <span className="text-xs font-mono text-gray-500">
            CID: {String(metadata.cid).slice(0, 12)}...
          </span>
        )}
      </div>
    )
  }

  // Delivery started event
  if (event === 'delivery_started') {
    const artifactCids: string[] = Array.isArray(metadata.artifactCids) ? metadata.artifactCids : []
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        <span className="text-xs text-gray-400">
          Delivering {Number(metadata.artifactCount) || artifactCids.length} artifact{(Number(metadata.artifactCount) || artifactCids.length) === 1 ? '' : 's'}
        </span>
        {artifactCids.length > 0 && (
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer hover:text-gray-400">Artifact CIDs</summary>
            <div className="mt-1 ml-2 space-y-1">
              {artifactCids.map((cid: string) => (
                <a
                  key={cid}
                  href={`https://gateway.autonolas.tech/ipfs/${cid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block font-mono text-primary hover:text-primary hover:underline"
                >
                  {cid.slice(0, 18)}...
                </a>
              ))}
            </div>
          </details>
        )}
      </div>
    )
  }

  // Delivery completed event (new) and legacy delivered event
  if (event === 'delivery_completed' || event === 'delivered') {
    const txHash = metadata.txHash || metadata.tx_hash
    const status = metadata.status
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!txHash && (
          <a
            href={`https://basescan.org/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-primary hover:text-primary hover:underline inline-flex items-center gap-1"
          >
            {String(txHash).slice(0, 10)}...
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {!!status && (
          <Badge variant="outline" className={`text-xs ${status === 'confirmed' || status === 'delivered' || status === 'DELIVERED' ? 'text-green-600' :
              status === 'reverted' ? 'text-red-600' :
                'text-gray-400'
            }`}>
            {String(status)}
          </Badge>
        )}
        <CheckCircle className="w-3 h-3 text-green-500" />
      </div>
    )
  }

  // Delivery failed event
  if (event === 'delivery_failed') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4 text-xs text-red-600">
        <AlertCircle className="w-3 h-3" />
        <span>{metadata.message ? String(metadata.message) : 'Delivery failed'}</span>
      </div>
    )
  }

  // Report stored event
  if (event === 'report_stored') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!metadata.status && (
          <Badge variant="outline" className={`text-xs ${metadata.status === 'COMPLETED' ? 'text-green-600' :
              metadata.status === 'FAILED' ? 'text-red-600' :
                'text-gray-400'
            }`}>
            Status: {String(metadata.status)}
          </Badge>
        )}
        <CheckCircle className="w-3 h-3 text-green-500" />
        <span className="text-xs text-green-600">Report stored</span>
      </div>
    )
  }

  // Dispatching parent event
  if (event === 'dispatching_parent') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!metadata.parentJobDefId && (
          <a
            href={`/job-definitions/${metadata.parentJobDefId}`}
            className="text-xs text-primary hover:text-primary hover:underline"
          >
            Parent: {String(metadata.parentJobDefId).slice(0, 8)}...
          </a>
        )}
        {!!metadata.childStatus && (
          <Badge variant="outline" className={`text-xs ${metadata.childStatus === 'COMPLETED' ? 'text-green-600' :
              metadata.childStatus === 'FAILED' ? 'text-red-600' :
                'text-gray-400'
            }`}>
            Child: {String(metadata.childStatus)}
          </Badge>
        )}
        {!!metadata.reason && (
          <span className="text-xs text-gray-500">{String(metadata.reason)}</span>
        )}
      </div>
    )
  }

  // Dispatch success event
  if (event === 'dispatch_success') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!metadata.newRequestId && (
          <a
            href={`/requests/${metadata.newRequestId}`}
            className="text-xs text-primary hover:text-primary hover:underline inline-flex items-center gap-1"
          >
            New request: {String(metadata.newRequestId).slice(0, 8)}...
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        <CheckCircle className="w-3 h-3 text-green-500" />
        <span className="text-xs text-green-600">Parent dispatched</span>
      </div>
    )
  }

  // Telemetry persistence artifact saved
  if (event === 'artifact_saved') {
    return (
      <div className="flex flex-wrap gap-2 mt-1 ml-4">
        {!!metadata.cid && (
          <a
            href={`https://gateway.autonolas.tech/ipfs/${metadata.cid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-primary hover:text-primary hover:underline inline-flex items-center gap-1"
          >
            {String(metadata.cid).slice(0, 12)}...
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {!!metadata.events && (
          <Badge variant="outline" className="text-xs">
            {String(metadata.events)} events
          </Badge>
        )}
        <span className="text-xs text-gray-400">
          Saved worker telemetry {metadata.name ? `(${metadata.name})` : ''}
        </span>
      </div>
    )
  }

  // Default: no special formatting
  return null
}

interface WorkerTelemetryCardProps {
  telemetryLog: WorkerTelemetryLog | null
  loading?: boolean
}

export function WorkerTelemetryCard({ telemetryLog, loading }: WorkerTelemetryCardProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Worker Telemetry</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-gray-500 text-sm">Loading worker telemetry...</div>
        </CardContent>
      </Card>
    )
  }

  if (!telemetryLog) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Worker Telemetry</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-gray-500 text-sm">No worker telemetry available</div>
        </CardContent>
      </Card>
    )
  }

  // Group events by phase
  const phaseGroups = telemetryLog.events.reduce((acc, event) => {
    if (!acc[event.phase]) {
      acc[event.phase] = []
    }
    acc[event.phase].push(event)
    return acc
  }, {} as Record<string, WorkerTelemetryEvent[]>)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Worker Telemetry</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {/* Summary Stats */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-muted border rounded-lg p-3">
              <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
                <Clock className="w-3 h-3" />
                <span>Total Duration</span>
              </div>
              <div className="text-sm font-semibold text-gray-900">
                {telemetryLog.totalDuration_ms ? `${(telemetryLog.totalDuration_ms / 1000).toFixed(1)}s` : 'N/A'}
              </div>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
                <Activity className="w-3 h-3" />
                <span>Events</span>
              </div>
              <div className="text-sm font-semibold text-gray-900">
                {telemetryLog.summary.totalEvents}
              </div>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
                <CheckCircle className="w-3 h-3" />
                <span>Phases</span>
              </div>
              <div className="text-sm font-semibold text-gray-900">
                {telemetryLog.summary.phases.length}
              </div>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
                <AlertCircle className="w-3 h-3" />
                <span>Errors</span>
              </div>
              <div className={`text-sm font-semibold ${telemetryLog.summary.errors > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {telemetryLog.summary.errors}
              </div>
            </div>
          </div>


          {/* Phase Timeline */}
          <div>
            <div className="text-sm font-medium text-gray-400 mb-3">Execution Timeline</div>
            <div className="space-y-3">
              {telemetryLog.summary.phases.map((phase, idx) => {
                const events = phaseGroups[phase] || []
                const endEvent = events.find(e => e.event === 'phase_end')
                const hasErrors = events.some(e => e.event === 'error')

                return (
                  <details key={idx} className="group border border-gray-200 rounded-lg">
                    <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted transition-colors">
                      <span className="text-xs font-mono text-gray-400 w-6">{idx + 1}</span>
                      <span className="text-gray-500">{getPhaseIcon(phase)}</span>
                      <Badge
                        variant="outline"
                        className={`text-xs ${hasErrors ? 'border-red-300 text-red-700' : ''}`}
                      >
                        {phase.replace(/_/g, ' ')}
                      </Badge>
                      {endEvent?.duration_ms && (
                        <span className="text-xs text-gray-500 ml-auto">
                          {endEvent.duration_ms >= 1000
                            ? `${(endEvent.duration_ms / 1000).toFixed(1)}s`
                            : `${endEvent.duration_ms}ms`}
                        </span>
                      )}
                      {hasErrors && (
                        <AlertCircle className="w-4 h-4 text-red-500" />
                      )}
                    </summary>
                    <div className="px-4 pb-4 pt-2 border-t border-gray-100">
                      <div className="space-y-2">
                        {events.map((event, eventIdx) => {
                          const eventIcon = getEventIcon(event.event)
                          const formattedMetadata = event.metadata && Object.keys(event.metadata).length > 0
                            ? formatEventMetadata(event.event, event.metadata)
                            : null

                          return (
                            <div key={eventIdx} className="text-xs">
                              <div className="flex items-start gap-2">
                                <span className="text-gray-400 font-mono">
                                  {new Date(event.timestamp).toLocaleTimeString()}
                                </span>
                                {eventIcon && <span className="text-gray-500">{eventIcon}</span>}
                                <span className={`font-medium ${event.event === 'error' ? 'text-red-600' : 'text-gray-400'}`}>
                                  {event.event.replace(/_/g, ' ')}
                                </span>
                                {event.duration_ms && (
                                  <span className="text-gray-500">
                                    ({event.duration_ms >= 1000
                                      ? `${(event.duration_ms / 1000).toFixed(1)}s`
                                      : `${event.duration_ms}ms`})
                                  </span>
                                )}
                              </div>
                              {event.error && (
                                <div className="mt-1 ml-4 text-red-700 dark:text-red-400 bg-red-500/10 p-2 rounded">
                                  {event.error}
                                </div>
                              )}
                              {/* Enhanced metadata display for known event types */}
                              {formattedMetadata}
                              {/* Fallback raw metadata for unknown event types */}
                              {event.metadata && Object.keys(event.metadata).length > 0 && !formattedMetadata && (
                                <details className="mt-1 ml-4">
                                  <summary className="text-gray-500 cursor-pointer hover:text-gray-400">
                                    View metadata
                                  </summary>
                                  <pre className="mt-1 bg-muted p-2 rounded text-xs overflow-auto">
                                    {JSON.stringify(event.metadata, null, 2)}
                                  </pre>
                                </details>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </details>
                )
              })}
            </div>
          </div>

          {/* Raw JSON */}
          <details>
            <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-800">
              View full telemetry JSON
            </summary>
            <pre className="mt-2 bg-muted p-3 rounded overflow-auto max-h-[300px] text-xs font-mono">
              {JSON.stringify(telemetryLog, null, 2)}
            </pre>
          </details>
        </div>
      </CardContent>
    </Card>
  )
}

