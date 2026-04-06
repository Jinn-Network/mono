---
title: System Overview
purpose: context
scope: [worker, gemini-agent, frontend, mcp, deployment]
last_verified: 2026-01-30
related_code:
  - worker/mech_worker.ts
  - gemini-agent/agent.ts
  - ponder/src/index.ts
  - control-api/server.ts
  - worker/orchestration/jobRunner.ts
  - worker/delivery/transaction.ts
  - worker/control_api_client.ts
  - ponder/ponder.schema.ts
keywords: [architecture, ponder, control-api, worker, agent, contracts, safe]
when_to_read: "When needing a high-level understanding of how all system components interact"
---

# System Overview

High-level architecture showing how Worker, Agent, Ponder, and Contracts interact.

## Architecture Diagram

```
                                    SMART CONTRACTS (Base L2)
                    ┌────────────────────────────────────────────────────┐
                    │                                                    │
                    │  ┌──────────────────────┐  ┌──────────────────┐   │
                    │  │  MechMarketplace     │  │    OlasMech      │   │
                    │  │  0xf24eE42...7C5020  │  │  (per-service)   │   │
                    │  │                      │  │                  │   │
                    │  │  Events:             │  │  Events:         │   │
                    │  │  - MarketplaceRequest│  │  - Deliver       │   │
                    │  │  - MarketplaceDelivery│ │                  │   │
                    │  │  - CreateMech        │  │                  │   │
                    │  └──────────┬───────────┘  └────────┬─────────┘   │
                    │             │                       │             │
                    └─────────────┼───────────────────────┼─────────────┘
                                  │                       │
                    INDEXING      │ subscribe             │ subscribe
                    ┌─────────────┼───────────────────────┼─────────────┐
                    │             ▼                       ▼             │
                    │  ┌─────────────────────────────────────────────┐  │
                    │  │                   PONDER                    │  │
                    │  │              ponder/src/index.ts            │  │
                    │  │                                             │  │
                    │  │  Tables:                                    │  │
                    │  │  - request (job requests)                   │  │
                    │  │  - delivery (job deliveries)                │  │
                    │  │  - jobDefinition (job templates)            │  │
                    │  │  - artifact (outputs)                       │  │
                    │  │  - workstream (job hierarchies)             │  │
                    │  │                                             │  │
                    │  │  GraphQL API: /graphql                      │  │
                    │  └────────────────────┬────────────────────────┘  │
                    └───────────────────────┼───────────────────────────┘
                                            │
                    COORDINATION            │ query
                    ┌───────────────────────┼───────────────────────────┐
                    │                       ▼                           │
                    │  ┌─────────────────────────────────────────────┐  │
                    │  │              CONTROL API                    │  │
                    │  │           control-api/server.ts             │  │
                    │  │                                             │  │
                    │  │  GraphQL Mutations:                         │  │
                    │  │  - claimRequest (worker locking)            │  │
                    │  │  - createJobReport (telemetry)              │  │
                    │  │  - claimParentDispatch (sibling guard)      │  │
                    │  │                                             │  │
                    │  │  Storage: Supabase (request_claims, etc)    │  │
                    │  └────────────────────┬────────────────────────┘  │
                    └───────────────────────┼───────────────────────────┘
                                            │
                    EXECUTION               │ claim/report
                    ┌───────────────────────┼───────────────────────────┐
                    │                       ▼                           │
                    │  ┌─────────────────────────────────────────────┐  │
                    │  │                  WORKER                     │  │
                    │  │            worker/mech_worker.ts            │  │
                    │  │                                             │  │
                    │  │  Loop:                                      │  │
                    │  │  1. fetchRecentRequests() → Ponder          │  │
                    │  │  2. filterUnclaimed() → marketplace RPC     │  │
                    │  │  3. tryClaim() → Control API                │  │
                    │  │  4. processJobOnce() → orchestration        │  │
                    │  │                                             │  │
                    │  └────────────────────┬────────────────────────┘  │
                    │                       │                           │
                    │                       ▼                           │
                    │  ┌─────────────────────────────────────────────┐  │
                    │  │             JOB ORCHESTRATOR                │  │
                    │  │      worker/orchestration/jobRunner.ts      │  │
                    │  │                                             │  │
                    │  │  Phases:                                    │  │
                    │  │  1. initialization (IPFS, git)              │  │
                    │  │  2. agent_execution (LLM + tools)           │  │
                    │  │  3. git_operations (commit, push)           │  │
                    │  │  4. reporting (Control API)                 │  │
                    │  │  5. delivery (Safe transaction)             │  │
                    │  │  6. telemetry_persistence                   │  │
                    │  │                                             │  │
                    │  └────────────────────┬────────────────────────┘  │
                    │                       │                           │
                    │                       ▼                           │
                    │  ┌─────────────────────────────────────────────┐  │
                    │  │              GEMINI AGENT                   │  │
                    │  │           gemini-agent/agent.ts             │  │
                    │  │                                             │  │
                    │  │  - Spawns Gemini CLI process                │  │
                    │  │  - Configures MCP tools via settings.json   │  │
                    │  │  - Provides job context via env vars        │  │
                    │  │  - Captures telemetry and output            │  │
                    │  │                                             │  │
                    │  │  MCP Tools: dispatch_new_job, write_file,   │  │
                    │  │  create_artifact, task_boundary, etc.       │  │
                    │  └─────────────────────────────────────────────┘  │
                    └───────────────────────────────────────────────────┘
```

