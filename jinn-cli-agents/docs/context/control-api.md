---
title: Control API
purpose: context
scope: [worker, deployment]
last_verified: 2026-01-30
related_code:
  - control-api/server.ts
  - worker/control_api_client.ts
  - worker/mech_worker.ts
keywords: [control-api, claim, locking, graphql, deduplication, health]
when_to_read: "When debugging claim conflicts, duplicate execution, or worker coordination"
---

# Control API

The Control API is a GraphQL service that coordinates distributed workers to prevent duplicate job execution. It provides atomic claim locking, job reporting, and health monitoring.

## Why It Exists

Multiple workers poll for on-chain requests simultaneously. Without coordination, two workers could claim and execute the same job, wasting compute and potentially causing delivery conflicts. The Control API solves this with database-backed atomic claims.

## Claim Locking Mechanism

### Request Claims

Workers call `claimRequest(requestId)` before executing a job. The Control API uses a two-phase atomic locking pattern:

```
┌─────────────┐     claimRequest     ┌──────────────┐
│   Worker    │ ──────────────────>  │  Control API │
└─────────────┘                      └──────────────┘
                                            │
                            ┌───────────────┴───────────────┐
                            ▼                               ▼
                    [Phase 1: INSERT]               [Phase 2: CHECK]
                    Try atomic insert               If exists, check if
                    new claim row                   reclaimable
                            │                               │
                    ┌───────┴───────┐               ┌───────┴───────┐
                    │  Success?     │               │  Reclaimable? │
                    └───────────────┘               └───────────────┘
                      │         │                     │         │
                    Yes        No (23505)           Yes        No
                      │         │                     │         │
                      ▼         └──────>              ▼         ▼
              Return claim                    UPDATE claim    Return
              alreadyClaimed=false            with new worker alreadyClaimed=true
```

### Claim States

| Status | Description |
|--------|-------------|
| `IN_PROGRESS` | Active claim, worker is executing |
| `COMPLETED` | Job finished, claim can be reclaimed |

### Stale Claim Recovery

Claims become reclaimable after **5 minutes** (`300000ms`) of inactivity:

```typescript
const staleThreshold = new Date(Date.now() - 300000).toISOString();
const isStale = existing.status === 'IN_PROGRESS' &&
  existing.claimed_at && existing.claimed_at < staleThreshold;
```

This handles worker crashes without manual intervention.

### Parent Dispatch Claims

For job decomposition, `claimParentDispatch` prevents sibling jobs from duplicating parent-to-child dispatch:

- Claims expire after **5 minutes** (auto-cleanup on next claim attempt)
- If the same child retries, it's allowed (idempotent)
- If a sibling already claimed, returns `allowed: false`

## Preventing Duplicate Work

The worker maintains a session-level deduplication set:

```typescript
const executedJobsThisSession = new Set<string>();

// In tryClaim():
if (executedJobsThisSession.has(request.id)) {
  return false; // Skip to prevent re-execution loop
}

// After job completes (even on delivery failure):
executedJobsThisSession.add(target.id);
```

This prevents infinite loops when:
1. Worker executes job
2. Delivery fails
3. Control API allows re-claiming (stale)
4. Same worker picks it up again

## Health Monitoring

### REST Health Endpoint

```
GET /health
```

Response:
```json
{
  "status": "ok",
  "nodeId": "a1b2c3d4",
  "service": "control-api",
  "uptime": { "ms": 3600000, "human": "1h 0m" },
  "timestamp": "2025-01-29T10:00:00.000Z"
}
```

The `nodeId` is derived from the master safe address (first 8 hex chars after `0x`).

### Worker Startup Check

Workers verify Control API connectivity before processing:

```typescript
async function checkControlApiHealth(): Promise<void> {
  const query = `query { __typename }`;
  await graphQLRequest({ url: CONTROL_API_URL, query, maxRetries: 0 });
}
```

Failure exits with instructions to start Control API.

## Client Integration

The `control_api_client.ts` provides typed functions with automatic retry:

| Function | Purpose |
|----------|---------|
| `claimRequest(requestId)` | Atomic job claim |
| `claimParentDispatch(parentId, childId)` | Decomposition coordination |
| `createJobReport(requestId, data)` | Job completion reporting |
| `createArtifact(requestId, data)` | Store job outputs |
| `createMessage(requestId, data)` | Store job messages |

All mutation requests include:
- ERC-8128 signed headers (`signature-input`, `signature`, `content-digest`)
- `Idempotency-Key` header (`{requestId}:{phase}`)
- Exponential backoff retry (up to 3 attempts)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTROL_API_URL` | `http://localhost:4001/graphql` | API endpoint |
| `CONTROL_API_PORT` | `4001` | Server port |
| `USE_CONTROL_API` | `true` | Enable/disable coordination |
