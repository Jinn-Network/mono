---
title: "Protocol Model"
---

# Jinn Protocol Model
## A Complete Picture of How the Protocol Works

This document provides a comprehensive, natural-language description of the Jinn protocol architecture, data flows, and key invariants. It is designed to be used for protocol verification and as a reference for understanding how all components interact.

---

## 1. Core Architecture

### 1.1 System Components

The Jinn protocol consists of six primary components that work together in an event-driven loop:

**On-Chain Layer (Base Network)**
- **MechMarketplace Contract**: Source of truth for job requests. Emits `MarketplaceRequest` events when new jobs are posted.
- **OlasMech (AgentMech) Contract**: Handles delivery of results. Emits `Deliver` events when workers submit results on-chain.
- **Gnosis Safe**: Worker identity. Each worker operates through a Safe multisig wallet (1/1 configuration with agent key as signer).

**Indexing Layer (Ponder)**
- Listens to on-chain events from MechMarketplace and OlasMech contracts
- Indexes job requests, deliveries, artifacts, and job hierarchies
- Exposes GraphQL API for reading on-chain state (`http://localhost:42069/graphql` locally, hosted on Railway in production)
- Detects and indexes SITUATION artifacts for semantic search

**Worker Layer**
- **Mech Worker** (`worker/mech_worker.ts`): Single active worker process that polls Ponder, claims work, executes jobs, and delivers results
- Runs continuously in a `processOnce()` loop with adaptive polling (30s base, up to 5min max with 1.5x backoff when idle)
- Each iteration processes one job from discovery to delivery

**Agent Execution Layer**
- **Agent Class** (`gemini-agent/agent.ts`): Spawns Gemini CLI subprocess for each job execution
- **Gemini CLI**: Runs Google's Gemini models with configured tools
- **MCP Server** (`gemini-agent/mcp/server.ts`): Model Context Protocol server providing tools to agents
- Per-job isolation: Each execution gets fresh settings, enabled tools list, and job context

**Control API Layer**
- GraphQL gateway (`control-api/server.ts`) for secure writes to off-chain database
- Validates all writes against on-chain state via Ponder
- Enforces worker identity via ERC-8128 signed requests
- Provides atomic operations: claim requests, create reports, create artifacts, create messages

**Data Persistence Layer**
- **Ponder Schema** (PostgreSQL): On-chain event index - `request`, `delivery`, `artifact`, `jobDefinition`, `message` tables
- **Supabase** (PostgreSQL): Off-chain operational data - `onchain_request_claims`, `onchain_job_reports`, `onchain_artifacts`, `onchain_messages` tables
- **node_embeddings** (PostgreSQL with pgvector): Situation embeddings for semantic similarity search (256-dimensional vectors)
- **IPFS**: Content-addressed storage for job prompts, delivery payloads, artifacts

### 1.2 Data Flow Architecture

```
1. Job Creation
   User/Agent → MCP Tool (dispatch_new_job) → MechMarketplace Contract → MarketplaceRequest Event

2. Indexing
   MarketplaceRequest Event → Ponder Handler → Ponder DB (request, jobDefinition tables)
                                            → Fetch IPFS metadata

3. Job Claiming
   Worker Poll → Ponder GraphQL (fetch unclaimed) → Control API (claimRequest mutation)
              → Supabase (onchain_request_claims)

4. Execution
   Worker → Agent.run() → Gemini CLI Process → MCP Tools → Telemetry Collection

5. Recognition (Pre-execution)
   Worker → Create Initial Situation → Embed Text → Search node_embeddings (pgvector)
        → Fetch Similar Situations from IPFS → Inject Learnings into Prompt

6. Delivery
   Worker → Push JSON to IPFS → deliverViaSafe() → OlasMech.deliver() → Deliver Event

7. Completion Indexing
   Deliver Event → Ponder Handler → Update request.delivered = true
                                 → Parse delivery JSON from IPFS
                                 → Index artifacts (including SITUATION)
                                 → Store SITUATION embedding in node_embeddings
```

---

## 2. Job Lifecycle

### 2.1 Job States and Transitions

A job (request) progresses through these states:

```
UNCLAIMED → IN_PROGRESS → {COMPLETED, FAILED, DELEGATING, WAITING}
                          ↓
                       DELIVERED (on-chain)
```

**State Definitions:**
- **UNCLAIMED**: Request exists on-chain, not yet claimed by any worker
- **IN_PROGRESS**: Worker has claimed the request (stored in `onchain_request_claims`)
- **COMPLETED**: Job finished successfully with no undelivered children
- **FAILED**: Job encountered an error during execution
- **DELEGATING**: Job dispatched child jobs this run
- **WAITING**: Job has undelivered children from previous runs
- **DELIVERED**: Result submitted on-chain via `OlasMech.deliver()`

**Status Inference:**
The worker automatically determines job status based on observable signals:
- **FAILED**: If execution throws an error
- **DELEGATING**: If agent called `dispatch_new_job` or `dispatch_existing_job` this run
- **WAITING**: If job has any undelivered children (from any run)
- **COMPLETED**: If job has no undelivered children (either never delegated, or all delivered)

Only `COMPLETED` and `FAILED` are terminal states that trigger parent job dispatch.

**Cyclic Jobs:**
Jobs can be marked as cyclic via `cyclic: true` in IPFS metadata. Cyclic jobs behave differently:
- After reaching a terminal state (COMPLETED or FAILED), the worker automatically re-dispatches the job
- This creates a continuous operation mode where ventures run indefinitely
- Each cycle is a new request with its own delivery, but shares the same jobDefinitionId
- Used by long-running ventures like content operations that need to execute periodically
- The status `CYCLE_COMPLETE` is emitted via Control API to distinguish from final completion

### 2.2 processOnce() Function Flow

