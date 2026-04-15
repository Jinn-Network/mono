---
title: Worker Environment
purpose: context
scope: [worker, gemini-agent]
last_verified: 2026-02-02
related_code:
  - worker/orchestration/jobRunner.ts
  - worker/metadata/jobContext.ts
  - worker/orchestration/env.ts
  - gemini-agent/shared/ipfs-payload-builder.ts
keywords: [environment, env vars, injection, inheritance, job context, JINN_INHERITED_ENV]
when_to_read: "When understanding how environment variables flow between jobs"
---

# Worker Environment

How the worker manages environment variables during job execution.

---

## Environment Injection Flow

When a job is claimed and executed:

```
Job Claimed
    │
    ▼
1. Snapshot current env
   (CODE_METADATA_REPO_ROOT, JINN_BASE_BRANCH)
    │
    ▼
2. Inject vars from metadata.additionalContext.env
   (skipping protected vars)
    │
    ▼
3. Store inherited vars as JINN_INHERITED_ENV (JSON)
    │
    ▼
4. Set JINN_* context vars
   (requestId, workstreamId, mechAddress, etc.)
    │
    ▼
5. Agent Executes
    │
    ▼
6. Restore original env snapshot
```

**Key files:**
- Step 1-3: `worker/orchestration/jobRunner.ts` (lines 68-118)
- Step 4: `worker/metadata/jobContext.ts`
- Step 6: `worker/orchestration/jobRunner.ts` (line 683)

---

## Protected Variables

These system variables are never overwritten by job metadata:

```
PATH, NODE_ENV, HOME, USER, SHELL
```

If `additionalContext.env` contains any of these, they are skipped with a warning.

---

## Parent→Child Inheritance

Environment variables propagate through the job hierarchy:

```
Parent Job
├── additionalContext.env: { API_KEY: "xxx", DEBUG: "1" }
│
└── Stored as JINN_INHERITED_ENV='{"API_KEY":"xxx","DEBUG":"1"}'
        │
        ▼
    Child dispatched via dispatch_new_job
        │
        ▼
    ipfs-payload-builder reads JINN_INHERITED_ENV
        │
        ▼
    Child's additionalContext.env = { API_KEY: "xxx", DEBUG: "1" }
        │
        ▼
    Grandchildren inherit the same way
```

**Key file:** `gemini-agent/shared/ipfs-payload-builder.ts` (lines 174-193)

```typescript
// Child inherits parent's env vars
const inheritedEnvJson = process.env.JINN_INHERITED_ENV;
if (inheritedEnvJson && !additionalContextOverrides?.env) {
  additionalContext.env = JSON.parse(inheritedEnvJson);
}
```

---

## Job Context Variables

The worker sets these `JINN_*` variables before agent execution:

| Variable | Type | Description |
|----------|------|-------------|
| `JINN_REQUEST_ID` | string | Current request ID |
| `JINN_MECH_ADDRESS` | address | Mech contract for this job |
| `JINN_JOB_DEFINITION_ID` | uuid | Job definition ID |
| `JINN_WORKSTREAM_ID` | string | Workstream identifier |
| `JINN_PARENT_REQUEST_ID` | string | Parent job's request ID |
| `JINN_BASE_BRANCH` | string | Git base branch |
| `JINN_BRANCH_NAME` | string | Git branch created for this job |
| `JINN_COMPLETED_CHILDREN` | JSON | Array of completed child request IDs |
| `JINN_CHILD_WORK_REVIEWED` | boolean | Whether child work has been reviewed |
| `JINN_REQUIRED_TOOLS` | JSON | Array of required tools from policy |
| `JINN_AVAILABLE_TOOLS` | JSON | Array of available tools from policy |
| `JINN_BLUEPRINT_INVARIANT_IDS` | JSON | Array of blueprint invariant IDs |
| `JINN_INHERITED_ENV` | JSON | Inherited env vars from parent |

**Key file:** `worker/metadata/jobContext.ts`

---

## Job Isolation

The snapshot/restore mechanism prevents context pollution between jobs:

1. **Before job:** Snapshot `CODE_METADATA_REPO_ROOT` and `JINN_BASE_BRANCH`
2. **During job:** All `JINN_*` vars set for this specific job
3. **After job:** Restore original values, clear job-specific vars

This ensures:
- Parent job context isn't corrupted by child execution
- Sequential jobs don't leak state
- Nested job execution works correctly

**Key file:** `worker/orchestration/env.ts`

---

## Common Patterns

### Passing API Keys to Child Jobs

Set in the root job's IPFS payload:

```json
{
  "additionalContext": {
    "env": {
      "CUSTOM_API_KEY": "xxx"
    }
  }
}
```

All descendants inherit automatically via `JINN_INHERITED_ENV`.

### Checking Parent Context

```typescript
const parentRequestId = process.env.JINN_PARENT_REQUEST_ID;
const isRootJob = !parentRequestId;
```

### Accessing Inherited Env

```typescript
const inherited = process.env.JINN_INHERITED_ENV;
if (inherited) {
  const vars = JSON.parse(inherited);
  // vars.API_KEY, vars.DEBUG, etc.
}
```

---

## Related Docs

- [Environment Variables Reference](../reference/environment-variables.md) - Full variable list
- [Parent-Child Flow](parent-child-flow.md) - Job hierarchy execution
- [IPFS Payload Structure](../reference/ipfs-payload-structure.md) - Payload format
