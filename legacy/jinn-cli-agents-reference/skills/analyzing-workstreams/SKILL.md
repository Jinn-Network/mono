---
name: analyzing-workstreams
description: Debugs failed workstreams by identifying root causes and proposing fixes. Activates when investigating job failures, analyzing workstream errors, tracing dispatch chains, or answering "why did this workstream fail?"
allowed-tools: Read Grep inspect_workstream inspect_job_run inspect_job get_details dispatch_new_job
---

# Workstream Analysis Skill

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
| Status model (detailed) | [JOB_STATUS_MODEL.md](references/JOB_STATUS_MODEL.md) |
| Error codes | [ERROR_CODES.md](references/ERROR_CODES.md) |
| Artifacts | [ARTIFACTS.md](references/ARTIFACTS.md) |
| Measurements / coverage | [MEASUREMENTS.md](references/MEASUREMENTS.md) |
| Job dependencies | [DEPENDENCIES.md](references/DEPENDENCIES.md) |
| IPFS payload structure | [IPFS_PAYLOAD.md](references/IPFS_PAYLOAD.md) |
| Ponder GraphQL queries | [PONDER_GRAPHQL.md](references/PONDER_GRAPHQL.md) |

## Tool Access

| MCP Tool | Purpose |
|----------|---------|
| `inspect_workstream` | Workstream overview, job tree, stats, errors |
| `inspect_job` | Job definition history and runs |
| `inspect_job_run` | Detailed single job execution data |

**Parameters:**

```
inspect_workstream:
  workstream_id: string (required)
  sections: ["errors", "timing", "tools", "dispatch", "git", "metrics"]
  status: "all" | "failed" | "pending" | "completed"
  limit: 1-200 (default 50)
  depth: 0-10

inspect_job_run:
  request_id: string (required) - 0x-prefixed
  include_artifacts: boolean (default true)
  include_telemetry: boolean (default true)
  resolve_ipfs: boolean (default true)

inspect_job:
  job_definition_id: string (required) - UUID
  include_runs: boolean (default true)
  max_runs: 1-50 (default 10)
  include_children: boolean (default true)
```

## Workflow

Copy this checklist and track your progress:

```
Analysis Progress:
- [ ] Step 1: Triage - get workstream overview
- [ ] Step 1b: Investigate tool errors (if any)
- [ ] Step 1c: Configuration introspection
- [ ] Step 1d: Categorize root causes
- [ ] Step 2: Focus on failures
- [ ] Step 3: Trace root cause
- [ ] Step 4: Deep dive into root cause job
- [ ] Step 4b: Delegate deep investigations
- [ ] Step 5: Check context/invariants (if relevant)
- [ ] Step 6: Synthesize findings and propose fix
```

### Step 1: Triage - Get Overview

```
inspect_workstream({
  workstream_id: "<workstream-id>",
  sections: ["errors", "timing", "tools"],
  status: "all"
})
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
2. Get telemetry: `inspect_job_run({ request_id: "<id>", include_telemetry: true })`
3. Check if using individual tool names instead of meta-tools:
   - `telegram_send_message` → Should be `telegram_messaging`
   - `fireflies_search` → Should be `fireflies_meetings`
4. Trace back to source blueprint - did instructions specify wrong tool names?
5. Determine root cause: blueprint error, missing template tools, or hallucination

For other tool failures: check if retried successfully (transient) or failed repeatedly (investigate).

### Step 1c: Configuration Introspection

For EACH detected issue, inspect the configuration that caused it:

1. **Fetch IPFS payload** - Use `get_details` with `ipfsHash` or `deliveryIpfsHash` to get blueprint, instructions, context
2. **Check job definition** - Via `inspect_job`, look at `enabledTools`, `dependencies`, `codeMetadata`
3. **Trace dispatch chain** - Follow `sourceJobDefinitionId` and `sourceRequestId` to find where configuration originated
4. **Check telemetry for env issues** - Missing API keys, wrong URLs, etc.

```
# Get IPFS payload for a job
get_details({ id: "<request-id>", include_ipfs_content: true })

