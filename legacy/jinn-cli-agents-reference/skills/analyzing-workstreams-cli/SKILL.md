---
name: analyzing-workstreams-cli
description: Debugs failed workstreams using CLI inspection scripts. Activates when investigating job failures, analyzing workstream errors, or answering "why did this workstream fail?" For interactive coding agents with shell access.
allowed-tools: Bash Read Grep
---

# Workstream Analysis Skill (CLI)

Debugs a workstream to identify why jobs failed and what can be done to fix them.

## Quick Facts

- **PENDING**: Skip - not a failure, awaiting worker pickup
- **DELEGATING**: Check child job status instead
- **0% coverage on single job**: Normal for orchestrator jobs that delegate
- **0% coverage on entire workstream**: Problem - no invariants measured
- **Recovery dispatches**: Normal auto-recovery; check if later runs succeeded

## Documentation References

| Issue Type | Reference |
|------------|-----------|
| UNAUTHORIZED_TOOLS errors | [TOOL_POLICY.md](references/TOOL_POLICY.md) |
| Dispatch types / recovery | [DISPATCH_TYPES.md](references/DISPATCH_TYPES.md) |
| Job status questions | [JOB_LIFECYCLE.md](references/JOB_LIFECYCLE.md) |
| Error codes | [ERROR_CODES.md](references/ERROR_CODES.md) |
| Artifacts / measurements | [ARTIFACTS.md](references/ARTIFACTS.md) |

## Workflow

Copy this checklist and track your progress:

```
Analysis Progress:
- [ ] Step 1: Triage - get workstream overview
- [ ] Step 1b: Investigate tool errors (if any)
- [ ] Step 2: Focus on failures
- [ ] Step 3: Trace root cause
- [ ] Step 4: Deep dive into root cause job
- [ ] Step 5: Check context/invariants (if relevant)
- [ ] Step 6: Analyze and propose fix
```

### Step 1: Triage - Get Overview

```bash
yarn inspect-workstream <workstream-id> --show-all --format=summary
```

Note:
- **Failure rate**: FAILED vs COMPLETED count (ignore PENDING)
- **Error distribution**: Which phases have errors?
- **Dispatch pattern**: Verification loops, recovery attempts, cycles?
- **Anomalous run counts**: Job with 9 runs vs 1-3 for others → check for `[loop_recovery]` or `[timeout_recovery]` tags

If no FAILED jobs, check Failed Tool Calls and Anomalous run counts. If no issues, report "No failures detected" and stop.

### Step 1b: Investigate Tool Errors

Tool errors in completed jobs still indicate issues. For UNAUTHORIZED_TOOLS errors:

1. Identify the job that made the failing `dispatch_new_job` call
2. Get telemetry: `yarn inspect-job-run <request-id> --format=json`
3. Check if using individual tool names instead of meta-tools:
   - `telegram_send_message` → Should be `telegram_messaging`
   - `fireflies_search` → Should be `fireflies_meetings`
4. Trace back to source blueprint - did instructions specify wrong tool names?
5. Determine root cause: blueprint error, missing template tools, or hallucination

For other tool failures: check if retried successfully (transient) or failed repeatedly (investigate).

### Step 2: Focus on Failures

```bash
yarn inspect-workstream <workstream-id> --status=failed --show-all --raw --format=json
```

Identify: failed jobs, error messages, dispatch chain root.

### Step 3: Trace Root Cause

Find the **deepest failed job** in the chain (earliest failure). Root cause is usually:
- First job that failed
- Job whose failure caused downstream failures
- NOT the leaf job that inherited a failure

### Step 4: Deep Dive into Root Cause Job

```bash
yarn inspect-job-run <request-id> --format=summary
```

For full telemetry:
```bash
yarn inspect-job-run <request-id> --format=json
```

Check: status, errors, failed tool calls, timing, measurement coverage, git operations, token usage.

**Key principle**: Check the agent's input (blueprint/prompt in `request.ipfsContent`) to understand its behavior. The fix is often upstream in the dispatching blueprint.

### Step 5: Check Context/Invariants

If invariant-related issues:
- `measurementCoverage.coveragePercent` < 100%?
- `measurementCoverage.unmeasuredIds` - which invariants missed?
- Any `create_measurement` calls with `success: false`?

### Step 6: Analyze and Propose Fix

1. **What happened?** - Failure chain from root cause to final state
2. **Why?** - Root cause, not symptom ("Concurrent edits" not "Git conflict")
3. **Fix** - Specific, actionable steps
4. **Verify** - How to confirm fix worked

## Output Format

```
## Workstream Analysis: <workstream-id>

### Summary
- Status: X completed, Y failed, Z pending
- Affected jobs: <list>

### What Happened
<Failure chain narrative>

### Why It Failed
<Root cause analysis>

### Evidence
- <Error messages, request IDs, tool failures>
- <Telemetry findings>

### Tool Errors (if any)
- **Tool**: <name> in job <job>
- **Error**: <message>
- **Root cause**: <why>
- **Fix needed?**: Yes/No

### Recommended Fix
<Specific steps>

### How to Verify
<Confirmation steps>
```

## CLI Reference

```bash
# Overview
yarn inspect-workstream <id> --show-all --format=summary

# Failed only
yarn inspect-workstream <id> --status=failed --show-all --raw --format=json

# Job execution
yarn inspect-job-run <request-id> --format=summary

# Full telemetry
yarn inspect-job-run <request-id> --format=json

# Job history
yarn inspect-job <job-def-id> --format=summary
```

## Debugging Tips

- **Large workstreams**: `--status=failed` to focus on problems
- **Deep hierarchies**: `--depth=N` to limit tree depth
- **Full data**: `--raw` to see all errors without truncation
