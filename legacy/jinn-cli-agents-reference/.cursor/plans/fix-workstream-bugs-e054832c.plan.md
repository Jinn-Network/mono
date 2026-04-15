---
name: Fix Workstream ID and Parent Dispatch Bugs
overview: ""
todos: []
---

# Fix Workstream ID and Parent Dispatch Bugs

## Implementation Steps

### 1. Add Frontend workstreamId Display

**File**: `frontend/explorer/src/lib/subgraph.ts`

Add `workstreamId` to GraphQL queries:

- Line 238: Add `workstreamId` to `queryRequests` items list
- Line 431: Add `workstreamId` to `getRequest` fields list

### 2. Preserve Workstream ID in Parent Re-dispatch

**File**: `worker/status/parentDispatch.ts`

In `dispatchParentIfNeeded` function (after line 58):

- Query Ponder for child request's `workstreamId`
- Pass `workstreamId` as parameter to `dispatchExistingJob` call (line 96-99)

**File**: `gemini-agent/mcp/tools/dispatch_existing_job.ts`

- Add `workstreamId` optional parameter to `dispatchExistingJobParamsBase` schema (line 11)
- Include in IPFS metadata at root level (line 186-193, alongside `blueprint`, `jobName`, `enabledTools`, `jobDefinitionId`)

**File**: `ponder/src/index.ts`

In workstream calculation logic (lines 360-371):

- Check for explicit `workstreamId` in metadata first
- If present, use it directly
- Fall back to current traversal logic if not present

### 3. Investigate Multiple Parent Dispatches

**File**: `worker/status/parentDispatch.ts`

Add deduplication tracking:

- Create in-memory map tracking recent parent dispatches: `{ parentJobDefId: { lastDispatchTime, childRequestIds: Set } }`
- Before dispatching, check if this parent was already dispatched for this specific child request
- Skip if duplicate detected within cooldown period (e.g., 30 seconds)
- Log dispatch decisions with child request ID and reason

Add detailed logging at line 71:

- Log child request ID, parent job def ID, workstream ID
- Log all undelivered children for this parent
- Log reason for dispatch (first child complete, all children complete, etc.)

### 4. Document Parent Dispatch Conditions

**File**: `docs/spec/documentation/protocol-model.md`

Add new section under "2.2 processOnce() Function Flow" or update existing "2.3 Job Hierarchy":

```markdown
### Parent Re-dispatch Rules

**Trigger Condition:**
- Child job reaches terminal state (COMPLETED or FAILED)
- Parent job definition ID exists in child's metadata (sourceJobDefinitionId)

**Workstream Preservation:**
- Parent re-dispatch inherits child's workstreamId
- All jobs in delegation chain share same workstream root
- Ponder prioritizes explicit workstreamId in metadata over traversal

**Deduplication:**
- Parent is dispatched once per child completion
- Guard prevents duplicate dispatches from same child within 30-second window
- Multiple children completing trigger multiple parent dispatches (expected behavior)
```

### 5. Add Workstream Inspection Script

**File**: `scripts/inspect-workstream.ts` (new file)

Create script that:

- Accepts workstream ID as argument
- Queries all requests with that workstream ID
- Displays hierarchy tree with workstream IDs
- Shows which requests have mismatched workstream IDs
- Outputs validation errors

### 6. Validation Testing

After implementation:

1. Run existing requests through inspection script to identify broken workstreams
2. Create test workstream: root → parent → child
3. Trigger child completion, verify parent preserves workstream
4. Verify only 1 parent dispatch per child completion
5. Check frontend displays workstream ID in request detail view

## Files to Modify

- `frontend/explorer/src/lib/subgraph.ts`
- `worker/status/parentDispatch.ts`
- `gemini-agent/mcp/tools/dispatch_existing_job.ts`
- `ponder/src/index.ts`
- `docs/spec/documentation/protocol-model.md`
- `scripts/inspect-workstream.ts` (new)