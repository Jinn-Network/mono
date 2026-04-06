---
title: Execution Phases
purpose: context
scope: [worker, gemini-agent]
last_verified: 2026-01-30
related_code:
  - worker/orchestration/jobRunner.ts
  - gemini-agent/agent.ts
  - worker/metadata/fetchIpfsMetadata.ts
  - worker/delivery/transaction.ts
  - worker/execution/runAgent.ts
  - worker/status/inferStatus.ts
  - worker/worker_telemetry.ts
keywords: [phases, initialization, agent, git, delivery, telemetry, jobRunner]
when_to_read: "When tracing job execution flow or debugging phase-specific failures"
---

# Execution Phases

The job runner (`processOnce` in `worker/orchestration/jobRunner.ts`) orchestrates job execution through six core phases.

## Phase Overview

| Phase | Function | Purpose | Failure Behavior |
|-------|----------|---------|------------------|
| Initialization | `fetchIpfsMetadata`, `ensureRepoCloned`, `checkoutJobBranch` | Load metadata, set up workspace | Aborts job |
| Agent Execution | `runAgentForRequest` | Execute LLM agent with tools | Captures partial telemetry |
| Git Operations | `autoCommitIfNeeded`, `pushJobBranch`, `createBranchArtifact` | Commit and push code changes | Updates status to FAILED |
| Reporting | `storeOnchainReport` | Store execution report via Control API | Logged only |
| Delivery | `deliverViaSafeTransaction` | Submit result to blockchain | Triggers parent dispatch |
| Telemetry Persistence | `createArtifact` | Store worker telemetry artifact | Non-critical |

## Phase Details

### 1. Initialization

**Telemetry phase:** `initialization`

Fetches job metadata from IPFS and prepares the workspace:

1. `fetchIpfsMetadata(ipfsHash)` - Retrieves blueprint, tools, codeMetadata from IPFS gateway (7s timeout)
2. Model normalization via `normalizeGeminiModel()`
3. Environment injection from `additionalContext.env`
4. Workspace bootstrap from `additionalContext.workspaceRepo` (root jobs only)
5. `ensureRepoCloned()` - Clones repository if not present
6. `checkoutJobBranch()` - Creates or checks out job branch
7. `ensureGitignore()`, `ensureBeadsInit()` - Set up repo tooling
8. Dependency branch sync via `syncWithBranch()` for jobs with dependencies

Checkpoints logged: `metadata_fetched`, `workspace_repo_bootstrap`, `repo_clone`, `branch_checkout`, `dependency_sync`

### 2. Agent Execution

**Telemetry phase:** `agent_execution`

Runs the main LLM agent:

1. `waitForGeminiQuota()` - Waits if quota exhausted (with retry loop)
2. `runAgentForRequest()` builds prompt via `BlueprintBuilder`
3. `Agent.run()` spawns Gemini CLI with:
   - Tool policy computed via `computeToolPolicy()`
   - MCP server configuration from settings template
   - Loop protection (5MB max stdout, 15min timeout)
4. `consolidateArtifacts()` - Collects artifacts from tool calls
5. `inferJobStatus()` - Determines COMPLETED/FAILED/DELEGATING/WAITING
6. `computeMeasurementCoverage()` - Tracks blueprint acceptance criteria coverage

Status inference rules:
- **FAILED**: Error occurred
- **DELEGATING**: Dispatched children this run
- **WAITING**: Has undelivered or non-terminal children
- **COMPLETED**: All children complete or no children

### 3. Git Operations

**Telemetry phase:** `git_operations`

Commits and pushes code changes:

1. `deriveCommitMessage()` - Generates commit message from execution summary
2. `autoCommitIfNeeded()` - Stages and commits changes
3. `pushJobBranch()` - Pushes to remote
4. `createBranchArtifact()` - Creates artifact with branch URL for COMPLETED jobs

Checkpoints: `auto_commit`, `push`, `branch_artifact_created`

### 4. Reporting

**Telemetry phase:** `reporting`

Stores execution report via Control API:

1. `inferJobStatus()` - Re-infers if not already set
2. `storeOnchainReport()` - Posts report with status, tokens, tools, output

### 5. Delivery

**Telemetry phase:** `delivery`

Submits result to blockchain via Safe:

1. `verifyUndeliveredStatus()` - Checks RPC then Ponder for delivery status
2. `buildDeliveryPayload()` - Constructs on-chain payload
3. `deliverViaSafe()` - Submits via Safe multisig (with nonce retry logic)
4. `wasRequestRevoked()` - Checks for revocation events
5. `dispatchParentIfNeeded()` - Triggers parent job re-execution if needed

Retry strategy: Exponential backoff (15s, 30s, 60s, 120s, 240s) for nonce issues.

### 6. Telemetry Persistence

**Telemetry phase:** `telemetry_persistence`

Stores final worker telemetry:

1. `telemetry.getLog()` - Snapshots all phase events
2. `createArtifact()` - Stores as WORKER_TELEMETRY artifact
3. Registers with Control API for indexing

#### Worker Telemetry Architecture

The `WorkerTelemetryService` (`worker/worker_telemetry.ts`) captures operational data separate from agent execution telemetry:

**What's captured:**
- Phase transitions with timestamps and durations
- Checkpoints at critical stages (metadata fetch, branch checkout, delivery)
- Error events with context
- Tool call metrics (counts, success/failure, durations)

**Storage:**
- Uploaded to IPFS as `WORKER_TELEMETRY` artifact
- Included in delivery payload's `workerTelemetry` field
- Indexed by Control API for querying

**Inspection:**
- Explorer UI: Navigate to `/requests/{requestId}` → "Worker Telemetry" card
- Shows execution timeline, phase details, and raw JSON

## Phase Transitions

```
Initialization ──► Agent Execution ──► Git Operations ──► Reporting ──► Delivery ──► Telemetry Persistence
```

Error handling varies by phase:
- **Hard failures** (Initialization): Job aborts, no delivery
- **Soft failures** (Telemetry Persistence): Logged, execution continues
- **Status failures** (Git Operations): Status set to FAILED, delivery proceeds
- **Delivery failures**: Already-delivered is benign; revocation triggers warning

---

## Optional Context Phases

These phases are controlled by `BLUEPRINT_ENABLE_CONTEXT_PHASES` (default: `false`).
Currently experimental and disabled by default.

| Phase | Purpose | Status |
|-------|---------|--------|
| Recognition | Find similar jobs, extract learnings for prompt | Experimental |
| Reflection | Create memory artifacts from execution | Experimental |
| Situation Creation | Store context for vector similarity search | Experimental |

When disabled (`BLUEPRINT_ENABLE_CONTEXT_PHASES=false`), these phases are skipped with no impact on core job execution. The phases run between Agent Execution and Git Operations when enabled.
