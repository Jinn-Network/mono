---
title: Ponder GraphQL API Reference
purpose: reference
scope: [worker, frontend]
last_verified: 2026-01-30
related_code:
  - ponder/ponder.schema.ts
  - ponder/src/index.ts
  - frontend/explorer/src/lib/subgraph.ts
  - worker/status/childJobs.ts
  - worker/delivery/ponderVerification.ts
  - tests-next/helpers/ponder-queries.ts
keywords: [ponder, graphql, indexer, requests, deliveries, artifacts, queries]
when_to_read: "When querying the Ponder API or understanding indexed data schema"
---

# Ponder GraphQL API

Ponder indexes on-chain Jinn marketplace events and exposes them via a GraphQL API. This document describes the schema and common query patterns used by the worker and frontend.

## Endpoint

- **Default:** `http://localhost:42069/graphql`
- **Environment variable:** `PONDER_GRAPHQL_URL` or `NEXT_PUBLIC_SUBGRAPH_URL`
- **SQL endpoint:** Replace `/graphql` with `/sql` for Drizzle-style queries via `@ponder/client`

## Tables

### requests

Job execution requests from the marketplace. Created when `MechMarketplace:MarketplaceRequest` events are indexed.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | On-chain request ID (decimal or 0x hex) |
| `mech` | String | Yes | Priority mech address (0x, lowercase) |
| `sender` | String | Yes | Requester address (0x, lowercase) |
| `workstreamId` | String | No | Root request ID (workstream context) |
| `jobDefinitionId` | String | No | Associated job definition UUID |
| `sourceRequestId` | String | No | Parent request ID (for child jobs) |
| `sourceJobDefinitionId` | String | No | Parent job definition ID (lineage) |
| `requestData` | String | No | Raw request data hex |
| `ipfsHash` | String | No | Request metadata CID (hex multibase) |
| `deliveryIpfsHash` | String | No | Delivery result CID |
| `deliveryMech` | String | No | Mech that actually delivered |
| `transactionHash` | String | No | Transaction hash |
| `blockNumber` | BigInt | Yes | Block number |
| `blockTimestamp` | BigInt | Yes | Block timestamp (Unix seconds) |
| `delivered` | Boolean | Yes | Whether delivery completed |
| `jobName` | String | No | Human-readable job name |
| `enabledTools` | [String] | No | List of enabled tool names |
| `additionalContext` | JSON | No | Additional context from IPFS metadata |
| `dependencies` | [String] | No | Job definition IDs that must complete first |

**Indexes:** `blockTimestamp`, `mech`, `deliveryMech`, `sender`, `workstreamId`, `jobDefinitionId`, `sourceRequestId`, `sourceJobDefinitionId`

### jobDefinitions

Job definitions (reusable job templates). Created/updated when requests are indexed.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | Job definition UUID |
| `name` | String | No | Human-readable name |
| `enabledTools` | [String] | No | Enabled tool names |
| `blueprint` | String | No | Blueprint JSON (assertions, tools) |
| `workstreamId` | String | No | First workstream this job participated in |
| `sourceJobDefinitionId` | String | No | Parent job definition ID |
| `sourceRequestId` | String | No | Source request that created/updated this |
| `codeMetadata` | JSON | No | Git repo, branch, commit info |
| `dependencies` | [String] | No | Required job definition IDs |
| `createdAt` | BigInt | No | Creation timestamp |
| `lastInteraction` | BigInt | No | Last activity timestamp |
| `lastStatus` | String | No | Latest status (PENDING, COMPLETED, FAILED, DELEGATING, WAITING) |
| `latestStatusUpdate` | String | No | Human-readable status message |
| `latestStatusUpdateAt` | BigInt | No | Timestamp of latestStatusUpdate |

**Indexes:** `name`, `workstreamId`, `sourceJobDefinitionId`, `sourceRequestId`, `lastInteraction`

### deliveries

On-chain delivery records. Created when `OlasMech:Deliver` events are indexed.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | Delivery ID (same as request ID) |
| `requestId` | String | Yes | Associated request ID |
| `sourceRequestId` | String | No | Parent request ID |
| `sourceJobDefinitionId` | String | No | Job definition that was executed |
| `mech` | String | Yes | Mech address from event |
| `mechServiceMultisig` | String | Yes | Service multisig address |
| `deliveryMech` | String | No | Mech that delivered (from marketplace event) |
| `deliveryRate` | BigInt | Yes | Delivery rate |
| `ipfsHash` | String | No | Delivery result CID |
| `transactionHash` | String | Yes | Transaction hash |
| `blockNumber` | BigInt | Yes | Block number |
| `blockTimestamp` | BigInt | Yes | Block timestamp |
| `jobInstanceStatusUpdate` | String | No | Status update from delivery payload |

