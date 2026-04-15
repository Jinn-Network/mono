---
title: Dependency Resolution Reference
purpose: reference
scope: [worker, gemini-agent]
last_verified: 2026-01-30
related_code:
  - worker/mech_worker.ts
  - worker/orchestration/jobRunner.ts
  - worker/git/branch.ts
  - gemini-agent/mcp/tools/dispatch_new_job.ts
keywords: [dependencies, job ordering, resolution, branch merging]
when_to_read: "When understanding how job dependencies are resolved and enforced"
---

# Dependency Resolution Reference

## Overview

Job dependencies control execution ordering between sibling jobs within a workstream. A job with dependencies will not execute until all dependency jobs reach terminal status (`COMPLETED` or `FAILED`).

## Dependency Format Quick Lookup

| Format | Example | Resolution |
|--------|---------|------------|
| UUID | `4eac1570-7980-4e2b-afc7-3f5159e99ea5` | Direct job definition ID lookup |
| Job Name | `setup-infrastructure` | Workstream-scoped name resolution via Ponder |

## Resolution Flow

```
dispatch_new_job(dependencies: [...])
        │
        ▼
┌───────────────────────────┐
│  UUID Format Check        │
│  UUID_REGEX.test(dep)     │
└───────────────────────────┘
        │
   ┌────┴────┐
   │         │
  UUID     Name
   │         │
   ▼         ▼
┌─────┐   ┌──────────────────────┐
│ Use │   │ resolveJobDefinitionId│
│as-is│   │ (workstreamId, name) │
└─────┘   └──────────────────────┘
              │
              ▼
       ┌──────────────────────┐
       │ Query Ponder:        │
       │ requests(workstreamId,│
       │   jobName) → jobDefId│
       └──────────────────────┘
```

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `validateDependencies()` | `dispatch_new_job.ts:159` | Validate UUIDs exist in Ponder |
| `checkDependenciesMet()` | `mech_worker.ts:627` | Check all deps are terminal |
| `resolveJobDefinitionId()` | `mech_worker.ts:521` | Resolve name → UUID within workstream |

### Validation Error Codes

| Code | Cause |
|------|-------|
| `INVALID_DEPENDENCY_ID` | Not a valid UUID |
| `MISSING_DEPENDENCY` | Job definition not found in Ponder |
| `CIRCULAR_DEPENDENCY` | Child depends on parent job |

### Dependency Status Actions

| Status | Action |
|--------|--------|
| `COMPLETED` / `FAILED` | Proceed (terminal) |
| `DELEGATING` / `WAITING` / `PENDING` | Wait (non-terminal) |
| Not found | Auto-cancel if enabled |

### Workstream Scoping

Same job name resolves to different UUIDs in different workstreams:
```
Workstream A: "setup" → job-def-abc123
Workstream B: "setup" → job-def-xyz789
```

## Branch Merging for Dependencies

Worker merges dependency branches into job's branch during initialization.

Source: `worker/orchestration/jobRunner.ts:222-309`

```
For each dependency:
  1. getDependencyBranchInfo() → get branch name from Ponder
  2. syncWithBranch()          → merge into job branch
     ├── Success: continue
     └── Conflict: store in additionalContext.mergeConflicts
```

| Sync Result | Action |
|-------------|--------|
| Clean merge | Continue execution |
| Conflicts | Agent resolves (files in `conflictingFiles`) |
| Branch not found | No-op, continue |

## Stale Dependency Recovery

Source: `worker/mech_worker.ts:261-365`

| Condition | Action | Config Variable |
|-----------|--------|-----------------|
| Dep stuck > 2h | Auto-redispatch (if enabled) | `WORKER_DEPENDENCY_STALE_MS` |
| Dep missing > 2h | Auto-cancel (if enabled) | `WORKER_DEPENDENCY_MISSING_FAIL_MS` |

**Redispatchable statuses:** `DELEGATING`, `WAITING`, `PENDING`

## Circular Dependency Prevention

**File:** `gemini-agent/mcp/tools/dispatch_new_job.ts` (lines 433-451)

### Blocked Pattern

```
Parent Job (job-def-parent)
    │
    └── dispatches Child Job
            │
            └── depends on job-def-parent  ← CIRCULAR_DEPENDENCY
```

### Validation

```typescript
// Line 433-451
const parentJobDefinitionId = context.jobDefinitionId;
if (parentJobDefinitionId && dependencies.includes(parentJobDefinitionId)) {
  return { code: 'CIRCULAR_DEPENDENCY', ... };
}
```

**Error Message:**
> Child job cannot depend on its parent job. This creates a deadlock: parent waits for children, children wait for parent. Dependencies should only be between sibling jobs (other children) to control execution order.

### Valid Dependency Patterns

```
       Parent
      /      \
   Child A   Child B
              │
              └── depends on Child A  ← VALID (siblings)
```

## Environment Variable Reference

| Variable | Default | Location | Purpose |
|----------|---------|----------|---------|
| `JINN_DEPENDENCY_VALIDATION_RETRIES` | 3 | dispatch_new_job.ts | Ponder query retries |
| `JINN_DEPENDENCY_VALIDATION_DELAY_MS` | 500 | dispatch_new_job.ts | Retry backoff delay |
| `JINN_SKIP_DEPENDENCY_VALIDATION` | - | dispatch_new_job.ts | Skip validation (risky) |
| `WORKER_DEPENDENCY_STALE_MS` | 7200000 | mech_worker.ts | Stale threshold |
| `WORKER_DEPENDENCY_REDISPATCH` | 0 | mech_worker.ts | Enable auto-redispatch |
| `WORKER_DEPENDENCY_REDISPATCH_COOLDOWN_MS` | 3600000 | mech_worker.ts | Redispatch cooldown |
| `WORKER_DEPENDENCY_MISSING_FAIL_MS` | 7200000 | mech_worker.ts | Missing dep threshold |
| `WORKER_DEPENDENCY_CANCEL_COOLDOWN_MS` | 3600000 | mech_worker.ts | Cancel cooldown |
| `WORKER_DEPENDENCY_AUTOFAIL` | 1 | mech_worker.ts | Enable auto-cancel |