The main worker loop executes this sequence for each job:

1. **Fetch Unclaimed Requests**: Query Ponder GraphQL for recent, unclaimed, undelivered requests for this worker's mech address
   - **Dependency Filtering**: Worker checks if request has `dependencies` field; if present, verifies all dependency requests are delivered before proceeding
2. **Claim Request**: Call Control API `claimRequest` mutation (idempotent, atomic)
3. **Fetch IPFS Metadata**: Retrieve job prompt, model, enabledTools, jobDefinitionId, sourceJobDefinitionId, codeMetadata, **blueprint**, **dependencies** from IPFS
4. **Initialization**: Checkout job branch, ensure repo is cloned
5. **Recognition Phase**: Create initial situation, search for similar past jobs via vector search, inject learnings into prompt (graceful degradation if fails)
   - **5a. Progress Checkpointing** (if workstream has completed jobs): Query Ponder for all delivered requests in the same workstream, fetch their delivery summaries, generate progress checkpoint, inject into prompt prefix
6. **Agent Execution**: Run Agent with enhanced prompt and enabled tools
   - **Blueprint Context**: If job has `blueprint` in metadata, it is injected into agent context; agent processes blueprint directly without external fetching
7. **Status Inference**: Determine job status based on error state, dispatch calls, and child job delivery status
8. **Reporting**: Store job report via Control API
9. **Reflection Phase**: Run lightweight reflection agent to identify learnings, create MEMORY artifacts if valuable
10. **Situation Creation**: Build SITUATION artifact with job context, execution trace, embedding vector
11. **Code Operations** (if applicable): Auto-commit changes, push branch
12. **PR Creation** (if COMPLETED): Automatically create GitHub pull request
13. **Telemetry Persistence**: Upload worker telemetry as artifact
14. **Delivery**: Push result JSON to IPFS, call `deliverViaSafe()` to submit on-chain
    - **14a. Structured Summary Extraction**: Worker extracts clean, structured summary from agent output (looking for "Work Completed", "Key Decisions" sections) and includes in delivery as `structuredSummary` field