**Indexes:** `blockTimestamp`, `mech`, `deliveryMech`, `requestId`, `sourceRequestId`, `sourceJobDefinitionId`

### artifacts

Job artifacts extracted from delivery payloads.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | Artifact ID (`{requestId}:{index}`) |
| `requestId` | String | Yes | Request that produced this artifact |
| `sourceRequestId` | String | No | Root workstream request ID |
| `sourceJobDefinitionId` | String | No | Job definition that produced this |
| `name` | String | Yes | Artifact name |
| `cid` | String | Yes | IPFS CID |
| `topic` | String | Yes | Artifact topic (e.g., `launcher_briefing`, `MEASUREMENT`, `SITUATION`) |
| `contentPreview` | String | No | Preview of content |
| `blockTimestamp` | BigInt | Yes | Creation timestamp |
| `type` | String | No | Artifact type (e.g., `SITUATION`) |
| `tags` | [String] | No | Artifact tags |
| `utilityScore` | Int | No | Utility score |
| `accessCount` | Int | No | Access count |

**Indexes:** `requestId`, `sourceRequestId`, `sourceJobDefinitionId`, `topic`, `blockTimestamp`, `type`, `utilityScore`

### messages

Inter-job messages extracted from request metadata.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | Message ID (same as request ID) |
| `requestId` | String | Yes | Associated request ID |
| `sourceRequestId` | String | No | Parent request ID |
| `sourceJobDefinitionId` | String | No | Sender job definition ID |
| `to` | String | No | Recipient job definition ID |
| `content` | String | Yes | Message content |
| `blockTimestamp` | BigInt | Yes | Timestamp |

**Indexes:** `requestId`, `sourceRequestId`, `sourceJobDefinitionId`, `to`, `blockTimestamp`

### workstreams

Aggregated workstream metadata for efficient querying.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | Workstream ID (same as root request ID) |
| `rootRequestId` | String | Yes | Root request ID |
| `jobName` | String | No | Job name of root request |
| `mech` | String | Yes | Mech address |
| `sender` | String | Yes | Sender address |
| `blockTimestamp` | BigInt | Yes | Creation timestamp |
| `lastActivity` | BigInt | Yes | Last activity timestamp |
| `childRequestCount` | Int | Yes | Number of child requests |
| `hasLauncherBriefing` | Boolean | Yes | Has launcher_briefing artifact |
| `delivered` | Boolean | Yes | Root request delivered |

**Indexes:** `blockTimestamp`, `lastActivity`, `mech`, `sender`

### jobTemplates

Reusable workflow templates derived from job definitions. Created automatically when indexing.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | Template ID (slug + hash) |
| `name` | String | Yes | Template name |
| `description` | String | No | Description |
| `tags` | [String] | No | Tags for categorization |
| `enabledTools` | [String] | No | Tool policy |
| `blueprintHash` | String | No | Hash for deduplication |
| `blueprint` | String | No | Canonical blueprint JSON |
| `inputSchema` | JSON | No | JSON Schema for inputs |
| `outputSpec` | JSON | No | Output specification |
| `priceWei` | BigInt | No | x402 price in atomic units |
| `priceUsd` | String | No | Human-readable USD price |
| `canonicalJobDefinitionId` | String | No | First job definition ID |
| `runCount` | Int | Yes | Execution count |
| `successCount` | Int | Yes | Successful completions |
| `avgDurationSeconds` | Int | No | Average duration |
| `avgCostWei` | BigInt | No | Average cost |
| `createdAt` | BigInt | Yes | First seen timestamp |
| `lastUsedAt` | BigInt | No | Last execution timestamp |
| `status` | String | Yes | `visible`, `hidden`, or `deprecated` |
| `defaultCyclic` | Boolean | No | Default cyclic mode |

**Indexes:** `name`, `status`, `blueprintHash`, `canonicalJobDefinitionId`, `createdAt`, `lastUsedAt`, `runCount`

## Common Queries

### Check Delivery Status (Worker)

Used by `worker/delivery/ponderVerification.ts` as fallback when RPC verification fails.

```graphql
query CheckDelivery($requestId: String!) {
  requests(where: { id: $requestId }) {
    items {
      id
      delivered
      deliveryIpfsHash
      transactionHash
    }
  }
}
```

### Get Child Jobs (Worker)

Used by `worker/status/childJobs.ts` to check child job delivery status.

```graphql
query GetChildJobs($sourceRequestId: String!) {
  requests(where: { sourceRequestId: $sourceRequestId }) {
    items {
      id
      delivered
    }
  }
}
```

