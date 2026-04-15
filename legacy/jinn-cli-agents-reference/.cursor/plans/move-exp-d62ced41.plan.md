---
name: Move Request Expiration Logic to Client-Side
overview: ""
todos: []
---

# Move Request Expiration Logic to Client-Side

## Problem

Ponder indexes historical blockchain data once, but the `expired` field is time-dependent (`blockTimestamp + 300s < now()`). Computing it during indexing doesn't make sense because the value changes over time. The expiration logic should be computed client-side at query time.

## Changes Required

### 1. Ponder Schema Changes

**File**: `ponder/ponder.schema.ts`

Remove the `expired` field from the `request` table schema:

- Line 42: Delete `expired: p.boolean().optional(),` and its comment

### 2. Ponder Indexer Changes

**File**: `ponder/src/index.ts`

Remove all expiration computation logic:

- Lines 74-81: Delete `isRequestExpired()` helper function
- Line 265: Remove `expired: isRequestExpired(blockTimestamp)` from request pre-seed
- Line 435: Remove `expired: isRequestExpired(blockTimestamp)` from request create
- Line 452: Remove `expired: isRequestExpired(blockTimestamp)` from request update
- Lines 605, 611: Remove `expired: false` from delivery updates

### 3. Frontend - Add Client-Side Expiration Helper

**File**: `frontend/explorer/src/lib/subgraph.ts`

Keep the `expired?: boolean` field in the `Request` interface for backward compatibility, but add a helper function to compute expiration client-side:

```typescript
// Constants
const MARKETPLACE_TIMEOUT_SECONDS = 300; // 5 minutes

// Helper function to determine if a request is expired
export function isRequestExpired(request: Request): boolean {
  if (request.delivered) return false;
  const blockTime = parseInt(request.blockTimestamp);
  const expirationTime = blockTime + MARKETPLACE_TIMEOUT_SECONDS;
  const currentTime = Math.floor(Date.now() / 1000);
  return currentTime > expirationTime;
}
```

### 4. Frontend - Update Status Display Components

Update all components that check `request.expired` to use the helper function instead:

**File**: `frontend/explorer/src/components/record-list.tsx`

- Replace `const expired = 'expired' in record ? record.expired : false` with `const expired = 'blockTimestamp' in record ? isRequestExpired(record as Request) : false`

**File**: `frontend/explorer/src/components/requests-table.tsx`

- Replace `const expired = 'expired' in record ? record.expired : false` with `const expired = 'blockTimestamp' in record ? isRequestExpired(record as Request) : false`

**File**: `frontend/explorer/src/components/job-phases/metadata-sidebar.tsx`

- Add import for `isRequestExpired`
- Replace `expired` prop usage with `isRequestExpired({ blockTimestamp, delivered } as Request)`

**File**: `frontend/explorer/src/components/job-phases/job-detail-layout.tsx`

- Add import for `isRequestExpired`
- Replace `record.expired` checks with `isRequestExpired(record)`

**File**: `frontend/explorer/src/components/dependencies-section.tsx`

- Add import for `isRequestExpired`
- Replace `(dep as any).expired` with `isRequestExpired(dep as Request)`

### 5. Frontend - Remove expired from GraphQL Queries

**File**: `frontend/explorer/src/lib/subgraph.ts`

Remove `expired` from GraphQL query fields:

- Line in `queryRequests` query: Remove `expired` from the fields list
- Line in `getRequest` query: Remove `expired` from the fields list

### 6. Worker - Already Correct

The worker in `worker/mech_worker.ts` already:

- Fetches `blockTimestamp` from Ponder
- Computes staleness client-side using `age = now - blockTimestamp`
- Compares against `STALE_THRESHOLD_SECONDS` (240s)
- Does NOT rely on any `expired` field

No worker changes needed.

### 7. Update Documentation

**File**: `AGENT_README.md`

Update the EXPIRED Status section to clarify that expiration is computed client-side:

- Change "Added virtual expired field to Ponder request table" to "Expiration status is computed client-side based on blockTimestamp + 300s"
- Note that Ponder only stores blockTimestamp, clients compute expiration dynamically

## Testing

After changes:

1. Restart Ponder (schema change requires reindex)
2. Verify frontend still displays EXPIRED status correctly for old requests
3. Verify worker continues to skip stale requests based on blockTimestamp
4. Check that status updates in real-time as requests age past 300s