## Component Details

### Worker (`worker/mech_worker.ts`)

| Aspect | Details |
|--------|---------|
| Polling interval | Adaptive: 30s base, up to 5min when idle |
| Claim mechanism | Control API `claimRequest` mutation |

**Flow:** `fetchRecentRequests()` → `filterUnclaimed()` → `filterByDependencies()` → `tryClaim()` → `processJobOnce()`

### Job Orchestrator (`worker/orchestration/jobRunner.ts`)

**Phases:** initialization → agent_execution → git_operations → reporting → delivery → telemetry_persistence

| Condition | Inferred Status |
|-----------|-----------------|
| No error | COMPLETED |
| Error | FAILED |
| Has children | DELEGATING or WAITING |

### Gemini Agent (`gemini-agent/agent.ts`)

| Aspect | Details |
|--------|---------|
| LLM backend | Gemini CLI (`npx @google/gemini-cli`) |
| Tool system | MCP (Model Context Protocol) |

**Key interface:** `Agent.run(prompt)` → `AgentResult { output, telemetry }`

### Ponder Indexer (`ponder/src/index.ts`)

Chain: Base L2 (8453) | Marketplace: `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020`

**Events indexed:** `MarketplaceRequest`, `MarketplaceDelivery`, `Deliver`

**Tables:** `request`, `delivery`, `jobDefinition`, `artifact`, `workstream`, `jobTemplate`, `message`

See `docs/spec/api/ponder-graphql.md` for full schema.

### Control API (`control-api/server.ts`)

Framework: GraphQL Yoga | Storage: Supabase | Port: 4001

**Key mutations:** `claimRequest`, `createJobReport`, `claimParentDispatch`

Claim timeout: 5 min → reclaimable

## Data Flow: Job Execution

```
Worker          Control API       Ponder           Agent           Blockchain
  │                 │               │                │                 │
  │ fetchRequests   │               │                │                 │
  ├────────────────────────────────►│                │                 │
  │ ◄──────────────────────────────┤│ undelivered   │                 │
  │ claimRequest    │               │                │                 │
  ├────────────────►│               │                │                 │
  │ ◄──────────────┤│ IN_PROGRESS  │                │                 │
  │ run()           │               │                │                 │
  ├────────────────────────────────────────────────►│                 │
  │ ◄──────────────────────────────────────────────┤│ AgentResult     │
  │ createReport    │               │                │                 │
  ├────────────────►│               │                │                 │
  │ deliverViaSafe  │               │                │                 │
  ├────────────────────────────────────────────────────────────────────►│
  │                 │               │ ◄────────────────────────────────┤│ emit Deliver
```

## Key Integration Points

| From | To | Protocol | Function/Endpoint |
|------|-----|----------|-------------------|
| Worker | Ponder | GraphQL | `graphQLRequest()` to `PONDER_GRAPHQL_URL` |
| Worker | Control API | GraphQL | `claimRequest()`, `createJobReport()` |
| Worker | Blockchain | JSON-RPC | `marketplace.mapRequestIdInfos()` |
| Worker | IPFS | HTTP | `fetchRequestMetadata()` via gateway |
| Worker | Gemini Agent | Function | `Agent.run()` |
| Worker | Safe | Web3 | `deliverViaSafe()` |
| Ponder | Blockchain | WebSocket/HTTP | Event subscription |
| Agent | MCP Tools | stdio | Gemini CLI subprocess |

## Environment Variables

| Variable | Component | Purpose |
|----------|-----------|---------|
| `PONDER_GRAPHQL_URL` | Worker | Ponder endpoint for queries |
| `CONTROL_API_URL` | Worker | Control API endpoint |
| `BASE_RPC_URL` | Worker, Ponder | Base L2 RPC endpoint |
| `SERVICE_PRIVATE_KEY` | Worker | Agent wallet private key |
| `SERVICE_SAFE_ADDRESS` | Worker | Safe multisig address |
| `SUPABASE_URL` | Control API | Database connection |
| `GEMINI_API_KEY` | Agent | LLM authentication |
| `CODE_METADATA_REPO_ROOT` | Worker | Git workspace path |

## Contract Addresses

| Contract | Network | Address |
|----------|---------|---------|
| MechMarketplace | Base | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| OlasMech | Base | Per-service (discovered via CreateMech event) |

## Error Handling

| Error Type | Handler | Recovery |
|------------|---------|----------|
| IPFS timeout | `fetchRequestMetadata()` | Retry with fallback gateways |
| Claim conflict | `tryClaim()` | Skip request, try next |
| Agent timeout | `runGeminiWithTelemetry()` | 15 min process timeout |
| Nonce collision | `deliverViaSafeTransaction()` | Exponential backoff retry |
| RPC failure | `isUndeliveredOnChain()` | Fallback to Ponder verification |