### Get Requests for Job Definition (Worker)

Used to find all runs of a job across its lifetime.

```graphql
query GetRequestsForJobDef($jobDefId: String!) {
  requests(
    where: { jobDefinitionId: $jobDefId }
    orderBy: "blockTimestamp"
    orderDirection: "asc"
    limit: 100
  ) {
    items {
      id
      blockTimestamp
    }
  }
}
```

### Get Child Job Definitions (Worker)

Used to check statuses of delivered children.

```graphql
query GetChildJobDefinitions($requestIds: [String!]!) {
  requests(where: { id_in: $requestIds }) {
    items {
      id
      jobDefinitionId
    }
  }
}
```

### Get Job Definition Status (Worker)

Used by `worker/mech_worker.ts` to check dependency status.

```graphql
query CheckJobDefStatus($jobDefId: String!) {
  jobDefinitions(where: { id: $jobDefId }) {
    items {
      id
      name
      lastStatus
      lastInteraction
    }
  }
}
```

### Get Job Definition Status (Batch)

```graphql
query GetJobDefinitionStatus($jobDefIds: [String!]!) {
  jobDefinitions(where: { id_in: $jobDefIds }) {
    items {
      id
      lastStatus
    }
  }
}
```

### Get Single Request

```graphql
query Request($id: String!) {
  request(id: $id) {
    id
    delivered
    jobDefinitionId
    workstreamId
    dependencies
  }
}
```

### Batch Job Definition Lookup

```graphql
query DependencyInfo($ids: [String!]!) {
  jobDefinitions(where: { id_in: $ids }) {
    items { id, name, lastStatus }
  }
}
```

## Filter Operators

All tables support the following filter operators on string fields:

| Operator | Description |
|----------|-------------|
| `field` | Equals |
| `field_not` | Not equals |
| `field_in` | In array |
| `field_not_in` | Not in array |
| `field_contains` | Contains substring |
| `field_not_contains` | Does not contain substring |
| `field_starts_with` | Starts with |
| `field_ends_with` | Ends with |
| `field_not_starts_with` | Does not start with |
| `field_not_ends_with` | Does not end with |

Numeric fields (BigInt, Int) additionally support:

| Operator | Description |
|----------|-------------|
| `field_gt` | Greater than |
| `field_lt` | Less than |
| `field_gte` | Greater than or equal |
| `field_lte` | Less than or equal |

Array fields support:

| Operator | Description |
|----------|-------------|
| `field_has` | Array contains element |
| `field_not_has` | Array does not contain element |

Boolean fields support:

| Operator | Description |
|----------|-------------|
| `field` | Equals |
| `field_not` | Not equals |
| `field_in` | In array |
| `field_not_in` | Not in array |

Filters can be combined with `AND` and `OR` operators.

## Pagination

All collection queries return a `pageInfo` object:

```graphql
pageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

Use `limit`, `after` (cursor), and `before` (cursor) for pagination.

## Indexing Behavior

### Network Filtering

Ponder only indexes requests where `networkId === "jinn"` or `networkId` is undefined (legacy). Non-Jinn marketplace traffic is filtered out before any database writes.

### Workstream ID Computation

1. Explicit `workstreamId` in IPFS metadata takes precedence
2. For child jobs, traverse `sourceRequestId` chain to find root
3. Root jobs use their own request ID as workstream ID

### Status Updates

- `lastStatus` on job definitions reflects the most recent delivery status
- Possible values: `PENDING`, `COMPLETED`, `FAILED`, `DELEGATING`, `WAITING`
- Worker queries child jobs directly for true completion status

### Indexing Lag

Ponder indexes on-chain events with a slight delay (typically 1-5 seconds).

**Implications:**
- Newly dispatched jobs may not appear immediately
- Worker uses `JINN_DEPENDENCY_VALIDATION_RETRIES` for dependency checks
- Worker falls back to RPC for delivery status if Ponder is stale

## Client Usage

### Frontend (graphql-request)

```typescript
import { request } from 'graphql-request'

const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL

const data = await request<ResponseType>(SUBGRAPH_URL, query, variables)
```

### Worker (graphQLRequest helper)

```typescript
import { graphQLRequest } from '../http/client.js'
import { getPonderGraphqlUrl } from '../gemini-agent/mcp/tools/shared/env.js'

const data = await graphQLRequest<ResponseType>({
  url: getPonderGraphqlUrl(),
  query,
  variables,
  context: { operation: 'operationName', ...metadata }
})
```

### Drizzle-style (@ponder/client)

```typescript
import { createClient } from "@ponder/client"
import * as schema from "./schema"

const ponderClient = createClient(PONDER_SQL_URL, { schema })
```
