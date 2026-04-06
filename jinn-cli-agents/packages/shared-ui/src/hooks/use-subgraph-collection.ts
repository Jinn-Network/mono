'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { CollectionName } from '../lib/types'
import {
  queryJobDefinitions,
  queryRequests,
  queryDeliveries,
  queryArtifacts,
  queryMessages,
  JobDefinition,
  Request,
  Delivery,
  Artifact,
  Message,
  QueryOptions
} from '../lib/subgraph'
import { useRealtimeData, type ConnectionStatus } from './use-realtime-data'

export type SubgraphRecord = JobDefinition | Request | Delivery | Artifact | Message

interface UseSubgraphCollectionOptions {
  collectionName: CollectionName
  pageSize?: number
  enablePolling?: boolean
  pollingInterval?: number
  sortColumn?: string
  sortAscending?: boolean
  whereFilter?: Record<string, unknown>
  onError?: (error: string) => void
}

interface UseSubgraphCollectionReturn {
  records: SubgraphRecord[]
  loading: boolean
  totalRecords: number
  currentPage: number
  setCurrentPage: (page: number) => void
  error: string | null
  hasNextPage: boolean
  hasPreviousPage: boolean
  setSorting: (column: string, ascending: boolean) => void
  sortColumn: string
  sortAscending: boolean
  realtimeStatus: ConnectionStatus
}

