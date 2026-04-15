---
title: IPFS Payload Structure Reference
purpose: reference
scope: [worker, gemini-agent]
last_verified: 2026-02-07
related_code:
  - gemini-agent/mcp/tools/dispatch_new_job.ts
  - gemini-agent/shared/ipfs-payload-builder.ts
  - worker/metadata/fetchIpfsMetadata.ts
  - worker/types.ts
  - ponder/src/index.ts
keywords: [ipfs, payload, metadata, blueprint, lineage, code metadata, model policy, allowedModels]
when_to_read: "When understanding job payload structure or debugging IPFS data"
---

# IPFS Payload Structure

Jobs are dispatched on-chain with an IPFS hash pointing to a JSON payload. This document defines the complete schema.

## Payload Overview

Built by `buildIpfsPayload()` in `gemini-agent/shared/ipfs-payload-builder.ts`. Consumed by worker via `fetchIpfsMetadata()`.

```
gemini-agent/shared/ipfs-payload-builder.ts  -->  IPFS  -->  worker/metadata/fetchIpfsMetadata.ts
                                                            |
                                                            v
                                                  ponder/src/index.ts (indexing)
```

## Root-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `blueprint` | `string` | Yes | JSON string containing invariants array. Primary job specification. |
| `jobName` | `string` | Yes | Human-readable name for the job. |
| `jobDefinitionId` | `string` | Yes | UUID identifying this job definition. |
| `model` | `string` | No | Gemini model (e.g., `"gemini-2.5-pro"`). Default: `"gemini-3-flash"`. |
| `allowedModels` | `string[]` | No | Model allowlist cascaded from blueprint/workstream. Child agents inherit this constraint. |
| `enabledTools` | `string[]` | No | Tool names available to the agent. |
| `tools` | `TemplateToolSpec[]` | No | Annotated tool specs with `{name, required}` for policy enforcement. |
| `nonce` | `string` | Yes | UUID for request uniqueness. |
| `networkId` | `string` | Yes | Always `"jinn"`. Used by Ponder to filter non-Jinn requests. |
| `dependencies` | `string[]` | No | Job definition UUIDs that must complete before execution. |
| `cyclic` | `boolean` | No | If `true`, job re-dispatches after completion (continuous operation). |
| `inputSchema` | `object` | No | JSON Schema for template defaults (x402 gateway). |

## Blueprint Structure

The `blueprint` field is a JSON string validated by `blueprintStructureSchema`:

```typescript
{
  "invariants": [
    {
      "id": "string",           // Unique ID (e.g., "QUAL-001")
      "type": "FLOOR|CEILING|RANGE|BOOLEAN",
      "assessment": "string",   // How to measure/verify (min 10 chars)
      // Type-specific fields:
      "metric": "string",       // FLOOR/CEILING/RANGE only
      "min": number,            // FLOOR/RANGE only
      "max": number,            // CEILING/RANGE only
      "condition": "string",    // BOOLEAN only
      "examples": {             // Optional
        "do": ["string"],       // Positive examples
        "dont": ["string"]      // Negative examples
      }
    }
  ]
}
```

### Invariant Types

| Type | Required Fields | Semantics |
|------|-----------------|-----------|
| `FLOOR` | `metric`, `min` | metric >= min |
| `CEILING` | `metric`, `max` | metric <= max |
| `RANGE` | `metric`, `min`, `max` | min <= metric <= max |
| `BOOLEAN` | `condition` | condition must be true |

## Code Metadata (`codeMetadata`)

Captures git context for jobs that work with code. Collected by `collectLocalCodeMetadata()`.

| Field | Type | Description |
|-------|------|-------------|
| `branch.name` | `string` | Current branch name (e.g., `job/uuid-slug`). |
| `branch.headCommit` | `string` | HEAD commit SHA. |
| `branch.upstream` | `string?` | Upstream tracking ref. |
| `branch.remoteUrl` | `string?` | Normalized git remote URL. |
| `branch.status.isDirty` | `boolean` | Uncommitted changes present. |
| `branch.status.ahead` | `number?` | Commits ahead of upstream. |
| `branch.status.behind` | `number?` | Commits behind upstream. |
| `repo.remoteUrl` | `string?` | Git remote URL (SSH normalized to `git@github.com:`). |
| `baseBranch` | `string` | Branch this job branched from (default: `main`). |
| `capturedAt` | `string` | ISO timestamp when metadata was captured. |
| `jobDefinitionId` | `string` | Associated job definition. |
| `parent` | `CodeLineageRef?` | Parent job lineage (jobDefinitionId, requestId). |

## Lineage Tracking (`lineage`)

Tracks parent-child relationships in job hierarchy:

