---
title: Workstream Model
purpose: context
scope: [worker]
last_verified: 2026-01-30
related_code:
  - worker/orchestration/jobRunner.ts
  - gemini-agent/mcp/tools/dispatch_new_job.ts
  - ponder/ponder.schema.ts
  - ponder/src/index.ts
  - gemini-agent/shared/ipfs-payload-builder.ts
  - gemini-agent/mcp/tools/shared/context.ts
  - worker/metadata/jobContext.ts
keywords: [workstream, workstreamId, job tree, root job, request ID]
when_to_read: "Use when understanding how jobs are grouped, debugging workstream relationships, or implementing workstream queries"
---

# Workstream Model

A **workstream** groups related jobs into a single execution tree. The `workstreamId` is always the request ID of the root job that started the tree.

## Schema Fields

```
workstream table (ponder.schema.ts:140-160):
  id              text PRIMARY KEY  -- Same as root request ID
  rootRequestId   text NOT NULL
  jobName         text
  mech            hex NOT NULL
  sender          hex NOT NULL
  blockTimestamp  bigint NOT NULL
  lastActivity    bigint NOT NULL
  childRequestCount integer NOT NULL
  delivered       boolean NOT NULL

request table:
  workstreamId    text  -- Points to root request ID

job_definition table:
  workstreamId    text  -- First workstream only (see caveats)
```

## Propagation Flow

```
                    Human/External Dispatch
                            |
                            v
+----------------------------------------------------------+
|  Root Job Created (requestId = "abc-123")                |
|  workstreamId = requestId = "abc-123"                    |
+----------------------------------------------------------+
                            |
      jobRunner.ts:93-96 resolves workstreamId:
      resolvedWorkstreamId = metadata?.workstreamId
                          || target.workstreamId
                          || target.id
                            |
                            v
+----------------------------------------------------------+
|  Worker sets JINN_WORKSTREAM_ID env var                  |
|  (worker/metadata/jobContext.ts:51-53)                   |
+----------------------------------------------------------+
                            |
      Agent dispatches child via dispatch_new_job
                            |
                            v
+----------------------------------------------------------+
|  ipfs-payload-builder.ts:131-137 builds lineage:         |
|  if (context.workstreamId)                               |
|    lineageContext.workstreamId = context.workstreamId    |
+----------------------------------------------------------+
                            |
      Child IPFS payload includes workstreamId
                            |
                            v
+----------------------------------------------------------+
|  ponder/src/index.ts:733-745 resolves on indexing:       |
|  1) Use explicit workstreamId from metadata              |
|  2) OR traverse sourceRequestId chain to find root       |
|  3) OR use own requestId (if root job)                   |
+----------------------------------------------------------+
```

## Resolution Logic in Ponder

```typescript
// ponder/src/index.ts:729-745
let workstreamId: string;
const explicitWorkstreamId = content.workstreamId;

if (explicitWorkstreamId) {
  // Parent re-dispatch preserving workstream
  workstreamId = explicitWorkstreamId;
} else if (sourceRequestId) {
  // Traverse up chain to find root
  workstreamId = await findWorkstreamRoot(sourceRequestId, repo);
} else {
  // Root job - workstreamId = own requestId
  workstreamId = id;
}
```

The `findWorkstreamRoot` function (lines 427-460) traverses the `sourceRequestId` chain up to 100 hops to find the ultimate root.

## Environment Variable Propagation

| Variable | Set By | Read By |
|----------|--------|---------|
| `JINN_WORKSTREAM_ID` | `worker/metadata/jobContext.ts:52` | `gemini-agent/mcp/tools/shared/context.ts:32` |

The agent's `getCurrentJobContext()` reads `JINN_WORKSTREAM_ID` from the environment, making it available to `dispatch_new_job` and `buildIpfsPayload`.

## Scoping Rules

1. **Root Jobs**: `workstreamId = requestId` (they are their own root)

2. **Child Jobs**: Inherit `workstreamId` from parent via:
   - Explicit `workstreamId` in IPFS payload (set by `buildIpfsPayload`)
   - Fallback: Ponder traverses `sourceRequestId` chain to find root

3. **Job Definitions**: `workstreamId` field stores the **first** workstream only. A job definition can participate in multiple workstreams (e.g., re-dispatched templates).

   ```
   To find all workstreams for a job definition:
   Query requests by jobDefinitionId, extract unique workstreamIds
   ```

## Lifecycle

```
1. CREATION
   MarketplaceRequest event -> Ponder indexes request
   - Root: workstreamId = requestId, create workstream record
   - Child: workstreamId = resolved root, increment childRequestCount

2. EXECUTION
   Worker claims request -> sets JINN_WORKSTREAM_ID
   Agent accesses via getCurrentJobContext().workstreamId

3. CHILD DISPATCH
   dispatch_new_job -> buildIpfsPayload includes workstreamId
   Child request created with same workstreamId

4. DELIVERY
   OlasMech:Deliver event -> Ponder updates
   - Root delivery: workstream.delivered = true
   - All deliveries: workstream.lastActivity updated
```

## Querying Workstream Data

```graphql
# All requests in a workstream
query {
  requests(where: { workstreamId: "abc-123" }) {
    items { id, jobName, delivered }
  }
}

# Workstream metadata
query {
  workstream(id: "abc-123") {
    rootRequestId
    childRequestCount
    lastActivity
    delivered
  }
}

# WRONG: Don't query job_definition.workstreamId for multi-workstream jobs
# Job definitions only store first workstream
```

## Caveats

1. **Job Definition Limitation**: `job_definition.workstreamId` only stores the first workstream. For jobs that run across multiple workstreams, query the `requests` table instead.

2. **Indexing Order**: Ponder must process `MarketplaceRequest` before `OlasMech:Deliver` for proper workstream attribution.

3. **Cycle Detection**: `findWorkstreamRoot` limits traversal to 100 hops and tracks visited IDs to prevent infinite loops.
