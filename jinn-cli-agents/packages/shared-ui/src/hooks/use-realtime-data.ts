'use client'

import { useEffect, useState, useRef } from 'react'
import { ponderClient } from '../lib/ponder-client'
import * as schema from '../lib/schema'

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

export interface UseRealtimeDataOptions {
  enabled?: boolean
  onEvent?: () => void
  onError?: (error: Error) => void
}

export interface UseRealtimeDataReturn {
  status: ConnectionStatus
  isConnected: boolean
}

/**
 * Hook to subscribe to Ponder table changes using client.live()
 *
 * Ponder's createClient multiplexes all live queries over a SINGLE SSE connection,
 * so multiple subscriptions don't create multiple connections.
 *
 * This hook subscribes ONLY to the specific table needed by the component.
 *
 * @param collectionName - Collection name to subscribe to ('requests', 'artifacts', etc.)
 * @param options - Configuration options
 */
export function useRealtimeData(
  collectionName?: string,
  options: UseRealtimeDataOptions = {}
): UseRealtimeDataReturn {
  const { enabled = true, onEvent, onError } = options
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')

  // Use refs for callbacks to avoid re-subscribing on every render
  const onEventRef = useRef(onEvent)
  const onErrorRef = useRef(onError)

  // Keep refs up to date
  useEffect(() => {
    onEventRef.current = onEvent
    onErrorRef.current = onError
  })

  useEffect(() => {
    if (!enabled) {
      setStatus('disconnected')
      return
    }

    // Map collection name to table schema
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tableSchemaMap: Record<string, any> = {
      'jobDefinitions': schema.jobDefinition,
      'requests': schema.request,
      'deliveries': schema.delivery,
      'artifacts': schema.artifact,
      'messages': schema.message,
      'workstreams': schema.workstream,
      'templates': schema.jobTemplate
    }

    // If no collection specified, subscribe to all tables
    const tablesToSubscribe = collectionName
      ? [tableSchemaMap[collectionName]]
      : Object.values(tableSchemaMap)

    // Check if all tables are valid
    if (tablesToSubscribe.some(t => !t)) {
      console.error(`[useRealtimeData] Unknown collection: ${collectionName}`)
      setStatus('error')
      return
    }

    setStatus('connecting')

    try {
      // Subscribe to table(s) changes using Drizzle query builder
      // Ponder client multiplexes all queries over a single SSE connection
      let hasConnected = false

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsubscribers = tablesToSubscribe.map((table: any) => {
        const { unsubscribe } = ponderClient.live(
          (db) => db.select().from(table).limit(1),
          () => {
            // Only update status on first successful event
            if (!hasConnected) {
              hasConnected = true
              setStatus('connected')
            }
            // Fire callback without causing re-render
            onEventRef.current?.()
          },
          (error) => {
            console.error(`[useRealtimeData] Error in ${collectionName || 'all tables'} subscription:`, error)
            setStatus('error')
            onErrorRef.current?.(error)
          }
        )
        return unsubscribe
      })

      return () => {
        unsubscribers.forEach(unsub => unsub())
        setStatus('disconnected')
      }
    } catch (error) {
      console.error('[useRealtimeData] Error setting up subscription:', error)
      setStatus('error')
      onError?.(error as Error)
    }
  }, [enabled, collectionName])

  return {
    status,
    isConnected: status === 'connected'
  }
}
