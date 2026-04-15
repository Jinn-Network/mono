---
name: Refactor to Ponder Native SSE using client.live()
overview: ""
todos:
  - id: 655ab880-b5b6-464d-a176-ecb81b653ce0
    content: Create ponder/src/api/index.ts with SQL client middleware
    status: pending
  - id: 3cae4aa4-9a07-4d59-ad11-91eee16b2b4e
    content: Add @ponder/client to frontend/explorer dependencies
    status: pending
  - id: 6930d003-dda8-44a6-9bc7-d286c3e529e5
    content: Create frontend/explorer/src/lib/ponder-client.ts
    status: pending
  - id: 775b093e-0bb1-497b-a725-c140e6cd4e4b
    content: Refactor use-realtime-data.ts to use client.live()
    status: pending
  - id: 16785565-a2e9-45db-acd7-4b937ce885aa
    content: Update use-subgraph-collection.ts to use refactored hook
    status: pending
  - id: 9cfb98d6-a1b9-4683-95b8-32495e11bd1c
    content: Update use-job-graph.ts to use refactored hook
    status: pending
  - id: cb87e242-c6c3-4035-b657-be488a07fd2f
    content: Update job-detail-layout.tsx to use refactored hook
    status: pending
  - id: 55ca2e9f-04ca-4720-9cf5-a9a7c0d100d5
    content: Delete realtime-server.ts, start-combined.sh, and related files
    status: pending
  - id: ab80d269-1eb8-43fe-8058-290e9975ebd2
    content: Remove NEXT_PUBLIC_REALTIME_URL references
    status: pending
  - id: adaea670-9db3-48c6-b918-bbddaeeb5fdf
    content: Revert Railway start command to standard ponder start
    status: pending
  - id: 3554417b-6dd5-4c35-a268-120fc56591b7
    content: Test client.live() subscriptions work locally and on Railway
    status: pending
---

# Refactor to Ponder Native SSE using client.live()

## Overview

Replace the custom realtime server with Ponder's native `client.live()` API, which provides built-in SSE support. The implementation will use Ponder's SQL over HTTP endpoint (`/sql/*`) which already runs on the same port as GraphQL (42069).

## Key Changes

### 1. Enable Ponder SQL Client Middleware