| Field | Type | Description |
|-------|------|-------------|
| `dispatcherRequestId` | `string?` | Request ID of the dispatching parent. |
| `dispatcherJobDefinitionId` | `string?` | Job definition ID of the dispatcher. |
| `parentDispatcherRequestId` | `string?` | Grandparent request ID. |
| `dispatcherBranchName` | `string?` | Branch the parent was working on. |
| `dispatcherBaseBranch` | `string?` | Base branch of the parent. |

Also at root level (for Ponder indexing):

| Field | Type | Description |
|-------|------|-------------|
| `sourceRequestId` | `string?` | Direct parent request ID. |
| `sourceJobDefinitionId` | `string?` | Direct parent job definition ID. |
| `workstreamId` | `string?` | Root request ID of the entire job tree. |

## Additional Context (`additionalContext`)

Rich context passed to the agent. Structured by `AdditionalContext` interface.

| Field | Type | Description |
|-------|------|-------------|
| `hierarchy` | `HierarchyJob[]?` | Array of jobs in the current hierarchy with status/artifacts. |
| `summary` | `HierarchySummary?` | Aggregated stats (totalJobs, completedJobs, etc.). |
| `message` | `WorkProtocolMessage?` | Message from parent to child job. |
| `env` | `Record<string,string>?` | Environment variables to inject (NOT for secrets). |
| `workspaceRepo` | `{url, branch?}?` | Repository to clone for root jobs (multi-tenant). |
| `mergeConflicts` | `{branch, files[]}[]?` | Conflicts from dependency branch merge (agent must resolve). |
| `stashedChanges` | `string[]?` | Files stashed before checkout from failed previous job. |
| `verificationRequired` | `boolean?` | Set when parent needs to verify merged child work. |
| `loopRecovery` | `object?` | Set when re-dispatched after loop protection terminated previous run. |
| `cycle` | `object?` | Set for cyclic job runs (cycleNumber, previousCycleRequestId). |

## Execution Policy (`executionPolicy`)

Added when a branch is created. Instructs the agent on branch requirements:

```typescript
{
  "branch": "job/uuid-slug",
  "ensureTestsPass": true,
  "description": "Agent must work on the provided branch..."
}
```

## Complete Example

```json
{
  "blueprint": "{\"invariants\":[{\"id\":\"BUILD-001\",\"type\":\"BOOLEAN\",\"condition\":\"Build passes without errors\",\"assessment\":\"Run yarn build and verify exit code is 0\"}]}",
  "jobName": "Fix authentication bug",
  "jobDefinitionId": "550e8400-e29b-41d4-a716-446655440000",
  "model": "gemini-2.5-pro",
  "allowedModels": ["gemini-3-flash", "gemini-3-pro-preview", "gemini-2.5-pro"],
  "enabledTools": ["read_file", "write_file", "run_shell_command"],
  "nonce": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "networkId": "jinn",
  "dependencies": ["660e8400-e29b-41d4-a716-446655440001"],
  "sourceRequestId": "12345678901234567890",
  "sourceJobDefinitionId": "770e8400-e29b-41d4-a716-446655440002",
  "workstreamId": "12345678901234567890",
  "lineage": {
    "dispatcherRequestId": "12345678901234567890",
    "dispatcherJobDefinitionId": "770e8400-e29b-41d4-a716-446655440002",
    "dispatcherBranchName": "job/770e8400-fix-parent"
  },
  "codeMetadata": {
    "branch": {
      "name": "job/550e8400-fix-auth-bug",
      "headCommit": "abc123def456",
      "remoteUrl": "git@github.com:org/repo.git",
      "status": { "isDirty": false, "ahead": 0, "behind": 0 }
    },
    "repo": { "remoteUrl": "git@github.com:org/repo.git" },
    "baseBranch": "job/770e8400-fix-parent",
    "capturedAt": "2025-01-15T10:30:00Z",
    "jobDefinitionId": "550e8400-e29b-41d4-a716-446655440000"
  },
  "additionalContext": {
    "hierarchy": [
      { "id": "770e8400-...", "name": "Parent Job", "status": "active" }
    ],
    "summary": { "totalJobs": 3, "completedJobs": 1, "activeJobs": 2 },
    "message": { "content": "Focus on the login flow", "to": "550e8400-..." }
  },
  "executionPolicy": {
    "branch": "job/550e8400-fix-auth-bug",
    "ensureTestsPass": true
  }
}
```

## Field Usage by Component

| Component | Fields Read | Purpose |
|-----------|-------------|---------|
| **Worker** | All fields | Full job execution |
| **Ponder** | `networkId`, `jobDefinitionId`, `jobName`, `blueprint`, `sourceRequestId`, `sourceJobDefinitionId`, `workstreamId`, `dependencies`, `codeMetadata`, `enabledTools` | Indexing for Explorer |
| **Agent** | `blueprint`, `enabledTools`, `codeMetadata`, `additionalContext` | Task execution |
| **dispatch_new_job** | Validates `blueprint`, builds `lineage`, `codeMetadata` | Child job creation |
