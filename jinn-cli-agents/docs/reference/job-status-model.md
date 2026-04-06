---
title: Job Status Model Reference
purpose: reference
scope: [worker, gemini-agent]
last_verified: 2026-01-30
related_code:
  - worker/types.ts
  - worker/status/inferStatus.ts
  - worker/status/autoDispatch.ts
  - worker/delivery/transaction.ts
  - worker/delivery/validation.ts
  - worker/status/childJobs.ts
  - worker/mech_worker.ts
  - ponder/src/index.ts
  - gemini-agent/mcp/tools/dispatch_new_job.ts
keywords: [status, job lifecycle, terminal, delegating, waiting, completed, failed]
when_to_read: "When understanding job status values and state transitions"
---

# Job Status Model Reference

## Status Values

| Status | Terminal | Delivered | Meaning |
|--------|----------|-----------|---------|
| `PENDING` | No | No | Job posted on-chain, awaiting worker claim |
| `IN_PROGRESS` | No | No | Worker executing (internal only, not persisted) |
| `DELEGATING` | No | Yes | Dispatched children this run, awaiting their completion |
| `WAITING` | No | Yes | Has undelivered or non-terminal children |
| `COMPLETED` | Yes | Yes | All work finished (no children, or all children terminal) |
| `FAILED` | Yes | Yes | Execution error or explicit failure |

## Terminal vs Non-Terminal

```
Terminal statuses:     COMPLETED, FAILED
Non-terminal statuses: PENDING, DELEGATING, WAITING
```

### Terminal Status Definition

Source: `worker/mech_worker.ts:209-211`

```typescript
function isTerminalStatus(status?: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}
```

### Delivery Implications

- Jobs CAN deliver with non-terminal status (`DELEGATING`, `WAITING`)
- Parent dispatch triggers ONLY on terminal status (`COMPLETED`, `FAILED`)
- `DELEGATING`/`WAITING` jobs will be re-dispatched when children complete

Source: `worker/status/autoDispatch.ts:972-985`

```typescript
// Only dispatch on terminal states
if (!finalStatus || (finalStatus.status !== 'COMPLETED' && finalStatus.status !== 'FAILED')) {
  return {
    shouldDispatch: false,
    reason: `Status is not terminal: ${finalStatus?.status || 'none'}`,
  };
}
```

## Type Definition

`FinalStatus` type (`worker/types.ts:13-16`): `'COMPLETED' | 'DELEGATING' | 'WAITING' | 'FAILED'`

Note: `PENDING` and `IN_PROGRESS` are pre-delivery states, not part of `FinalStatus`.

## Status Transitions

```
                    ┌─────────────────────────────────────────────┐
                    │                                             │
                    ▼                                             │
┌─────────┐    ┌───────────────┐    ┌────────────┐    ┌──────────┴──┐
│ PENDING │───▶│ (IN_PROGRESS) │───▶│ DELEGATING │───▶│   WAITING   │
└─────────┘    └───────┬───────┘    └─────┬──────┘    └──────┬──────┘
                       │                  │                  │
                       │                  │                  │
                       ▼                  ▼                  ▼
                 ┌───────────┐      ┌───────────┐      ┌───────────┐
                 │ COMPLETED │◀─────│ COMPLETED │◀─────│ COMPLETED │
                 └───────────┘      └───────────┘      └───────────┘
                       │                  │                  │
                       ▼                  ▼                  ▼
                 ┌───────────┐      ┌───────────┐      ┌───────────┐
                 │  FAILED   │      │  FAILED   │      │  FAILED   │
                 └───────────┘      └───────────┘      └───────────┘
```

### Transition Rules

| From | To | Condition |
|------|-----|-----------|
| `PENDING` | (execution) | Worker claims job |
| (execution) | `DELEGATING` | `dispatchCalls > 0` or `delegatedThisRun` |
| (execution) | `WAITING` | Undelivered children exist, no dispatch this run |
| (execution) | `COMPLETED` | No children or all children terminal |
| (execution) | `FAILED` | Error occurred |
| `DELEGATING` | `WAITING` | Re-dispatch after child completes, more children pending |
| `DELEGATING` | `COMPLETED` | All children terminal |
| `WAITING` | `COMPLETED` | All children terminal |
| `WAITING` | `FAILED` | Child failure propagates (optional remediation) |

