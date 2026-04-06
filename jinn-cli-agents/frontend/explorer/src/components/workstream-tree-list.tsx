'use client'

import { useJobGraph } from '@/hooks/use-job-graph'
import { useRealtimeData } from '@/hooks/use-realtime-data'
import Link from 'next/link'
import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronRight, ChevronDown, X, ExternalLink, Clock, GitBranch, MousePointerClick } from 'lucide-react'
import { GraphNode, GraphEdge } from '@/lib/graph-queries'
import { StatusIcon } from '@/components/status-icon'
import { getJobDefinition, type JobDefinition, queryRequests, getDependencyInfo, type DependencyInfo } from '@/lib/subgraph'
import { JobDefinitionDetailLayout } from '@/components/job-definition-detail-layout'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'

interface WorkstreamTreeListProps {
  rootId: string
  initialSelectedJobId?: string | null
  selectedJobId?: string | null
  onJobSelectRoute?: (jobId: string) => void
}

interface TreeNode {
  node: GraphNode
  children: TreeNode[]
}

// Build a tree structure from flat nodes and edges
function buildTree(nodes: GraphNode[], edges: GraphEdge[], rootNode: GraphNode): TreeNode {
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const childrenMap = new Map<string, string[]>()
  
  // Build adjacency list
  for (const edge of edges) {
    if (!childrenMap.has(edge.source)) {
      childrenMap.set(edge.source, [])
    }
    childrenMap.get(edge.source)!.push(edge.target)
  }
  
  // Recursive function to build tree
  function buildNode(nodeId: string, visited: Set<string> = new Set()): TreeNode | null {
    if (visited.has(nodeId)) return null // Prevent cycles
    visited.add(nodeId)
    
    const node = nodeMap.get(nodeId)
    if (!node) return null
    
    const childIds = childrenMap.get(nodeId) || []
    const children: TreeNode[] = childIds
      .map(childId => buildNode(childId, new Set(visited)))
      .filter((child): child is TreeNode => child !== null)
      // Sort children by timestamp (ascending - oldest first)
      .sort((a, b) => {
        const timestampA = a.node.metadata.timestamp || 0
        const timestampB = b.node.metadata.timestamp || 0
        return timestampA - timestampB
      })
    
    return { node, children }
  }
  
  return buildNode(rootNode.id) || { node: rootNode, children: [] }
}

// Get status color classes matching job-definitions-table.tsx
function getStatusColor(status: string): string {
  const statusUpper = status.toUpperCase()
  if (statusUpper === 'COMPLETED') return 'bg-green-500/10 text-green-700 dark:text-green-400'
  if (statusUpper === 'FAILED') return 'bg-red-500/10 text-red-700 dark:text-red-400'
  if (statusUpper === 'DELEGATING') return 'bg-primary/20 text-primary'
  if (statusUpper === 'WAITING') return 'bg-purple-500/10 text-purple-700 dark:text-purple-400'
  if (statusUpper === 'PENDING') return 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
  return 'bg-muted text-muted-foreground'
}

