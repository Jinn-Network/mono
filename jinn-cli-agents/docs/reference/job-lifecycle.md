---
title: Job Lifecycle Reference
purpose: reference
scope: [worker]
last_verified: 2026-01-30
related_code:
  - worker/orchestration/jobRunner.ts
  - worker/status/index.ts
  - worker/status/autoDispatch.ts
  - ponder/ponder.schema.ts
keywords: [job status, PENDING, COMPLETED, FAILED, DELEGATING, WAITING, lifecycle]
when_to_read: "Use when debugging job status, understanding why a job is stuck, or implementing status transitions"
---

# Job Lifecycle Reference

Quick reference for job status values, transitions, and inference logic.

---

## Job Status Values

| Status | Meaning | What to Check |
|--------|---------|---------------|
| `PENDING` | Waiting for worker pickup | Worker not running, or job has unmet dependencies |
| `DELEGATING` | Dispatched children, waiting for them | Check child job status |
| `WAITING` | Has delivered but children still working | Check child completion |
| `COMPLETED` | Successfully finished | All work done |
| `FAILED` | Encountered unrecoverable error | Check error in telemetry |

---

## Status Interpretation

### PENDING

**Not a failure** - just means the job is queued but no worker has claimed it yet.

Common reasons:
- Worker not running
- Worker busy with other jobs
- Job has unmet dependencies (waiting for other jobs to complete)

**Action:** Start a worker or wait for dependencies.

### DELEGATING

Job dispatched child jobs and is waiting for them to complete.

**Action:** Check child job status. Parent will auto-redispatch when children complete.

### WAITING

Job has delivered its result but has children still in progress.

**Action:** Wait for children to complete.

### COMPLETED

Job finished successfully. Check delivery for results.

### FAILED

Job encountered an error. Check telemetry for error details.

---

## Status Transitions

```
PENDING → (worker claims) → Executing
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
              No children          Has children
                    ↓                   ↓
              COMPLETED            DELEGATING
                                       ↓
                              (children complete)
                                       ↓
                               (verification)
                                       ↓
                                 COMPLETED
```

---

## Status Inference Logic

Status is inferred from delivery content and child state:

1. **No delivery** → `PENDING`
2. **Has delivery, status in content** → Use that status
3. **Has delivery, has children not all complete** → `DELEGATING` or `WAITING`
4. **Has delivery, all children complete** → `COMPLETED`

**Note:** There can be Ponder indexing latency. Status may appear stale for ~30 seconds after events.

---

## Job Definition vs Job Run

**Job Definition** (`jobDefinitionId`)
- The template/blueprint for a job
- Can have multiple runs (executions)
- Identified by UUID

**Job Run** (`requestId`)
- A single execution of a job definition
- Has its own delivery, telemetry, artifacts
- Identified by 0x hash

---

## Workstream Hierarchy

```
Workstream (root request)
  └── Job Definition A
      ├── Run 1 (request 0x123...)
      ├── Run 2 (request 0x456...) [verification]
      └── Run 3 (request 0x789...) [loop_recovery]
  └── Job Definition B (child of A)
      └── Run 1 (request 0xabc...)
```

- Workstream = tree of jobs rooted at initial request
- Jobs can have multiple runs (retries, verification, recovery)
- Children inherit from parent's tool whitelist

---

## Checking Job Status

**Workstream overview:**
```bash
yarn inspect-workstream <workstream-id>
```

**Specific job definition history:**
```bash
yarn inspect-job <job-def-id>
```

**Specific job run details:**
```bash
yarn inspect-job-run <request-id>
```

---

## Related Documentation

- Dispatch types: `docs/reference/dispatch-types.md`
- Parent-child flow: `docs/context/parent-child-flow.md`
- Work protocol: `docs/guides/work-protocol.md`