## Status Inference Algorithm

Source: `worker/status/inferStatus.ts:54-282`

```
1. Error occurred?           → FAILED
2. Dispatched children?      → DELEGATING
3. Undelivered children?     → WAITING
4. Active children (DELEGATING/WAITING)? → WAITING
5. Otherwise                 → COMPLETED
```

## PENDING Status

`PENDING` is set by Ponder indexer on job definition creation/update.

Source: `ponder/src/index.ts:674-682`

```typescript
await jobDefRepo.upsert({
  id: jobDefinitionId,
  create: {
    // ...
    lastStatus: 'PENDING',
  },
  update: {
    // ...
    lastStatus: 'PENDING',
  },
});
```

### PENDING Context

- Job definition created but no worker has claimed yet
- Job has unmet dependencies (other jobs must complete first)
- Worker not running or at capacity

### Redispatchable Statuses

Source: `worker/mech_worker.ts:274`

```typescript
const redispatchable = new Set(['DELEGATING', 'WAITING', 'PENDING']);
```

Stale jobs in these statuses may be auto-redispatched by the dependency resolution system.

## Semantic Failure Detection

Source: `worker/status/semanticStatus.ts:20-47`

Agent output is scanned for explicit failure indicators:

```typescript
// Pattern 1: "Status: FAILED"
const statusMatch = output.match(/\*?\*?Status\*?\*?:\s*FAILED/i);

// Pattern 2: "I cannot complete..." statements
const inabilityMatch = output.match(/I (?:cannot|could not|am unable to) complete[^\n]*/i);
```

If detected, overrides inferred status to `FAILED`.

## Status Storage

| Location | Field | Description |
|----------|-------|-------------|
| Ponder `jobDefinition` | `lastStatus` | Most recent delivery status |
| Ponder `request` | `delivered` | Boolean: has request been delivered |
| Delivery payload (IPFS) | `status` | Status string in JSON payload |

## Parent Dispatch Logic

Parent dispatched when **all children reach terminal status** (COMPLETED or FAILED).

```
Child completes → All siblings terminal? → Yes → Dispatch parent
                                         → No  → Wait
```

Source: `worker/status/autoDispatch.ts:1074-1081`

## Special Dispatch Types

| Type | Trigger | Context Field | Max Attempts |
|------|---------|---------------|--------------|
| Verification | Job with children completes | `verificationRequired = true` | 3 |
| Continuation | Children's code not integrated | `additionalContext` preserved | - |
| Loop Recovery | Loop detection terminated job | `loopRecovery.attempt` | 3 |
| Cycle | Root job repeats | `cycle.cycleNumber` | - |

Source: `worker/status/autoDispatch.ts`

## Example: Parent-Child Flow

```
1. Parent executes          → IN_PROGRESS (internal)
2. Parent dispatches 3 kids → DELEGATING (delivered)
3. Child 1 completes        → Parent not re-dispatched (2 pending)
4. Child 2 completes        → Parent not re-dispatched (1 pending)
5. Child 3 completes        → Parent re-dispatched
6. Parent reviews children  → COMPLETED (delivered)
```

## Debugging Status Issues

### Check Job Definition Status

```sql
-- Ponder GraphQL
query {
  jobDefinition(id: "<job-def-id>") {
    id
    lastStatus
    lastInteraction
  }
}
```

### Check Request Delivery

```sql
query {
  request(id: "<request-id>") {
    delivered
    deliveryIpfsHash
    jobDefinitionId
  }
}
```

### Check Child Completion

```sql
query {
  jobDefinitions(where: { sourceJobDefinitionId: "<parent-job-def-id>" }) {
    items {
      id
      name
      lastStatus
    }
  }
}
```