**File:** `ponder/src/api/index.ts` (create if doesn't exist)

Add the Hono middleware to enable the `/sql/*` endpoint:

```typescript
import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client } from "ponder";

const app = new Hono();

// Enable SQL over HTTP (includes SSE support for client.live())
app.use("/sql/*", client({ db, schema }));

export default app;
```

### 2. Install @ponder/client in Frontend

**File:** `frontend/explorer/package.json`

Add `@ponder/client` dependency:

```bash
yarn add @ponder/client
```

### 3. Create Ponder Client Instance

**File:** `frontend/explorer/src/lib/ponder-client.ts` (new)

```typescript
import { createClient } from "@ponder/client";
import * as schema from "../../../ponder/ponder.schema";

const PONDER_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL?.replace('/graphql', '/sql') 
  || 'http://localhost:42069/sql';

export const ponderClient = createClient(PONDER_URL, { schema });
export { schema };
```

### 4. Refactor useRealtimeData Hook

**File:** `frontend/explorer/src/hooks/use-realtime-data.ts`

Replace the custom EventSource implementation with `ponderClient.live()`:

```typescript
'use client'

import { useEffect, useCallback, useState } from 'react'
import { ponderClient, schema } from '@/lib/ponder-client'

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

export function useRealtimeData(
  collectionName?: string,
  options: UseRealtimeDataOptions = {}
): UseRealtimeDataReturn {
  const { enabled = true, onEvent, onError } = options
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')

  useEffect(() => {
    if (!enabled) return

    setStatus('connecting')

    // Subscribe to all relevant tables using client.live()
    const unsubscribers: Array<() => void> = []

    try {
      // Subscribe to requests table
      const { unsubscribe: unsubRequests } = ponderClient.live(
        (db) => db.select().from(schema.request),
        () => {
          setStatus('connected')
          if (collectionName === 'requests' || !collectionName) {
            onEvent?.()
          }
        },
        (error) => {
          console.error('[useRealtimeData] Error in requests subscription:', error)
          setStatus('error')
          onError?.(error)
        }
      )
      unsubscribers.push(unsubRequests)

      // Subscribe to artifacts table
      const { unsubscribe: unsubArtifacts } = ponderClient.live(
        (db) => db.select().from(schema.artifact),
        () => {
          setStatus('connected')
          if (collectionName === 'artifacts' || !collectionName) {
            onEvent?.()
          }
        },
        (error) => {
          console.error('[useRealtimeData] Error in artifacts subscription:', error)
          setStatus('error')
          onError?.(error)
        }
      )
      unsubscribers.push(unsubArtifacts)

      // Subscribe to deliveries table
      const { unsubscribe: unsubDeliveries } = ponderClient.live(
        (db) => db.select().from(schema.delivery),
        () => {
          setStatus('connected')
          if (collectionName === 'deliveries' || !collectionName) {
            onEvent?.()
          }
        },
        (error) => {
          console.error('[useRealtimeData] Error in deliveries subscription:', error)
          setStatus('error')
          onError?.(error)
        }
      )
      unsubscribers.push(unsubDeliveries)

      // Subscribe to job definitions table
      const { unsubscribe: unsubJobDefs } = ponderClient.live(
        (db) => db.select().from(schema.jobDefinition),
        () => {
          setStatus('connected')
          if (collectionName === 'jobDefinitions' || !collectionName) {
            onEvent?.()
          }
        },
        (error) => {
          console.error('[useRealtimeData] Error in job definitions subscription:', error)
          setStatus('error')
          onError?.(error)
        }
      )
      unsubscribers.push(unsubJobDefs)

      // Subscribe to messages table
      const { unsubscribe: unsubMessages } = ponderClient.live(
        (db) => db.select().from(schema.message),
        () => {
          setStatus('connected')
          if (collectionName === 'messages' || !collectionName) {
            onEvent?.()
          }
        },
        (error) => {
          console.error('[useRealtimeData] Error in messages subscription:', error)
          setStatus('error')
          onError?.(error)
        }
      )
      unsubscribers.push(unsubMessages)

    } catch (error) {
      console.error('[useRealtimeData] Error setting up subscriptions:', error)
      setStatus('error')
      onError?.(error as Error)
    }

    return () => {
      unsubscribers.forEach(unsubscribe => unsubscribe())
      setStatus('disconnected')
    }
  }, [enabled, collectionName, onEvent, onError])

  return {
    status,
    isConnected: status === 'connected'
  }
}
```

### 5. Update useSubgraphCollection Hook

**File:** `frontend/explorer/src/hooks/use-subgraph-collection.ts`

Update to use the refactored `useRealtimeData`:

```typescript
// Existing code...

const { isConnected: isRealtimeConnected } = useRealtimeData(
  collectionName,
  {
    enabled: true,
    onEvent: () => {
      console.log(`[useSubgraphCollection] Real-time update for ${collectionName}`)
      fetchRecords(currentPage, false) // Silent refresh
    }
  }
)

// Modified polling logic: only poll if not connected via SSE
useEffect(() => {
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

  pollingIntervalRef.current = setInterval(() => {
    console.log(`[useSubgraphCollection] Polling for ${collectionName} updates (SSE fallback)`)
    fetchRecords(currentPage, false)
  }, pollingInterval)

  return () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
    }
  }
}, [enablePolling, pollingInterval, currentPage, fetchRecords, collectionName, isRealtimeConnected])
```

### 6. Update useJobGraph Hook

**File:** `frontend/explorer/src/hooks/use-job-graph.ts`

Similar update to use `useRealtimeData` without collection-specific filtering (responds to all changes):

```typescript
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

// Update polling logic similar to useSubgraphCollection
```

### 7. Update JobDetailLayout Component

**File:** `frontend/explorer/src/components/job-phases/job-detail-layout.tsx`

Replace individual `useEffect` polling with `useRealtimeData`:

```typescript
const { isConnected: isRealtimeConnected } = useRealtimeData(
  undefined,
  {
    enabled: true,
    onEvent: () => {
      console.log('[JobDetailLayout] Real-time update detected')
      fetchDelivery()
      fetchMemoryData()
      fetchArtifacts()
      fetchWorkerTelemetry()
      fetchChildren()
      checkParentDispatch()
    }
  }
)
```

### 8. Remove Custom Realtime Server Files

Delete these files as they're no longer needed:

- `ponder/realtime-server.ts`
- `ponder/start-combined.sh`
- `ponder/migrations/add_realtime_triggers.sql`
- `ponder/railway.json` (or revert to original if it existed)
- `ponder/README-REALTIME.md`

### 9. Update Environment Variables

Remove `NEXT_PUBLIC_REALTIME_URL` references, as the SSE endpoint is now at the same base URL as GraphQL:

- The client automatically uses `NEXT_PUBLIC_SUBGRAPH_URL` with `/sql` path instead of `/graphql`

### 10. Update Railway Configuration

**Railway Service Settings** (via web UI):

Revert the start command back to:

```bash
cd ponder && yarn ponder start --port $PORT
```

No need for `start-combined.sh` anymore.

### 11. Update Package Dependencies

**File:** `package.json` (root)

Remove dependencies that were only needed for custom server:

- Remove `express` and `cors` if not used elsewhere
- Keep `@types/express` and `@types/cors` removal

## Testing Checklist

1. Verify `/sql` endpoint is accessible at `http://localhost:42069/sql` (or Railway URL)
2. Test `client.live()` subscriptions trigger on new blocks
3. Verify polling fallback works when SSE disconnects
4. Test all collection views update in real-time
5. Test job detail views update in real-time
6. Test job graph updates in real-time
7. Verify RealtimeStatusIndicator shows correct connection status

## Deployment Notes

- The Ponder service only needs to run `yarn ponder start` (no additional realtime server)
- Frontend automatically connects to `/sql` endpoint for SSE
- No additional Railway services or ports needed
- PostgreSQL triggers are not required