# Check job definition
inspect_job({ job_definition_id: "<uuid>" })
```

### Step 1d: Root Cause Categories

Every issue MUST trace to one of these configuration sources:

| Category | Examples | How to Identify |
|----------|----------|-----------------|
| **Blueprint** | Wrong invariants, unclear instructions, missing outputSpec | Inspect IPFS payload, check invariant definitions |
| **Tool Policy** | Missing meta-tool, tool not in template whitelist | Check `enabledTools` in job definition, trace parent chain |
| **Environment** | Missing API keys, wrong URLs, timeout too low | Check telemetry for env-related errors |
| **Dispatch** | Wrong parameters, missing context, broken dependencies | Check dispatch payload, trace sourceRequestId chain |
| **Template** | Tool whitelist too restrictive, pricing issues | Check template definition if available |

**NOT acceptable**: "Job failed because X happened" - must explain what CONFIGURATION caused X.

### Step 2: Focus on Failures

```
inspect_workstream({
  workstream_id: "<workstream-id>",
  status: "failed",
  sections: ["errors", "timing", "tools", "dispatch"]
})
```

Identify: failed jobs, error messages, dispatch chain root.

### Step 3: Trace Root Cause

Find the **deepest failed job** in the chain (earliest failure). Root cause is usually:
- First job that failed
- Job whose failure caused downstream failures
- NOT the leaf job that inherited a failure

### Step 4: Deep Dive into Root Cause Job

```
inspect_job_run({
  request_id: "<request-id>",
  include_telemetry: true,
  include_artifacts: true,
  resolve_ipfs: true
})
```

Check: status, errors, failed tool calls, timing, measurement coverage, git operations, token usage.

**Key principle**: Check the agent's input (blueprint/prompt in `request.ipfsContent`) to understand its behavior. The fix is often upstream in the dispatching blueprint.

### Step 4b: Delegate Deep Investigations

For EACH detected issue, dispatch a "Root Cause Investigator" child job to trace the issue to its configuration source.

**When to delegate**: ALWAYS - every issue needs configuration-level tracing.

**Investigation Child Pattern**:
```
Parent (Triage): Detect issues → dispatch per-issue investigators → finalize
    ↓
Children (Investigate): Fetch configs → trace causation → report config source
    ↓
Parent (Synthesize): Collect child findings → produce final analysis with fixes
```

**Dispatch each investigator**:
```
dispatch_new_job({
  name: "Root Cause Investigator: <issue-summary>",
  blueprint: {
    invariants: [{
      id: "INVESTIGATE-001",
      type: "BOOLEAN",
      condition: "Trace this issue to its configuration source",
      assessment: "Must identify: (1) specific config that caused failure, (2) why it led to failure, (3) chain of causation, (4) recommended fix"
    }],
    context: "Issue: <description>\nAffected jobs: <job-ids>\nSymptom: <what-happened>"
  },
  tools: ["workstream_analysis"]
})
```

**Re-invocation**: You will be RE-INVOKED when children complete. Check `context.hierarchy.children` for their findings and synthesize into final analysis.

### Step 5: Check Context/Invariants

If invariant-related issues:
- `measurementCoverage.coveragePercent` < 100%?
- `measurementCoverage.unmeasuredIds` - which invariants missed?
- Any `create_measurement` calls with `success: false`?

### Step 6: Synthesize Findings and Propose Fix

On re-invocation (when investigation children have completed), synthesize their findings:

1. **What happened?** - Failure chain from root cause to final state
2. **Why?** - Configuration-level root cause from child investigations (not just symptoms)
3. **Configuration source** - Specific field/setting that caused each issue (from children)
4. **Fix** - Specific, actionable changes to configuration
5. **Verify** - How to confirm fix worked

**Key**: Final analysis MUST include configuration-level causes - "enabledTools was missing `telegram_messaging`" not just "agent called wrong tool".

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

## Tool Reference

```
# Overview
inspect_workstream({ workstream_id: "<id>", sections: ["errors", "timing", "tools"] })

# Failed only
inspect_workstream({ workstream_id: "<id>", status: "failed" })

# Job execution
inspect_job_run({ request_id: "<id>", include_telemetry: true })

# Job history
inspect_job({ job_definition_id: "<uuid>", include_runs: true })
```

## Configuration Reference

When tracing root causes, these are the configuration sources to inspect:

| Source | Location | How to Access |
|--------|----------|---------------|
| **Blueprint** | IPFS payload | `get_details({ id: "<request-id>", include_ipfs_content: true })` → check `invariants`, `outputSpec`, `context` |
| **Job Definition** | Ponder | `inspect_job({ job_definition_id })` → check `enabledTools`, `dependencies`, `codeMetadata` |
| **Dispatch Chain** | Ponder | Follow `sourceJobDefinitionId` and `sourceRequestId` up the chain |
| **Environment** | Telemetry | Check for env-related errors (missing keys, wrong URLs) |
| **Template** | Template registry | Tool whitelist, pricing, mech address |

**Meta-tools expand at dispatch time**, not runtime. Agent calls individual tools (e.g., `telegram_send_message`). If UNAUTHORIZED_TOOLS, check if the meta-tool (`telegram_messaging`) was in `enabledTools`.