export function useSubgraphCollection({
  collectionName,
  pageSize = 100,
  enablePolling = true,
  pollingInterval = 10000,
  sortColumn,
  sortAscending = false,
  whereFilter,
  onError,
}: UseSubgraphCollectionOptions): UseSubgraphCollectionReturn {
  const [records, setRecords] = useState<SubgraphRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalRecords, setTotalRecords] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [hasPreviousPage, setHasPreviousPage] = useState(false)
  const [currentSortColumn, setCurrentSortColumn] = useState<string>(sortColumn || '')
  const [currentSortAscending, setCurrentSortAscending] = useState<boolean>(sortAscending)
  const [realtimeStatus, setRealtimeStatus] = useState<ConnectionStatus>('disconnected')

  // Refs to allow callbacks to access latest values without re-creating
  const fetchRecordsRef = useRef<((page: number, showLoading?: boolean) => Promise<void>) | null>(null)
  const currentPageRef = useRef(1)

  // Track cursors for each page
  const cursorsRef = useRef<Map<number, { after?: string; before?: string }>>(new Map())
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const realtimeDebounceRef = useRef<NodeJS.Timeout | null>(null)
  const pendingRefetchRef = useRef(false)

  // Debounced callback to trigger refresh when SSE event arrives
  const handleRealtimeEvent = useCallback(() => {
    // Mark that we have a pending refetch
    pendingRefetchRef.current = true

    // Clear any existing debounce timer
    if (realtimeDebounceRef.current) {
      clearTimeout(realtimeDebounceRef.current)
    }

    // Debounce SSE events - wait 500ms before actually triggering a refetch
    realtimeDebounceRef.current = setTimeout(() => {
      if (pendingRefetchRef.current) {
        console.log(`[useSubgraphCollection] Real-time update for ${collectionName}`)
        pendingRefetchRef.current = false
        // Trigger refetch directly instead of using state
        fetchRecordsRef.current?.(currentPageRef.current, false)
      }
    }, 500)
  }, [collectionName])

  // Use Ponder native SSE via client.live() - MUST be initialized early
  const { isConnected: isRealtimeConnected, status: rtStatus } = useRealtimeData(
    collectionName,
    {
      enabled: true,
      onEvent: handleRealtimeEvent,
      onError: (error) => {
        console.error('[useSubgraphCollection] Real-time connection error:', error)
      }
    }
  )

  // Update realtime status
  useEffect(() => {
    setRealtimeStatus(rtStatus)
  }, [rtStatus])

  // Get the appropriate query function for the collection
  const getQueryFunction = useCallback(() => {
    switch (collectionName) {
      case 'jobDefinitions':
        return queryJobDefinitions
      case 'requests':
        return queryRequests
      case 'deliveries':
        return queryDeliveries
      case 'artifacts':
        return queryArtifacts
      case 'messages':
        return queryMessages
      default:
        throw new Error(`Unknown collection: ${collectionName}`)
    }
  }, [collectionName])

  // Get default sort column for collection
  const getDefaultSortColumn = useCallback(() => {
    if (currentSortColumn) return currentSortColumn
    if (sortColumn) return sortColumn

    switch (collectionName) {
      case 'jobDefinitions':
        return 'lastInteraction'
      case 'requests':
      case 'deliveries':
      case 'messages':
        return 'blockTimestamp'
      case 'artifacts':
        return 'requestId'
      default:
        return 'id'
    }
  }, [collectionName, sortColumn, currentSortColumn])

  // Fetch records with pagination
  const fetchRecords = useCallback(async (page: number, showLoading = true) => {
    if (showLoading) setLoading(true)
    setError(null)

    try {
      const queryFn = getQueryFunction()

      // Get cursor for this page
      const pageCursor = cursorsRef.current.get(page)

      const options: QueryOptions = {
        limit: pageSize,
        orderBy: getDefaultSortColumn(),
        orderDirection: currentSortAscending ? 'asc' : 'desc',
        where: whereFilter,
        after: pageCursor?.after,
        before: pageCursor?.before,
      }

      const response = await queryFn(options)

      setRecords(response.items)
      setHasNextPage(response.pageInfo.hasNextPage)
      setHasPreviousPage(response.pageInfo.hasPreviousPage)

      // Store cursor for next page
      if (response.pageInfo.hasNextPage && response.pageInfo.endCursor) {
        cursorsRef.current.set(page + 1, { after: response.pageInfo.endCursor })
      }

      // Calculate minimum known total: current page's last record position
      // If there's a next page, add 1 to show there are more
      const currentEnd = (page - 1) * pageSize + response.items.length
      setTotalRecords(response.pageInfo.hasNextPage ? currentEnd + 1 : currentEnd)
    } catch (fetchError) {
      console.error(`Error fetching ${collectionName} records:`, fetchError)
      const errorMessage = fetchError instanceof Error ? fetchError.message : 'Failed to fetch records'
      setError(errorMessage)
      onError?.(errorMessage)
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [collectionName, pageSize, getQueryFunction, getDefaultSortColumn, currentSortAscending, whereFilter, onError])

  // Keep refs up to date
  useEffect(() => {
    fetchRecordsRef.current = fetchRecords
  }, [fetchRecords])

  useEffect(() => {
    currentPageRef.current = currentPage
  }, [currentPage])

  // Set up polling only as fallback when SSE is not connected
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
    if (!enablePolling) {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
      return
    }

    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
    }

    pollingIntervalRef.current = setInterval(() => {
      console.log(`[useSubgraphCollection] Polling for ${collectionName} updates (SSE fallback)`)
      fetchRecordsRef.current?.(currentPageRef.current, false)
    }, pollingInterval)

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
    }
  }, [enablePolling, pollingInterval, collectionName, isRealtimeConnected])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (realtimeDebounceRef.current) {
        clearTimeout(realtimeDebounceRef.current)
      }
    }
  }, [])

  // Function to update sorting
  const setSorting = useCallback((column: string, ascending: boolean) => {
    setCurrentSortColumn(column)
    setCurrentSortAscending(ascending)
    setCurrentPage(1) // Reset to first page when sorting changes
    cursorsRef.current.clear() // Clear cursor cache
  }, [])

  // Initial load and refetch when filter changes
  useEffect(() => {
    fetchRecordsRef.current?.(currentPageRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whereFilter]) // Refetch when filter changes

  // Update when page changes
  useEffect(() => {
    if (currentPage !== 1) {
      fetchRecordsRef.current?.(currentPage)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage])

  // Refetch when sorting changes
  useEffect(() => {
    fetchRecordsRef.current?.(1)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSortColumn, currentSortAscending])

  return {
    records,
    loading,
    totalRecords,
    currentPage,
    setCurrentPage,
    error,
    hasNextPage,
    hasPreviousPage,
    setSorting,
    sortColumn: currentSortColumn,
    sortAscending: currentSortAscending,
    realtimeStatus
  }
}