**Error Handling:**
- Execution errors are caught and persisted in telemetry
- Worker continues after errors (doesn't crash on single job failure)
- Gemini CLI transport failures after successful completion are detected and handled gracefully

### 2.3 Job Hierarchy and Work Protocol

Jobs can create hierarchical relationships through delegation:

**Hierarchy Structure:**
```
Root Job (sourceJobDefinitionId: null)
  ├─ Child Job 1 (sourceJobDefinitionId: root_id)
  │   ├─ Grandchild 1.1
  │   └─ Grandchild 1.2
  └─ Child Job 2
      └─ Grandchild 2.1
```

**Relationship Tracking:**
- `jobDefinitionId`: The job container being executed (persistent across re-runs)
- `sourceJobDefinitionId`: Parent job that created this job (lineage)
- `sourceRequestId`: Parent request that dispatched this request

**Homomorphic Job Runs:**

Job runs are homomorphic. Root jobs follow the exact same execution logic as child jobs and possess no special responsibilities or distinct behaviors. All jobs, regardless of their position in the hierarchy, follow the same Work Protocol and make autonomous decisions about completion, delegation, or waiting based solely on their blueprint assertions.

**Work Protocol Rules:**
1. Agent queries `get_details` or `search_artifacts` to understand hierarchy position
2. Agent decides: complete directly, delegate to children, or wait for children
3. When a child reaches terminal state (COMPLETED/FAILED), parent is automatically re-dispatched
4. Parent jobs synthesize child results when all children are delivered

**Context Fetching:**
The worker queries Ponder using `jobDefinitionId_in` (not `sourceJobDefinitionId_in`) to find all requests for the same job definition across re-runs. This ensures root jobs can see completed children when re-running.

**Parent Re-dispatch Rules:**

*Trigger Condition:*
- Child job reaches terminal state (COMPLETED or FAILED)
- Parent job definition ID exists in child's metadata (sourceJobDefinitionId)

*Workstream Preservation:*
- Parent re-dispatch inherits child's workstreamId via explicit metadata field
- All jobs in delegation chain share same workstream root
- Ponder prioritizes explicit workstreamId in IPFS metadata over sourceRequestId traversal
- This ensures workstream ID remains stable across parent re-runs

*Deduplication:*
- Parent is dispatched once per child completion
- In-memory guard prevents duplicate dispatches from same child within 30-second cooldown window
- Multiple children completing trigger multiple parent dispatches (expected behavior for synthesis)
- Each parent dispatch includes child request ID in logging for traceability

### 2.4 Blueprint-Driven Execution

Jobs receive structured JSON blueprints in their metadata using a **four-type invariant schema**. Each invariant has a specific type that determines how it's measured and validated:

```json
{
  "invariants": [
    {
      "id": "QUAL-001",
      "type": "FLOOR",
      "metric": "content_quality_score",
      "min": 70,
      "assessment": "Rate 0-100 based on originality and depth"
    },
    {
      "id": "COST-001",
      "type": "CEILING",
      "metric": "compute_cost_usd",
      "max": 20,
      "assessment": "Sum API costs from telemetry"
    },
    {
      "id": "FREQ-001",
      "type": "RANGE",
      "metric": "posts_per_week",
      "min": 3,
      "max": 7,
      "assessment": "Count posts published in last 7 days"
    },
    {
      "id": "BUILD-001",
      "type": "BOOLEAN",
      "condition": "Build passes without errors",
      "assessment": "Run yarn build and verify exit code is 0"
    }
  ]
}
```

**Invariant Types:**

| Type | Fields | Pass Condition | Use Case |
|------|--------|----------------|----------|
| `FLOOR` | `metric`, `min` | measured_value ≥ min | Minimum quality thresholds |
| `CEILING` | `metric`, `max` | measured_value ≤ max | Cost/time limits |
| `RANGE` | `metric`, `min`, `max` | min ≤ measured_value ≤ max | Frequency constraints |
| `BOOLEAN` | `condition` | condition is true | Binary success criteria |

**Validation:**
- Blueprint must be valid JSON
- Must contain `invariants` array with at least one invariant
- Each invariant requires: `id`, `type`, `assessment`, and type-specific fields
- Validation occurs at dispatch time via `dispatch_new_job` tool
- Invalid blueprints return error codes: `INVALID_BLUEPRINT`, `INVALID_BLUEPRINT_STRUCTURE`

**Frontend Display:**
Blueprints are rendered in the explorer by parsing the JSON and displaying invariants with:
- Visual indicators for pass/fail status
- Measured values compared against thresholds
- Assessment criteria for transparency

**Dispatch Flow:**
1. Parent job calls `dispatch_new_job` with `blueprint` parameter (JSON string)
2. Blueprint is stored in IPFS metadata under `additionalContext.blueprint`
3. Worker fetches metadata and injects blueprint into agent context
4. Agent receives blueprint as structured data, processes invariants directly

**Measurement Flow:**
1. Agent reads all invariants in the blueprint
2. Plans work that satisfies all invariants
3. Executes work using available tools
4. Calls `create_measurement` for each quantifiable invariant
5. Worker validates measurements against invariant thresholds
6. Results displayed in explorer with pass/fail indicators

**Benefits:**
- Precise success criteria with measurable thresholds
- Visual dashboard for invariant compliance
- Historical tracking of measurement trends
- Clear failure diagnosis when invariants are violated

**Example Dispatch:**
```typescript
await dispatch_new_job({
  jobName: "Build feature X with quality gates",
  blueprint: JSON.stringify({
    invariants: [
      { id: "TEST-001", type: "FLOOR", metric: "test_coverage", min: 80, assessment: "Run coverage report" },
      { id: "PERF-001", type: "CEILING", metric: "load_time_ms", max: 3000, assessment: "Measure page load time" },
      { id: "IMPL-001", type: "BOOLEAN", condition: "All acceptance criteria met", assessment: "Verify feature works as specified" },
    ]
  }),
  // ... other params
});
```

### 2.5 Dependency Management

Jobs can specify prerequisite jobs that must complete before execution begins, enabling complex orchestration and sequencing.

**Dependency Declaration:**
```typescript
await dispatch_new_job({
  objective: "Deploy frontend after backend is ready",
  dependencies: ["0xabc123...", "0xdef456..."], // Backend + DB migration job IDs
  // ... other params
});
```

**IPFS Metadata Storage:**
- `dependencies` array stored in `additionalContext.dependencies`
- Contains request IDs (on-chain identifiers) of prerequisite jobs

**Ponder Schema:**
```typescript
request: {
  // ... existing fields
  dependencies: p.string().list().optional(), // Array of request IDs
}
```

**Worker Enforcement:**
1. Worker fetches candidate requests from Ponder
2. For each request, checks if `dependencies` field exists
3. If dependencies present:
   - Queries Ponder for dependency request status
   - Skips job if any dependency is not yet delivered
   - Logs: `"Skipping request {id}: dependencies not met"`
4. If no dependencies or all delivered, proceeds with execution

**Use Cases:**
- Sequential build pipelines (test → build → deploy)
- Multi-stage migrations (schema → data → validation)
- Coordinated launches (backend → frontend → docs)
- Complex venture workflows (research → design → implement → review)

**Failure Handling:**
- If dependency job fails, dependent job remains in queue
- Parent can dispatch cleanup or alternative path jobs
- No automatic cancellation (allows manual intervention)

### 2.6 Progress Checkpointing

Before executing a job, the worker builds a progress checkpoint from completed work in the same workstream, enabling agents to be aware of prior accomplishments and avoid redundant work.

**Workstream Context:**
- **Workstream**: All jobs sharing the same root `jobDefinitionId`
- **Root Job**: Job with `sourceJobDefinitionId: null`
- **Workstream ID**: The request ID of the root job (indexed by Ponder as `workstreamId`)

**Checkpoint Building (Recognition Phase):**
1. Worker identifies the workstream root via `sourceJobDefinitionId` chain
2. Queries Ponder for all delivered requests in workstream:
   ```graphql
   requests(where: { workstreamId: $rootId, delivered: true })
   ```
3. Fetches delivery payloads from IPFS for each completed job
4. Extracts final output summaries (first 500 chars or `structuredSummary` if available)
5. Generates progress summary markdown:
   ```markdown
   ## Work Stream Progress (N jobs completed)
   
   - {jobName} ({timestamp}): {summary}
   - {jobName} ({timestamp}): {summary}
   ...
   ```

**Prompt Injection:**
```markdown
---
## Work Stream Context

{progress summary}

---
## Recognition Learnings

{semantic search learnings}

---

# Your Task

{original job prompt}
```

**Semantic Filtering (Optional Enhancement):**
Instead of including all completed jobs, filter for relevance:
1. Generate embedding for current job objective
2. Generate embeddings for all completed job summaries
3. Calculate cosine similarity scores
4. Include top-10 most relevant completed jobs
5. Reduces noise, focuses agent on contextually similar work

**Benefits:**
- Agents understand venture state before acting
- Eliminates redundant work (sees what's already done)
- Enables synthesis jobs (combining child results)
- Provides continuity across job re-runs

**Example Use Case:**
```
Root job: "Implement Olas website venture"
  ├─ Child 1: "Add LICENSE file" [COMPLETED]
  ├─ Child 2: "Setup CI/CD" [COMPLETED]
  └─ Child 3: "Add documentation" [IN_PROGRESS]

Child 3's prompt includes:
- Summary of LICENSE addition
- Summary of CI/CD setup
- Knows not to re-do these tasks
```

---

## 3. Agent Execution

### 3.1 Agent Operating Principles

The agent operates under a comprehensive set of principles embedded in the prompt and tool configuration:

**Core Principles:**
- **Autonomy**: Agents act without seeking permission or asking questions
- **Non-interactive Mode**: Agents cannot wait for user responses
- **Tool-Based Interaction**: Tools are the only interface with the environment
- **Factual Grounding**: Agents only use verifiable information from tools (no hallucination)
- **Work Decomposition**: Complex tasks are broken into manageable sub-tasks via delegation

**Work Protocol Phases:**
1. **Contextualize & Plan**: Understand goal, survey hierarchy, review prior work
2. **Decide & Act**: Complete directly, delegate, wait for children, or fail with error
3. **Report**: Produce execution summary describing what was accomplished

**Status Determination:**
Status is automatically inferred by the worker based on agent actions (not manually signaled by agent).

**Code Workflow:**
- Branch is pre-created by dispatcher: `job/[jobDefinitionId]-[slug]`
- Agent commits changes using conventional commit format (`feat:`, `fix:`, etc.)
- Worker auto-pushes commits and creates PR when job reaches COMPLETED state
- If agent forgets to commit, worker auto-commits using execution summary as message

**Universal Tools Always Available:**
- `create_artifact`: Upload content to IPFS
- `dispatch_new_job`: Create new job definitions
- `dispatch_existing_job`: Continue work in existing job containers
- `get_details`: Retrieve detailed on-chain records by ID and hierarchy context
- `search_jobs`: Search job definitions
- `search_artifacts`: Search artifacts by name, topic, content to find child work
- `list_tools`: Introspection of tools enabled for the current workstream

Native Gemini CLI tools (file operations, web search) are excluded by default unless explicitly enabled in job's `enabledTools` list.

### 3.2 Agent Class Implementation

**Execution Flow:**
1. Generate per-job MCP settings at `gemini-agent/.gemini/settings.json`
2. Spawn Gemini CLI subprocess with `--model`, `--yolo`, `--prompt` flags
3. Send prompt via stdin (non-interactive mode prevents "Please continue" loops)
4. Monitor stdout/stderr with loop protection:
   - Max 5MB total output
   - Max 100KB chunk size
   - Repetition detection: Same line 10+ times in 20-line window = loop
5. Collect telemetry from `--telemetry-outfile`
6. Parse tool calls, token usage, duration from telemetry JSON
7. Return `{ output, telemetry }` or throw `{ error, telemetry }`

**Loop Protection:**
If runaway output detected:
- Process is killed
- Partial output and telemetry are preserved
- Error is thrown with `LOOP_DETECTED` type

**Settings Generation:**
- Dev mode (`USE_TSX_MCP=1`): Run MCP server via `tsx gemini-agent/mcp/server.ts`
- Prod mode: Run built `dist/gemini-agent/mcp/server.js`
- Settings include only universal tools + job's `enabledTools`
- Native Gemini CLI tools are excluded unless explicitly enabled

### 3.3 MCP Tools Architecture

**Tool Registration Flow:**
1. MCP server imports tools from `gemini-agent/mcp/tools/index.ts`
2. Each tool exports `{ schema, handler }`
3. Server calls `server.registerTool(name, schema, handler)` for each tool
4. Tools are prefixed with `mcp_` automatically by MCP protocol

**Core Tool Categories:**

**Universal Tools (always available):**
- Job Management: `dispatch_new_job`, `dispatch_existing_job`, `get_details`, `search_jobs`, `search_artifacts`
- Artifact Management: `create_artifact`, `search_artifacts`
- Data Retrieval: `get_details` (queries Ponder for on-chain records)
- Introspection: `list_tools`

**Code Tools (available in code jobs):**
- `get_file_contents`: Read files from GitHub repo
- `search_code`: Search code in GitHub repo
- `list_commits`: List recent commits

**Search Tools (when enabled):**
- `google_web_search`: Web search via Google
- `web_fetch`: Fetch URL content

**Memory Tools (always available for recognition/reflection):**
- `search_similar_situations`: Vector search over past job situations
- `inspect_situation`: Inspect memory system for a given request
- `embed_text`: Generate text embeddings

**Blog Tools (for content ventures):**
- `blog_create_post`: Create and publish new blog posts
- `blog_list_posts`: List existing posts in the repository
- `blog_get_post`: Retrieve full content of a specific post
- `blog_get_stats`: Get site analytics (pageviews, visitors)
- `blog_get_performance_summary`: Comprehensive stats with top pages and referrers

**Telegram Tools (for messaging ventures):**
- `telegram_send_message`: Send messages to configured channels
- `telegram_send_photo`: Send images with captions

**Template Tools (for marketplace integration):**
- `register_template`: Publish a reusable job template to the x402 marketplace
- `create_measurement`: Record invariant measurements for evaluation

**Tool Response Format:**
All tools return JSON in this structure:
```json
{
  "content": [{
    "type": "text",
    "text": "{\"data\": {...}, \"meta\": {\"ok\": true}}"
  }]
}
```

---

## 4. Learning and Memory System

### 4.1 Semantic Graph Search (JINN-233)

The protocol features a situation-centric learning system that performs semantic similarity search over entire job execution contexts.

**SITUATION Artifact Structure:**
```json
{
  "version": "sit-enc-v1.1",
  "job": {
    "requestId": "0x...",
    "jobName": "...",
    "jobDefinitionId": "uuid",
    "model": "gemini-2.5-flash",
    "objective": "...",
    "acceptanceCriteria": "...",
    "enabledTools": [...]
  },
  "context": {
    "parent": { "requestId": "...", "jobDefinitionId": "..." },
    "siblings": [...],
    "children": [...]
  },
  "execution": {
    "status": "COMPLETED",
    "trace": [
      { "tool": "web_fetch", "args": "...", "result_summary": "..." }
    ],
    "finalOutputSummary": "..."
  },
  "artifacts": [
    { "topic": "research", "name": "...", "contentPreview": "..." }
  ],
  "embedding": {
    "model": "text-embedding-3-small",
    "dim": 256,
    "vector": [0.123, ...]
  },
  "meta": {
    "summaryText": "...",
    "recognition": { "similarJobs": [...] },
    "generatedAt": "2024-..."
  }
}
```

**Write Path (Situation Creation):**
1. After job completion, worker calls `createSituationArtifactForRequest()`
2. If recognition ran, enrich initial situation with execution data; otherwise encode full situation
3. Generate embedding vector via `embed_text` MCP tool (256-dim, text-embedding-3-small)
4. Assemble complete SITUATION artifact with embedding
5. Upload to IPFS via `create_artifact` MCP tool (topic: "SITUATION", type: "SITUATION")
6. Add to delivery payload artifacts array
7. Worker delivers result on-chain

**Indexing Path:**
8. Ponder detects `Deliver` event, fetches delivery JSON from IPFS
9. For each artifact with `type: "SITUATION"`, fetch artifact from IPFS
10. Extract embedding vector, summary, and metadata
11. Upsert into `node_embeddings` table with pgvector extension
12. Create ivfflat index for cosine similarity search

**Read Path (Recognition Phase):**
1. Before job execution, worker runs `runRecognitionPhase()`
2. Create initial situation representation (job metadata only, no execution)
3. Generate embedding for initial situation summary
4. Query `node_embeddings` via `search_similar_situations` MCP tool (top-5 cosine similarity)
5. For each match, fetch full SITUATION artifact from IPFS
6. Extract relevant learnings: successful strategies, common pitfalls, tool patterns
7. Format learnings as markdown and prepend to job prompt
8. If recognition fails, proceed without learnings (graceful degradation)

**Database Schema:**
```sql
CREATE TABLE node_embeddings (
  node_id TEXT PRIMARY KEY,           -- Request ID
  model TEXT NOT NULL,                 -- "text-embedding-3-small"
  dim INTEGER NOT NULL,                -- 256
  vec VECTOR(256) NOT NULL,            -- Embedding vector
  summary TEXT,                        -- Searchable summary
  meta JSONB DEFAULT '{}',             -- Full situation metadata
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX node_embeddings_vec_idx
  ON node_embedings USING ivfflat (vec vector_cosine_ops)
  WITH (lists = 100);
```

**Observability:**
- CLI: `yarn tsx scripts/memory/inspect-situation.ts <requestId>` - Rich CLI output showing SITUATION details
- MCP: `inspect_situation` tool provides programmatic access
- Frontend: Memory visualization on delivered request detail pages
- Full snapshot: `yarn inspect-job-run <requestId>` - Complete job run data with resolved IPFS

### 4.2 MEMORY Artifacts (JINN-231)

A complementary tag-based memory system for creating and reusing insights:

**Core Loop: Reflect → Create → Find → Use**

1. **Reflection (After Job)**: Separate reflection agent reviews job output and telemetry
2. **Creation**: If valuable insights identified, agent calls `create_artifact` with `type: "MEMORY"` and relevant `tags`
3. **Discovery (Before Job)**: Worker extracts keywords from `jobName`
4. **Injection**: Worker searches Ponder for `MEMORY` artifacts with matching tags, fetches content from IPFS, injects into prompt

**MEMORY Artifact Schema:**
```json
{
  "name": "staking_contract_analysis_learnings",
  "topic": "learnings",
  "type": "MEMORY",
  "tags": ["staking", "contract-analysis", "olas"],
  "content": "Markdown-formatted learnings..."
}
```

**Indexing:**
Ponder indexes MEMORY artifacts with `type` and `tags` fields, enabling tag-based search via `search_artifacts`.

**Validation Status: ✅ VALIDATED**
- Memory creation confirmed: Reflection step creates MEMORY artifacts with correct type and tags
- Memory reuse confirmed: Subsequent jobs discover and inject relevant memories
- Intelligent use confirmed: Agent can decide not to use injected memory if not directly applicable

---

## 5. Data Persistence

### 5.1 Storage Layer Differentiation

**On-Chain (Base Network):**
- Job requests (MarketplaceRequest events)
- Delivery confirmations (Deliver events)
- Immutable, permanent, source of truth

**Ponder Index (PostgreSQL):**
- `request`: On-chain requests with IPFS metadata resolved
- `delivery`: On-chain deliveries with delivery IPFS resolved
- `artifact`: Artifacts extracted from delivery payloads
- `jobDefinition`: Job definitions with lineage
- `message`: Messages between jobs
- Read-only from application perspective (Ponder writes)

**Control API / Supabase (PostgreSQL):**
- `onchain_request_claims`: Worker claims (prevents duplicate work)
- `onchain_job_reports`: Job execution reports with telemetry
- `onchain_artifacts`: Supplementary artifact records (Control API writes only)
- `onchain_messages`: Inter-job messages (Control API writes only)
- All writes require ERC-8128 signed requests and on-chain validation

**node_embeddings (PostgreSQL with pgvector):**
- Situation embeddings for semantic similarity search
- Written by Ponder when indexing SITUATION artifacts
- Queried by `search_similar_situations` MCP tool

**IPFS (Content-Addressed Storage):**
- Job prompts (uploaded by `dispatch_new_job`)
- Delivery payloads (uploaded by worker before on-chain delivery)
- Artifact content (uploaded by `create_artifact`)
- SITUATION artifacts (uploaded during situation creation)
- MEMORY artifacts (uploaded during reflection)
- Immutable, content-addressed, distributed

### 5.2 Data Lineage

Every piece of data is linked back to its originating on-chain request:

**Lineage Fields:**
- `requestId`: The on-chain request that produced this data
- `sourceRequestId`: Parent request in job hierarchy
- `jobDefinitionId`: The job container being executed
- `sourceJobDefinitionId`: Parent job definition

**Enforcement:**
- Control API validates `requestId` exists in Ponder before allowing writes
- Worker automatically injects lineage when calling Control API
- Ponder extracts lineage from IPFS metadata when indexing

**Auditability:**
- All off-chain writes are linked to an on-chain request
- Worker address is recorded for all operations
- Complete chain of custody from request → claim → execution → delivery

### 5.3 IPFS Delivery Architecture

**Upload Process:**
1. Worker assembles delivery JSON:
   ```json
   {
     "requestId": "0x...",
     "output": "Agent's final output",
     "telemetry": {...},
     "artifacts": [{cid, name, topic, type, contentPreview}],
     "workerTelemetry": {...},
     "recognition": {...},
     "reflection": {...},
     "pullRequestUrl": "https://github.com/..."
   }
   ```
2. Upload to Autonolas IPFS registry with `wrap-with-directory: true`
3. IPFS returns directory CID (e.g., `bafybeihkn34x...`)
4. Worker extracts SHA256 digest from CID structure
5. Worker posts 32-byte digest to `OlasMech.deliver()` on-chain

**On-Chain Storage:**
Only the SHA256 digest is stored on-chain (not the full CID). This is gas-efficient.

**Ponder Reconstruction:**
1. Ponder reads digest from `Deliver` event
2. Reconstructs directory CID using dag-pb codec (0x70) + base32 encoding
3. Fetches: `https://gateway.autonolas.tech/ipfs/{reconstructed-dir-CID}/{requestId}`
4. Parses delivery JSON and extracts artifacts array

**Common Testing Mistake:**
❌ Wrong: `https://gateway.autonolas.tech/ipfs/f01551220{digest}` (returns binary directory structure)
✅ Correct: `https://gateway.autonolas.tech/ipfs/{dir-CID}/{requestId}` (returns JSON file)

**Frontend API Considerations:**
Frontend must reconstruct directory CID from `f01551220` hash to fetch delivery data correctly.

---

## 6. OLAS Integration

### 6.1 On-Chain Identity

Each worker operates through a Gnosis Safe multisig wallet on Base network:

**Key Hierarchy:**
1. **Master Wallet (EOA)**: Creates and deploys Safes, encrypted in `olas-operate-middleware/.operate/wallets/`
2. **Agent Key**: Stored in `olas-operate-middleware/.operate/keys/`, becomes signer on Safe multisig (1/1 configuration)
3. **Service Safe**: On-chain smart contract wallet controlled by agent key

**Relationship:**
- Master Wallet creates multiple Safes (one per service deployment)
- Each Safe is independent with its own agent key signer
- Agent keys are stored globally and survive service deletion
- Deleting a service does NOT delete agent keys

**Configuration Source:**
All addresses are read from `.operate` profile via `env/operate-profile.ts`:
- `getMechAddress()`: Returns mech address from service config
- `getServiceSafeAddress()`: Returns Safe address from service config
- `getServicePrivateKey()`: Returns agent key private key

**IMPORTANT:** Never hardcode addresses. Always use `env/operate-profile.ts` functions to ensure consistency.

### 6.2 Service Setup Flow

**Interactive Setup (JINN-202):**
```bash
yarn setup:service --chain=base [--with-mech]
```

Setup wizard uses middleware's native attended mode:
1. Detects or reuses existing Master EOA/Safe
2. Shows native funding prompts with exact amounts
3. Auto-continues when funding detected (no manual "continue" needed)
4. Handles complete lifecycle in one atomic operation
5. Total time: 5-10 minutes

**Hierarchy Created:**
1. Master Wallet (EOA): Requires ~0.002 ETH for gas
2. Master Safe: Requires ~0.002 ETH + 100 OLAS
3. Agent Key: Generated during service creation
4. Service Safe: Requires ~0.001 ETH + 50 OLAS

**Testing on Tenderly (JINN-204):**
```bash
yarn test:tenderly  # Full integration test (staking + mech)
```

Automated script:
1. Creates Tenderly Virtual TestNet (forked Base mainnet)
2. Updates `env.tenderly` with VNet credentials
3. Deploys service with specified configuration
4. Verifies staking state on-chain
5. Provides Tenderly dashboard link for inspection

### 6.3 Mech Deployment

Services can have mechs deployed automatically during creation:

```typescript
const serviceInfo = await serviceManager.deployAndStakeService(undefined, {
  deployMech: true,
  mechType: 'Native',
  mechRequestPrice: '10000000000000000', // 0.01 ETH
  mechMarketplaceAddress: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020'
});
```

**Flow:**
1. Service manager injects mech env vars into service config
2. Middleware detects empty `AGENT_ID` and `MECH_TO_CONFIG`
3. Middleware's `deploy_mech()` function runs during service deployment
4. Mech address and agent ID returned in service info

**Configuration:**
- **mechType**: 'Native' (default), 'Token', or 'Nevermined'
- **mechRequestPrice**: Price per request in wei
- **mechMarketplaceAddress**: Base mainnet: `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020`

---

## 7. Key Invariants

### 7.1 Data Integrity Invariants

1. **On-Chain Source of Truth**: All jobs originate from MarketplaceRequest events. Off-chain data is always linked to an on-chain request.

2. **Atomic Claiming**: A request can only be claimed by one worker at a time (enforced by Control API with `onConflict: 'request_id'`).

3. **Lineage Preservation**: Every artifact, report, and message maintains a chain of custody via `requestId`, `sourceRequestId`, `jobDefinitionId`, `sourceJobDefinitionId`.

4. **IPFS Immutability**: All content (prompts, deliveries, artifacts) is content-addressed and immutable once uploaded.

5. **Status Inference Consistency**: Job status is always derived from observable signals (errors, dispatches, child delivery status), never manually set.

### 7.2 Execution Invariants

1. **Non-Interactive Mode**: Agents never pause for user input. All execution is autonomous.

2. **Tool Isolation**: Agents only have access to tools specified in job's `enabledTools` plus universal tools. Native Gemini CLI tools are excluded by default.

3. **Loop Protection**: Agent execution terminates if stdout exceeds 5MB, chunks exceed 100KB, or lines repeat 10+ times in 20-line window.

4. **Graceful Degradation**: Recognition failure does not block job execution. Job proceeds without learnings.

5. **Telemetry Preservation**: Even when agent execution fails, telemetry is preserved and persisted for debugging.

### 7.3 Hierarchy Invariants

1. **Root Job Identity**: Root jobs have `sourceJobDefinitionId: null`. They maintain launcher briefings.

2. **Parent Dispatch on Completion**: When child reaches terminal state (COMPLETED/FAILED), parent is automatically re-dispatched.

3. **Context Accumulation**: Job containers (`jobDefinitionId`) accumulate context across re-runs. All requests for same job definition share the same container.

4. **Delegation Independence**: Each job in hierarchy makes autonomous decisions about completion, delegation, or waiting.

5. **Status Propagation**: Terminal child status (COMPLETED/FAILED) triggers parent re-dispatch, but non-terminal status (DELEGATING/WAITING) does not.

### 7.4 Memory System Invariants

1. **Embedding Consistency**: All SITUATION embeddings use same model (text-embedding-3-small) and dimension (256) for comparable similarity search.

2. **Recognition Before Execution**: Recognition phase always runs before agent execution (unless disabled via env var).

3. **Situation Creation Post-Delivery**: SITUATION artifacts are created for all terminal states (COMPLETED and FAILED) to enable learning from failures.

4. **Semantic Search Independence**: Recognition failures do not block job execution. System degrades gracefully.

5. **Memory Artifact Indexing**: MEMORY artifacts with correct `type` and `tags` are indexed by Ponder for tag-based discovery.

### 7.5 Delivery Invariants

1. **On-Chain Finality**: Delivery is only confirmed when `Deliver` event is emitted on-chain.

2. **Directory CID Structure**: Delivery IPFS uploads always use `wrap-with-directory: true`, resulting in directory CID structure.

3. **Ponder Reconstruction**: Ponder always reconstructs directory CID from on-chain digest to fetch delivery JSON.

4. **Artifact Array Completeness**: Delivery payload includes all artifacts created during execution, including SITUATION, MEMORY, and WORKER_TELEMETRY.

5. **Telemetry Inclusion**: Worker telemetry is always included in delivery payload as both artifact and top-level field.

---

## 8. Observability

### 8.1 Three Levels of Observability

As specified in `requirements.md`, the protocol maintains three levels of observability:

**Human (Frontends):**
- Explorer UI at `https://indexer.jinn.network/`
- Request detail pages with full job history, artifacts, telemetry
- Memory visualization showing SITUATION details and similar jobs
- Job hierarchy graphs showing parent/child relationships

**Programmatic (Scripts):**
- `yarn inspect-job-run <requestId>`: Complete job snapshot with resolved IPFS
- `yarn tsx scripts/memory/inspect-situation.ts <requestId>`: Situation memory inspection
- `yarn tsx scripts/check-agent-balances.ts`: Scan agent keys for OLAS balances
- Various validation scripts in `scripts/` directory

**Agentic (MCP Tools):**
- `get_details`: Retrieve on-chain records by ID
- `get_details` and `search_artifacts`: Retrieve hierarchy context and metadata
- `inspect_situation`: Inspect memory system for a given request
- `search_similar_situations`: Vector search over past situations
- `search_artifacts`: Search artifacts by name, topic, content
- `search_jobs`: Search job definitions

### 8.2 Telemetry Structure

**Agent Telemetry (Gemini CLI):**
```json
{
  "totalTokens": 12345,
  "toolCalls": [
    {
      "tool": "web_fetch",
      "args": {...},
      "duration_ms": 1234,
      "success": true,
      "result": {...}
    }
  ],
  "duration": 5678,
  "errorMessage": "...",
  "errorType": "PROCESS_ERROR",
  "raw": {
    "lastApiRequest": {...},
    "stderrWarnings": "...",
    "partialOutput": "..."
  }
}
```

**Worker Telemetry:**
```json
{
  "startTime": "2024-...",
  "endTime": "2024-...",
  "totalDuration_ms": 12345,
  "phases": [
    {
      "name": "initialization",
      "startTime": "...",
      "endTime": "...",
      "duration_ms": 123,
      "events": [
        {
          "type": "checkpoint",
          "name": "metadata_fetched",
          "timestamp": "...",
          "metadata": {...}
        }
      ]
    }
  ]
}
```

Both telemetries are persisted: agent telemetry in job report, worker telemetry as WORKER_TELEMETRY artifact and in delivery payload.

---

## 9. Critical Implementation Details

### 9.1 Gemini CLI Integration

**Non-Interactive Mode Configuration:**
- Use `--prompt` flag to enable non-interactive mode
- Send prompt via stdin AND --prompt flag
- This prevents "Please continue" loops where CLI pauses for user input

**Telemetry Collection:**
- Use `--telemetry true --telemetry-target local --telemetry-outfile /tmp/telemetry-{unique}.json`
- Telemetry file contains: tool calls, token usage, request/response text
- Parse telemetry after process exit to extract structured data

**Settings Generation:**
- Per-job settings at `gemini-agent/.gemini/settings.json`
- Settings include only universal tools + job's enabledTools
- Dev vs prod templates differ in MCP server command (tsx vs node)
- Worker deletes settings file after job completion (cleanup)

### 9.2 Control API Security Model

**Worker Identity:**
- All requests require ERC-8128 signed headers (`signature-input`, `signature`, `content-digest`)
- Worker address is verified from the signature and recorded in database
- Used for auditability and access control

**On-Chain Validation:**
- Before any write, Control API queries Ponder to verify `requestId` exists
- If request not found in Ponder, write is rejected
- Ensures off-chain data is always linked to valid on-chain requests

**Idempotency:**
- `claimRequest` mutation is idempotent via `onConflict: 'request_id'`
- Multiple calls with same requestId return existing claim
- Prevents race conditions between workers

**Atomic Operations:**
- Each mutation is a single database transaction
- Either succeeds completely or fails completely
- No partial state corruption

### 9.3 Recognition Phase Implementation

**Initial Situation Creation:**
```typescript
const { situation, summaryText } = await createInitialSituation({
  requestId, jobName, jobDefinitionId, model, additionalContext
});
```

Creates lightweight situation with only job metadata (no execution data yet).

**Vector Search:**
```typescript
const vectorResults = await searchSimilarSituations({
  query_text: summaryText,
  k: 5
});
```

Queries `node_embeddings` table via pgvector cosine similarity.

**Artifact Fetching:**
For each match, worker fetches full SITUATION artifact from IPFS to extract execution patterns and learnings.

**Prompt Enhancement:**
```typescript
if (recognition?.promptPrefix) {
  metadata.prompt = `${recognition.promptPrefix}\n\n${originalPrompt}`;
}
```

Prepends learnings markdown to original prompt.

**Graceful Failure:**
```typescript
try {
  recognition = await runRecognitionPhase(...);
} catch (error) {
  workerLogger.warn('Recognition failed, continuing without learnings');
}
```

Recognition failure does not block execution.

### 9.4 Situation Artifact Creation

**Encoding Flow:**
1. If initial situation exists (from recognition), enrich it with execution data
2. Otherwise, encode full situation from scratch
3. Generate embedding vector for summary text (256-dim)
4. Assemble complete SITUATION artifact with embedding
5. Upload to IPFS via `create_artifact` MCP tool
6. Add to delivery payload artifacts array

**Embedding Generation:**
```typescript
const embedding = await generateEmbeddingVector(
  summaryText,
  'text-embedding-3-small',
  256
);
```

Uses OpenAI text-embedding-3-small model with 256 dimensions (matches database VECTOR(256) type).

**Summary Text Composition:**
Summary includes: job name, objective, acceptance criteria, execution status, tool calls (up to 15), final output (truncated to 1200 chars).

### 9.5 Ponder SITUATION Indexing

**Detection:**
```typescript
if (artifact.type === 'SITUATION') {
  // Index embedding
}
```

Ponder checks `type` field on each artifact in delivery payload.

**IPFS Fetch:**
```typescript
const situationUrl = `${IPFS_GATEWAY_BASE}${artifact.cid}`;
const situationRes = await axios.get(situationUrl, { timeout: 8000 });
let situationData = situationRes.data;

// Unwrap if content field exists
if (situationData.content && typeof situationData.content === 'string') {
  situationData = JSON.parse(situationData.content);
}
```

Handles both raw and wrapped artifact formats.

**Database Insert:**
```sql
INSERT INTO node_embeddings (node_id, model, dim, vec, summary, meta)
VALUES ($1, $2, $3, $4::vector, $5, $6)
ON CONFLICT (node_id)
DO UPDATE SET
  model = EXCLUDED.model,
  dim = EXCLUDED.dim,
  vec = EXCLUDED.vec,
  summary = EXCLUDED.summary,
  meta = EXCLUDED.meta,
  updated_at = NOW();
```

Upsert operation allows re-indexing if needed.

---

## 10. Future Considerations

This model captures the current implementation as of the code review. Areas for future expansion:

1. **Multi-Worker Coordination**: How do multiple workers coordinate on shared resources?
2. **Failure Recovery**: What happens if worker crashes mid-execution?
3. **Rate Limiting**: How does the system handle RPC rate limits?
4. **Cost Management**: How are token costs tracked and optimized?
5. **Security Hardening**: What additional security measures are needed for mainnet?

These questions are out of scope for this document but should be addressed in future protocol iterations.

---

## Appendix: Component Reference Map

| Component | Location | Purpose |
|-----------|----------|---------|
| Worker | `worker/mech_worker.ts` | Main event loop, job execution orchestration |
| Agent | `gemini-agent/agent.ts` | Gemini CLI wrapper, telemetry collection |
| MCP Server | `gemini-agent/mcp/server.ts` | Tool registration, MCP protocol handler |
| Tools | `gemini-agent/mcp/tools/` | Individual tool implementations |
| Ponder | `ponder/src/index.ts` | Event indexing, SITUATION indexing |
| Ponder Schema | `ponder/ponder.schema.ts` | On-chain data schema |
| Control API | `control-api/server.ts` | Secure write gateway |
| Situation Encoder | `worker/situation_encoder.ts` | SITUATION artifact construction |
| Situation Artifact | `worker/situation_artifact.ts` | Embedding generation, IPFS upload |
| Recognition | `worker/recognition_helpers.ts` | Learnings extraction, prompt enhancement |
| Operate Profile | `env/operate-profile.ts` | Wallet/Safe address resolution |
| Agent Prompt Builder | `worker/prompt/BlueprintBuilder.ts` | Agent prompt construction |

---

**Document Version:** 1.0  
**Last Updated:** Based on codebase snapshot at time of analysis  
**Maintainer:** Jinn Protocol Team
