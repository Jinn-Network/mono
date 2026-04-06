'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { buildJobGraph, JobGraph, GraphQueryOptions } from '@/lib/graph-queries'
import { Node, Edge } from 'reactflow'
import { layoutGraph } from '@/lib/graph-layout'
import { toast } from 'sonner'
import { useRealtimeData } from './use-realtime-data'

interface UseJobGraphOptions {
  rootId: string
  rootType?: 'jobDefinition' | 'request'
  initialDepth?: number
  initialDirection?: 'upstream' | 'downstream' | 'both'
  groupByDefinition?: boolean
}

export function useJobGraph({
  rootId,
  rootType = 'request',
  initialDepth = 3,
  initialDirection = 'both',
  groupByDefinition = false,
}: UseJobGraphOptions) {
  const [graph, setGraph] = useState<JobGraph | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [depth, setDepth] = useState(initialDepth)
  const [direction, setDirection] = useState(initialDirection)
  const [layout, setLayout] = useState<'TB' | 'LR'>('LR')
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const graphRef = useRef<JobGraph | null>(null)

  // Update ref whenever graph changes
  useEffect(() => {
    graphRef.current = graph
  }, [graph])

  const fetchGraph = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }

    try {
      const options: GraphQueryOptions = {
        rootId,
        rootType,
        maxDepth: depth,
        direction,
        groupByDefinition,
      }

      const graphData = await buildJobGraph(options)
      
      // Note: groupByDefinition is handled natively by buildJobGraph now
      
      // Only update if data actually changed (compare structure)
      const currentGraph = graphRef.current
      const hasChanges = !currentGraph || 
        currentGraph.nodes.length !== graphData.nodes.length ||
        currentGraph.edges.length !== graphData.edges.length ||
        JSON.stringify(currentGraph.nodes) !== JSON.stringify(graphData.nodes)
      
      if (!hasChanges && silent) {
        // No changes detected during silent polling, skip update
        return
      }

      setGraph(graphData)

      // Layout the graph
      const { nodes: layoutedNodes, edges: layoutedEdges } = layoutGraph(
        graphData.nodes,
        graphData.edges,
        {
          direction: layout,
          nodeWidth: 250,
          nodeHeight: 80,
          horizontalSpacing: 100,
          verticalSpacing: 80,
        }
      )

      setNodes(layoutedNodes)
      setEdges(layoutedEdges)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load graph'
      if (!silent) {
        setError(message)
        toast.error(message)
      }
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }, [rootId, rootType, depth, direction, layout, groupByDefinition])

  useEffect(() => {
    fetchGraph()
  }, [fetchGraph])

  // Use Ponder native SSE via client.live()
  const { isConnected: isRealtimeConnected } = useRealtimeData(
    undefined, // Listen to all tables
    {
      enabled: true,
      onEvent: () => {
        console.log('[useJobGraph] Real-time update detected, refetching graph')
        fetchGraph(true) // Silent refresh
      }
    }
  )

  // Polling only as fallback when SSE is not connected
  useEffect(() => {
    // If realtime is connected, disable polling
    if (isRealtimeConnected) {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
      return
    }
    
    // Fallback to polling if SSE is not connected
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
    }
    
    pollingIntervalRef.current = setInterval(() => {
      console.log('[useJobGraph] Polling for updates (SSE fallback)')
      fetchGraph(true) // Silent poll
    }, 30000) // Poll every 30 seconds
    
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
    }
  }, [fetchGraph, isRealtimeConnected])

  const updateDepth = useCallback((newDepth: number) => {
    setDepth(newDepth)
  }, [])

  const updateDirection = useCallback((newDirection: typeof direction) => {
    setDirection(newDirection)
  }, [])

  const toggleLayout = useCallback(() => {
    setLayout(prev => prev === 'TB' ? 'LR' : 'TB')
  }, [])

  return {
    graph,
    nodes,
    edges,
    loading,
    error,
    depth,
    direction,
    layout,
    updateDepth,
    updateDirection,
    toggleLayout,
  }
}
