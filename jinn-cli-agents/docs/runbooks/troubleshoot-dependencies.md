---
title: Troubleshoot Dependencies
purpose: runbook
scope: [worker]
last_verified: 2026-01-30
related_code:
  - worker/mech_worker.ts
  - gemini-agent/mcp/tools/dispatch_new_job.ts
keywords: [dependencies, job, blocked, circular, stale, redispatch, terminal-status]
when_to_read: "When jobs are blocked on dependencies, encountering circular dependency errors, or auto-recovery issues"
---

# Troubleshoot Dependencies

Debugging dependency resolution issues in the worker.

## Troubleshooting Table

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Dependencies not met - waiting" | Dependency job not in terminal status | Wait for dep to complete, or manually dispatch it |
| Job blocked >2h on dependency | Stale dependency (stuck in DELEGATING/WAITING/PENDING) | Enable auto-redispatch or manually re-dispatch |
| "Dependency job definition not found" | Dependency UUID doesn't exist in Ponder | Dispatch the missing dependency first |
| `CIRCULAR_DEPENDENCY` error | Child job depends on parent job | Remove parent from dependencies; children cannot depend on parents |
| `INVALID_DEPENDENCY_ID` error | Dependency is job name, not UUID | Use `get_details` or `search_jobs` to find the UUID |
| `MISSING_DEPENDENCY` error | Dependency not in Ponder after retries | Wait for indexer sync, or increase `JINN_DEPENDENCY_VALIDATION_RETRIES` |
| Job auto-cancelled after 2h | Missing dependency triggered auto-fail | Dispatch missing dep, or disable with `WORKER_DEPENDENCY_AUTOFAIL=0` |

## Terminal vs Non-Terminal Status

Jobs only proceed when dependencies reach **terminal status**:
- Terminal: `COMPLETED`, `FAILED`
- Non-terminal: `DELEGATING`, `WAITING`, `PENDING`, `IN_PROGRESS`

Check dependency status:
```bash
yarn inspect-job <dependency-job-definition-id>
```

## Auto-Recovery Configuration

### Stale Dependency Redispatch

When a dependency is stuck in a non-terminal status for too long:

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_DEPENDENCY_REDISPATCH` | `0` | Set to `1` to enable |
| `WORKER_DEPENDENCY_STALE_MS` | `7200000` | Stale threshold (2 hours) |
| `WORKER_DEPENDENCY_REDISPATCH_COOLDOWN_MS` | `3600000` | Cooldown between redispatches (1 hour) |

Redispatchable statuses: `DELEGATING`, `WAITING`, `PENDING`

### Missing Dependency Auto-Cancel

When a dependency doesn't exist in Ponder:

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_DEPENDENCY_AUTOFAIL` | `1` | Set to `0` to disable |
| `WORKER_DEPENDENCY_MISSING_FAIL_MS` | `7200000` | Wait time before auto-cancel (2 hours) |
| `WORKER_DEPENDENCY_CANCEL_COOLDOWN_MS` | `3600000` | Cooldown between cancel attempts (1 hour) |

### Dispatch-Time Validation

When dispatching new jobs with dependencies:

| Variable | Default | Description |
|----------|---------|-------------|
| `JINN_DEPENDENCY_VALIDATION_RETRIES` | `3` | Ponder query retries |
| `JINN_DEPENDENCY_VALIDATION_DELAY_MS` | `500` | Backoff delay between retries |
| `JINN_SKIP_DEPENDENCY_VALIDATION` | - | Set to `1` to skip (risky) |

## Circular Dependencies

Child jobs cannot depend on parent jobs. This creates deadlock:

```
Parent dispatches Child
  |
  v
Child depends on Parent --> BLOCKED
  |
  v
Parent waits for Child  --> DEADLOCK
```

Valid dependency patterns:
- Siblings depending on each other (execution order)
- Child depending on unrelated jobs

Invalid:
- Child depending on its own parent (detected at dispatch time)

## Diagnostic Commands

```bash
# Check job dependencies
yarn inspect-job <job-id> --show-dependencies

# View workstream dependency graph
yarn inspect-workstream <workstream-id> --show-all

# Enable auto-redispatch for stuck deps
WORKER_DEPENDENCY_REDISPATCH=1 yarn worker --workstream=<id>

# Force re-dispatch a stuck dependency manually
yarn dispatch-existing --job-id=<dependency-id>

# Check if dependency exists in Ponder
curl -s "$PONDER_GRAPHQL_URL" -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"{ jobDefinition(id: \"<uuid>\") { id lastStatus } }"}'
```

## Common Scenarios

### Scenario 1: Job stuck waiting

1. Find blocked job's dependencies from logs
2. Check each dependency's `lastStatus`
3. If non-terminal and stale, re-dispatch manually
4. Or enable `WORKER_DEPENDENCY_REDISPATCH=1`

### Scenario 2: Dispatch fails with MISSING_DEPENDENCY

1. Dependency may not be indexed yet (Ponder lag)
2. Increase retries: `JINN_DEPENDENCY_VALIDATION_RETRIES=5`
3. Increase delay: `JINN_DEPENDENCY_VALIDATION_DELAY_MS=1000`
4. Or verify the dependency UUID is correct

### Scenario 3: Jobs cancelled unexpectedly

1. Check if dependency was missing for >2h
2. Look for "Auto-cancelled request due to missing dependency" in logs
3. Either dispatch the missing dependency or disable auto-fail
