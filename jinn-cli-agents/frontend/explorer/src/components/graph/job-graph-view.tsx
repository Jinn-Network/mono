'use client'

import { useCallback, useEffect, useState } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  Panel,
  Node,
  ReactFlowProvider,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { JobNode } from './job-node'
import { JobEdge } from './job-edge'
import { GraphControls } from './graph-controls'
import { useJobGraph } from '@/hooks/use-job-graph'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Search, Eye, EyeOff } from 'lucide-react'

const nodeTypes = {
  job: JobNode,
}

const edgeTypes = {
  jobEdge: JobEdge,
}

interface JobGraphViewInnerProps {
  rootId: string
  groupByDefinition?: boolean
}

function JobGraphViewInner({ rootId, groupByDefinition = false }: JobGraphViewInnerProps) {
  const router = useRouter()
  const {
    graph,
    nodes: initialNodes,
    edges: initialEdges,
    loading,
    error,
    depth,
    direction,
    layout,
    updateDepth,
    updateDirection,
    toggleLayout,
  } = useJobGraph({ rootId, groupByDefinition })

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const [showOverlays, setShowOverlays] = useState(false)

  // Update nodes/edges when graph data changes
  useEffect(() => {
    setNodes(initialNodes)
    setEdges(initialEdges)
    // Fit view after layout with a small delay to ensure render
    if (initialNodes.length > 0) {
      setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50)
    }
  }, [initialNodes, initialEdges, setNodes, setEdges, fitView])

  // Navigate to detail page on node click
  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    router.push(`/jobDefinitions/${node.id}`)
  }, [router])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[700px] border rounded-lg bg-muted">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <div className="text-gray-400">Loading graph...</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[700px] border rounded-lg bg-red-500/10">
        <div className="text-center text-red-700 dark:text-red-400 p-8">
          <AlertTriangle className="w-12 h-12 mx-auto mb-4" />
          <div className="font-semibold text-lg">Error loading graph</div>
          <div className="text-sm mt-2">{error}</div>
        </div>
      </div>
    )
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-[700px] border rounded-lg bg-muted">
        <div className="text-center text-gray-400 p-8">
          <Search className="w-12 h-12 mx-auto mb-4" />
          <div className="font-semibold text-lg">No relationships found</div>
          <div className="text-sm mt-2">
            This job has no connected nodes.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full h-full bg-muted relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{ type: 'jobEdge' }}
        proOptions={{ hideAttribution: true }}
      >
        {showOverlays && (
          <>
            <Background />
            <Controls />
            <MiniMap
              nodeColor={() => '#10b981'}
              className="bg-card border shadow-md"
            />

            {/* Statistics Panel */}
            <Panel position="top-left" className="bg-card p-4 rounded-lg shadow-md">
              <h3 className="font-semibold text-sm mb-2">Graph Statistics</h3>
              <div className="text-xs text-gray-400 space-y-1">
                <div className="flex justify-between gap-4">
                  <span>Jobs:</span>
                  <span className="font-semibold">{graph?.stats.totalNodes || 0}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Connections:</span>
                  <span className="font-semibold">{graph?.stats.totalEdges || 0}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Max Depth:</span>
                  <span className="font-semibold">{graph?.stats.maxDepth || 0}</span>
                </div>
              </div>
            </Panel>

            {/* Graph Controls */}
            <GraphControls
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onFitView={() => fitView({ padding: 0.2, duration: 300 })}
              onToggleLayout={toggleLayout}
              layout={layout}
              currentDepth={depth}
              onDepthChange={updateDepth}
              direction={direction}
              onDirectionChange={updateDirection}
            />
          </>
        )}

        {/* Toggle button for overlays - always visible */}
        <Panel position="top-right" className="z-50">
          <button
            onClick={() => setShowOverlays(!showOverlays)}
            className="p-2 bg-card hover:bg-muted rounded-lg transition-colors shadow-md border border"
            title={showOverlays ? 'Hide overlays' : 'Show overlays'}
            aria-label={showOverlays ? 'Hide overlays' : 'Show overlays'}
          >
            {showOverlays ? (
              <EyeOff className="w-5 h-5 text-gray-400" />
            ) : (
              <Eye className="w-5 h-5 text-gray-400" />
            )}
          </button>
        </Panel>

        {/* SVG marker definitions for arrow heads */}
        <svg style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0 }}>
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="10"
              refX="9"
              refY="3"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L0,6 L9,3 z" fill="#666" />
            </marker>
          </defs>
        </svg>
      </ReactFlow>
    </div>
  )
}

// Wrapper component that provides ReactFlow context
export function JobGraphView(props: JobGraphViewInnerProps) {
  return (
    <ReactFlowProvider>
      <JobGraphViewInner {...props} />
    </ReactFlowProvider>
  )
}