// Recursive component to render tree nodes
function TreeNodeItem({ 
  treeNode, 
  depth = 0, 
  onSelectJob,
  allNodes,
  nextJobId,
  selectedJobId
}: { 
  treeNode: TreeNode; 
  depth?: number;
  onSelectJob: (jobId: string) => void;
  allNodes: GraphNode[];
  nextJobId: string | null;
  selectedJobId: string | null;
}) {
  const { node, children } = treeNode
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [dependencyInfo, setDependencyInfo] = useState<DependencyInfo[]>([])
  const [isHoveringDeps, setIsHoveringDeps] = useState(false)
  const [loadingDeps, setLoadingDeps] = useState(false)
  const hasChildren = children.length > 0
  
  const displayStatus = node.metadata.lastStatus || node.status.toUpperCase()
  const statusColor = getStatusColor(displayStatus)
  
  // Check if this is the next job in queue
  const isNextInQueue = node.id === nextJobId
  
  // Check if this is the currently selected job
  const isSelected = node.id === selectedJobId

  const dependencies = node.metadata.dependencies || []
  const hasDependencies = dependencies.length > 0

  // Fetch dependency info when hovering and node has dependencies
  useEffect(() => {
    if (isHoveringDeps && hasDependencies) {
      setLoadingDeps(true)
      getDependencyInfo(dependencies)
        .then(info => setDependencyInfo(info))
        .catch(err => {
          console.error('Failed to fetch dependency info:', err)
          setDependencyInfo([])
        })
        .finally(() => setLoadingDeps(false))
    }
  }, [isHoveringDeps, dependencies, hasDependencies])
  
  return (
    <div>
      <div
        data-job-id={node.id}
        className={`py-2 px-3 rounded transition-colors cursor-pointer ${
          isSelected 
            ? 'bg-muted hover:bg-accent' 
            : 'hover:bg-accent/50'
        }`}
        style={{ paddingLeft: `${depth * 1.5 + 0.75}rem` }}
        onClick={() => onSelectJob(node.id)}
      >
        <div className="flex items-start gap-2">
          {/* Collapse/Expand Button */}
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setIsCollapsed(!isCollapsed)
              }}
              className="mt-0.5 p-0.5 hover:bg-accent rounded transition-colors flex-shrink-0"
              aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            >
              {isCollapsed ? (
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
          ) : (
            <div className="w-5 flex-shrink-0" />
          )}
          
          {/* Job Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="font-medium text-sm hover:text-primary block truncate">
                {node.label || 'Unnamed Job'}
              </div>
              {/* Next in Queue Indicator */}
              {isNextInQueue && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500 dark:bg-blue-600 text-white shadow-sm ring-2 ring-blue-500/50 dark:ring-blue-400/50">
                  <Clock className="w-3.5 h-3.5" />
                  Next
                </span>
              )}
            </div>
            
            {/* Status Badge, Run Count, and Dependencies */}
            <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
              <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${statusColor}`}>
                <StatusIcon status={displayStatus} size={14} />
                {displayStatus}
              </span>
              {node.metadata.runCount !== undefined && node.metadata.runCount > 0 && (
                <>
                  <span>·</span>
                  <span>
                    {node.metadata.runCount} {node.metadata.runCount === 1 ? 'run' : 'runs'}
                  </span>
                </>
              )}
              {hasDependencies && (
                <>
                  <span>·</span>
                  <Popover open={isHoveringDeps} onOpenChange={setIsHoveringDeps}>
                    <PopoverTrigger asChild>
                      <div 
                        className="inline-flex items-center gap-1 cursor-help"
                        onMouseEnter={() => setIsHoveringDeps(true)}
                        onMouseLeave={() => setIsHoveringDeps(false)}
                      >
                        <GitBranch className="w-3.5 h-3.5" />
                        <span className="font-medium">{dependencies.length} {dependencies.length === 1 ? 'dependency' : 'dependencies'}</span>
                      </div>
                    </PopoverTrigger>
                    <PopoverContent 
                      className="w-64 p-3"
                      align="start"
                      onMouseEnter={() => setIsHoveringDeps(true)}
                      onMouseLeave={() => setIsHoveringDeps(false)}
                      onOpenAutoFocus={(e) => e.preventDefault()}
                    >
                      {loadingDeps ? (
                        <div className="text-xs text-muted-foreground">Loading...</div>
                      ) : (
                        <div className="space-y-2">
                          <div className="text-xs font-semibold text-muted-foreground mb-2">
                            Depends on:
                          </div>
                          {dependencyInfo.slice(0, 5).map((dep) => (
                            <Link
                              key={dep.id}
                              href={`/jobDefinitions/${dep.id}`}
                              className="flex items-center gap-2 text-xs py-1 hover:bg-accent rounded px-1 -mx-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <StatusIcon status={dep.status === 'delivered' ? 'COMPLETED' : dep.status === 'in_progress' ? 'PENDING' : 'PENDING'} size={14} />
                              <span className="truncate" title={dep.jobName}>
                                {dep.jobName}
                              </span>
                            </Link>
                          ))}
                          {dependencies.length > 5 && (
                            <div className="text-xs text-muted-foreground italic mt-1">
                              +{dependencies.length - 5} more...
                            </div>
                          )}
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Children */}
      {hasChildren && !isCollapsed && (
        <div>
          {children.map((child) => (
            <TreeNodeItem 
              key={child.node.id} 
              treeNode={child} 
              depth={depth + 1}
              onSelectJob={onSelectJob}
              allNodes={allNodes}
              nextJobId={nextJobId}
              selectedJobId={selectedJobId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function WorkstreamTreeList({
  rootId,
  initialSelectedJobId,
  selectedJobId: selectedJobIdProp,
  onJobSelectRoute
}: WorkstreamTreeListProps) {
  const isMobile = useIsMobile()
  const { graph, loading, error } = useJobGraph({
    rootId,
    rootType: 'request',
    groupByDefinition: true,
  })

  const [selectedJobId, setSelectedJobId] = useState<string | null>(initialSelectedJobId ?? null)
  const [selectedJob, setSelectedJob] = useState<JobDefinition | null>(null)
  const [loadingJob, setLoadingJob] = useState(false)
  const [jobError, setJobError] = useState<string | null>(null)
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const hasAutoSelectedRef = useRef(false)

  // Fetch job definition when a job is selected
  const fetchJob = useCallback(async (jobId: string) => {
    setLoadingJob(true)
    setJobError(null)
    try {
      const job = await getJobDefinition(jobId)
      if (job) {
        setSelectedJob(job as JobDefinition)
      } else {
        setJobError('Job definition not found')
      }
    } catch (err) {
      setJobError(err instanceof Error ? err.message : 'Failed to load job')
    } finally {
      setLoadingJob(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJob(null)
      return
    }
    fetchJob(selectedJobId)
  }, [selectedJobId, fetchJob])

  // Subscribe to realtime updates for job definitions
  useRealtimeData('jobDefinitions', {
    enabled: !!selectedJobId,
    onEvent: () => {
      if (selectedJobId) {
        console.log('[WorkstreamTreeList] Refetching job definition due to SSE update')
        fetchJob(selectedJobId)
      }
    }
  })

  // State to hold the next job's definition ID
  const [nextJobDefinitionId, setNextJobDefinitionId] = useState<string | null>(null)

  useEffect(() => {
    if (initialSelectedJobId) {
      hasAutoSelectedRef.current = true
      setSelectedJobId(initialSelectedJobId)
    }
  }, [initialSelectedJobId])

  useEffect(() => {
    if (selectedJobIdProp !== undefined) {
      hasAutoSelectedRef.current = true
      setSelectedJobId(selectedJobIdProp)
    }
  }, [selectedJobIdProp])

  // Auto-select the first job when tree loads
  const rootNodeId = graph?.rootNode?.id
  useEffect(() => {
    if (!loading && rootNodeId && !hasAutoSelectedRef.current) {
      hasAutoSelectedRef.current = true
      setSelectedJobId(rootNodeId)
    }
  }, [loading, rootNodeId])

  useEffect(() => {
    if (!selectedJobId) return
    const nodeElement = document.querySelector(`[data-job-id="${selectedJobId}"]`)
    if (nodeElement instanceof HTMLElement) {
      nodeElement.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [selectedJobId, graph?.nodes?.length])

  // Calculate which job is next in queue by querying requests directly
  // This matches the worker's logic: oldest undelivered request with met dependencies
  useEffect(() => {
    if (!graph || !graph.rootNode) return

    const findNextJob = async () => {
      try {
        // Query undelivered requests in this workstream, ordered by blockTimestamp (oldest first)
        const requestsResponse = await queryRequests({
          where: {
            workstreamId: rootId,
            delivered: false
          },
          orderBy: 'blockTimestamp',
          orderDirection: 'asc',
          limit: 50
        })

        const requests = requestsResponse.items
        
        // Check dependencies for each request to find the first ready one
        for (const request of requests) {
          // If no dependencies, this job is ready
          if (!request.dependencies || request.dependencies.length === 0) {
            setNextJobDefinitionId(request.jobDefinitionId || null)
            return
          }

          // Check if all dependencies are met (have delivered requests)
          const depChecks = await Promise.all(
            request.dependencies.map(async (depIdentifier) => {
              // Try to find if this dependency has any delivered requests
              const depRequests = await queryRequests({
                where: {
                  workstreamId: rootId,
                  // Try matching by jobDefinitionId or jobName
                  OR: [
                    { jobDefinitionId: depIdentifier },
                    { jobName: depIdentifier }
                  ],
                  delivered: true
                },
                limit: 1
              })
              return depRequests.items.length > 0
            })
          )

          // If all dependencies are met, this is the next job
          if (depChecks.every(met => met)) {
            setNextJobDefinitionId(request.jobDefinitionId || null)
            return
          }
        }

        // No ready jobs found
        setNextJobDefinitionId(null)
      } catch (error) {
        console.error('Error finding next job:', error)
        setNextJobDefinitionId(null)
      }
    }

    findNextJob()
  }, [graph, rootId])

  const handleSelectJob = (jobId: string) => {
    setSelectedJobId(jobId)
    onJobSelectRoute?.(jobId)
    if (isMobile) {
      setMobileSheetOpen(true)
    }
  }

  const handleClosePanel = () => {
    setSelectedJobId(null)
    setSelectedJob(null)
    setMobileSheetOpen(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-2"></div>
          <div className="text-sm text-muted-foreground">Loading jobs...</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <div className="text-destructive text-sm">{error}</div>
      </div>
    )
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        No jobs found
      </div>
    )
  }

  const tree = buildTree(graph.nodes, graph.edges, graph.rootNode)

  // Detail panel content - reused for both mobile sheet and desktop panel
  const DetailPanelContent = () => (
    <>
      {loadingJob ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-2"></div>
            <div className="text-sm text-muted-foreground">Loading job details...</div>
          </div>
        </div>
      ) : jobError ? (
        <div className="text-center py-12">
          <div className="text-red-600 text-sm">{jobError}</div>
        </div>
      ) : selectedJob ? (
        <JobDefinitionDetailLayout record={selectedJob} />
      ) : null}
    </>
  )

  // Mobile layout: Full-width tree with Sheet for details
  if (isMobile) {
    return (
      <>
        <div
          className="force-scrollbar divide-y divide-gray-100 max-h-[600px]"
          style={{
            overflowY: 'scroll',
            paddingLeft: '0.75rem',
            paddingRight: '0.75rem',
            paddingTop: '0.5rem',
            paddingBottom: '0.5rem'
          }}
        >
          <TreeNodeItem
            treeNode={tree}
            depth={0}
            onSelectJob={handleSelectJob}
            allNodes={graph.nodes}
            nextJobId={nextJobDefinitionId}
            selectedJobId={selectedJobId}
          />
        </div>

        {/* Mobile Sheet for Job Details */}
        <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
          <SheetContent side="bottom" className="h-[85vh] overflow-hidden flex flex-col">
            <SheetHeader className="flex-shrink-0 pb-2 border-b">
              <div className="flex items-center justify-between">
                <SheetTitle className="text-base truncate pr-2">
                  {selectedJob?.name || 'Job Details'}
                </SheetTitle>
                {selectedJobId && (
                  <Link
                    href={`/jobDefinitions/${selectedJobId}`}
                    className="text-xs text-primary hover:text-primary flex items-center gap-1 flex-shrink-0"
                  >
                    View Full <ExternalLink className="w-3 h-3" />
                  </Link>
                )}
              </div>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto py-4">
              <DetailPanelContent />
            </div>
          </SheetContent>
        </Sheet>
      </>
    )
  }

  // Desktop layout: Side-by-side panels
  return (
    <div className="grid gap-0 transition-all duration-300 grid-cols-1 md:grid-cols-5">
      {/* Tree List */}
      <div
        className="force-scrollbar divide-y divide-gray-100 max-h-[800px] md:col-span-2"
        style={{
          overflowY: 'scroll',
          paddingLeft: '1.5rem',
          paddingRight: '1.5rem',
          paddingTop: '1rem',
          paddingBottom: '1rem'
        }}
      >
        <TreeNodeItem
          treeNode={tree}
          depth={0}
          onSelectJob={handleSelectJob}
          allNodes={graph.nodes}
          nextJobId={nextJobDefinitionId}
          selectedJobId={selectedJobId}
        />
      </div>

      {/* Detail Panel */}
      <div
        className="force-scrollbar md:col-span-3 border-l max-h-[800px] hidden md:block"
        style={{ overflowY: 'scroll' }}
      >
        {selectedJobId ? (
          <>
            {/* Panel Header */}
            <div className="flex items-center justify-between px-6 py-3 sticky top-0 bg-background border-b z-10">
              <div className="flex items-center gap-3">
                <h3 className="font-semibold text-lg">{selectedJob?.name || 'Job Details'}</h3>
                <Link
                  href={`/jobDefinitions/${selectedJobId}`}
                  className="text-sm text-primary hover:text-primary flex items-center gap-1"
                >
                  View Full <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClosePanel}
                className="h-8 w-8 p-0"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Panel Content */}
            <div className="px-6 py-4">
              <DetailPanelContent />
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-24 px-6">
            <div className="rounded-full bg-muted p-4 mb-4">
              <MousePointerClick className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="font-medium text-lg text-foreground mb-1">No job selected</h3>
            <p className="text-sm text-muted-foreground text-center max-w-[240px]">
              Select a job from the tree to view its details
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
