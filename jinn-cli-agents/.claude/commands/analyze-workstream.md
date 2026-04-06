---
argument-hint: <workstream-id>
description: Debug failed workstreams by identifying root causes and proposing fixes
allowed-tools: Bash, Read, Grep
---

# Workstream Analysis Skill

You are debugging a workstream to identify why jobs failed and what can be done to fix them.

## Quick Facts (Critical Context)

- **PENDING status**: NOT a failure - just means worker hasn't picked up the job yet. **Skip these entirely.**
- **DELEGATING status**: Job dispatched children and is waiting for them. Check child job status instead.
- **0% measurement coverage on a single job**: Normal for orchestrator/root jobs that delegate work to children.
- **0% measurement coverage on entire workstream**: This IS a problem - no job measured any goal invariants. Check if `create_measurement` was called anywhere.
- **Recovery dispatches** (loop_recovery, timeout_recovery): Normal auto-recovery behavior. Check if later runs succeeded - if so, recovery worked.

## Documentation References

When diagnosing specific issues, read these reference docs:

| Issue Type | Read |
|------------|------|
| **UNAUTHORIZED_TOOLS errors** | `docs/reference/tool-policy.md` |
| **Dispatch types / recovery** | `docs/reference/dispatch-types.md` |
| **Job status questions** | `docs/reference/job-lifecycle.md` |
| **Status model (detailed)** | `docs/reference/job-status-model.md` |
| **Error codes** | `docs/reference/error-codes.md` |
| **Artifacts** | `docs/reference/artifacts.md` |
| **Measurements / coverage** | `docs/reference/measurements.md` |
| **Job dependencies** | `docs/reference/dependency-resolution.md` |
| **IPFS payload structure** | `docs/reference/ipfs-payload-structure.md` |
| **Ponder GraphQL queries** | `docs/reference/ponder-graphql.md` |

## Your Approach

This is **exploratory debugging**, not pattern matching. Your goal is to:
1. Gather evidence from the workstream
2. Look for anomalies (errors, unexpected status, missing data)
3. Trace causality through dispatch chains
4. Understand WHY failures occurred, not just what failed
5. Propose targeted fixes based on evidence

## Workflow

### Step 1: Triage - Get Overview

Run the inspection tool to get an overview of the workstream:

```bash
yarn inspect-workstream $ARGUMENTS --show-all --format=summary
```

From the summary, note:
- **Failure rate**: How many jobs FAILED vs COMPLETED? **(Ignore PENDING - those just need worker pickup)**
- **Error distribution**: Which phases have errors? (delivery, execution, git, etc.)
- **Dispatch pattern**: Are there verification loops, recovery attempts, cycles?
- **Timing**: Are any jobs unusually slow?
- **Anomalous run counts**: Any job with significantly more runs than others (e.g., 9 runs vs 1-3 for others)?
  - Check for `[loop_recovery]` or `[timeout_recovery]` tags → job is failing repeatedly
  - Check if job is dispatching itself as a child → recursive delegation problem
  - Check Job Tree for same job appearing multiple times → pile-up issue

If no FAILED jobs exist, check the **Failed Tool Calls** section and the **Anomalous run counts**. If there are issues, proceed to investigate. Otherwise, report "No failures detected" and stop.

### Step 1b: Investigate Tool Errors (Even in Completed Jobs)

Tool errors in completed jobs still indicate issues worth understanding. For each failed tool call:

#### For UNAUTHORIZED_TOOLS errors:
1. **Identify the job**: Which job made the failing `dispatch_new_job` call?
2. **Get telemetry**: `yarn inspect-job-run <request-id> --format=json`
3. **Examine the error and dispatch call**:
   - Look at the **error message** - what specific tool names are listed as disallowed?
   - Find the `dispatch_new_job` call - what `enabledTools` array was requested?
   - **Key check**: Are they using individual tool names instead of meta-tools?
     - `telegram_send_message`, `telegram_send_photo` → Should be `telegram_messaging`
     - `fireflies_search`, `fireflies_get_transcripts` → Should be `fireflies_meetings`
   - See `docs/reference/TOOL_POLICY.md` for full meta-tool mappings
4. **Trace back to the source** - Why did the agent request these tools?
   - Check the **blueprint/prompt passed to this agent** (in the dispatch call that created it)
   - Did the blueprint text or invariants instruct the agent to enable specific tool names?
   - If so, the fix is to update **the source blueprint**, not the agent behavior
5. **Determine root cause**:
   - **Blueprint has wrong tool names**: Instructions told agent to use individual tools → Fix: Update blueprint text to use meta-tool names
   - **Template missing tools**: Tool legitimately needed but not in template → Fix: Add to template's `tools` list
   - **Agent hallucinated tools**: Blueprint didn't mention these tools, agent made them up → Different issue, may need prompt improvement

#### For other tool failures (list_tools, read_file, etc.):
1. **Get telemetry**: `yarn inspect-job-run <request-id> --format=json`
2. **Find the failing call**: Look for the tool call with error
3. **Check if retried**: Was the SAME tool called again later in the session?
   - Yes, and succeeded → **True transient** (network/timing issue, low priority)
   - No, or failed again → **Agent worked around it** (investigate why tool failed)
4. **Investigate root cause**: For repeated failures, check error messages and tool configuration

### Step 2: Focus on Failures

Get detailed JSON data for failed jobs:

```bash
yarn inspect-workstream $ARGUMENTS --status=failed --show-all --raw --format=json
```

From the JSON output, identify:
- **Failed jobs**: Which specific jobs failed? (job names, request IDs)
- **Error messages**: What do the errors say?
- **Dispatch chain**: Which job is the root of the failure chain?

### Step 3: Trace Root Cause

Analyze the dispatch chain to find the root cause:
- Find the **deepest failed job** in the chain (earliest failure)
- Check if failures **cascade** (parent fails → children fail)
- Identify **auto-dispatch triggers** (verification, cycle, recovery, continuation)

The root cause is usually:
- The first job that failed in a chain
- The job whose failure caused downstream failures
- NOT the leaf job that just inherited a failure

### Step 4: Deep Dive into Root Cause Job

For the root cause job, get extracted debugging info:

```bash
yarn inspect-job-run <request-id> --format=summary
```

The summary shows:
- **Status**: COMPLETED, FAILED, PENDING, or DELEGATING
- **Errors**: Phase and error message for each error
- **Failed Tool Calls**: Tool name, error code, error message
- **Timing**: Duration by phase (execution, git_operations, delivery)
- **Measurement Coverage**: X/Y invariants measured, unmeasured IDs
- **Git Operations**: Branch, push status, conflicts
- **Token Usage**: Input, output, total tokens

If you need more detail, escalate to raw JSON:
```bash
yarn inspect-job-run <request-id> --format=json
```

This gives full telemetry in `delivery.ipfsContent.telemetry` for deep investigation.

**Key principle: Check the agent's input to understand its behavior.**
- Look at the **blueprint/prompt** the agent received (in `request.ipfsContent`)
- Agent behavior follows from instructions - if an agent did something wrong, check if its instructions told it to
- The fix is often upstream in the blueprint that dispatched this job, not the agent itself

### Step 5: Check Context/Invariants (if relevant)

If the job has invariant-related issues:
- Check `measurementCoverage.coveragePercent` - Is it < 100%?
- Check `measurementCoverage.unmeasuredIds` - Which invariants weren't measured?
- Check tool calls for `create_measurement` - Any with `success: false`?

### Step 6: Analyze and Propose Fix

Based on ALL the evidence gathered:

1. **What actually happened?**
   - Describe the failure chain from root cause to final state
   - Be specific: which job, which tool, which phase

2. **Why did it fail?**
   - Root cause analysis - the underlying reason, not just the symptom
   - Example: "Git merge conflict" is a symptom; "Concurrent edits to same file" is the cause

3. **Recommended fix**
   - Specific, actionable steps based on the evidence
   - Not generic advice - tailored to this specific failure

4. **How to verify**
   - How to confirm the fix worked
   - What to check in a retry

## Output Format

```
## Workstream Analysis: <workstream-id>

### Summary
- Status: X completed, Y failed, Z pending
- Affected jobs: <list of failed job names>

### What Happened
<Narrative explanation tracing the failure from root cause through the dispatch chain>

### Why It Failed
<Root cause analysis - the underlying reason, not just the symptom>

### Evidence
- <Specific data points: error messages, request IDs, tool failures>
- <Telemetry findings: timing, coverage, tool metrics>

### Tool Errors (if any in completed jobs)
For each tool error investigated:
- **Tool**: <tool name> in job <job name>
- **Error**: <error message>
- **Investigation**: <what you found - was it retried? worked around?>
- **Root cause**: <why it failed>
- **Fix needed?**: <Yes/No - if yes, what action>

### Recommended Fix
<Specific steps to address the root cause>

### How to Verify
<How to confirm the fix worked when re-running>
```

## Example: Tool Failure

If you find a tool failed repeatedly:

```
## Workstream Analysis: 0x123abc...

### Summary
- Status: 5 completed, 3 failed, 0 pending
- Affected jobs: code-reviewer, test-runner, code-reviewer (retry)

### What Happened
The root job `code-reviewer` (req: 0xabc...) failed during execution phase.
The tool `github_create_pr` failed with error "Resource not found".
This caused 2 child jobs to fail: `test-runner` (couldn't find PR to test) and a retry of `code-reviewer`.

### Why It Failed
The GitHub API returned 404 because the repository was renamed from `old-repo` to `new-repo`.
The job blueprint still references `old-repo` in the repository URL.

### Evidence
- Request 0xabc... tool call #12: github_create_pr failed with 404
- Error message: "Repository not found: owner/old-repo"
- Job blueprint contains: "repository": "owner/old-repo"

### Recommended Fix
Update the job definition blueprint to use the correct repository name:
1. Find job definition: 0xdef...
2. Update blueprint.repository from "owner/old-repo" to "owner/new-repo"
3. Re-dispatch the job

### How to Verify
After re-running, check:
1. The `github_create_pr` tool call succeeds (status 201)
2. Child jobs complete without inherited failures
```

## Debugging Tips

- **Large workstreams**: Use `--status=failed` to focus only on problems
- **Deep hierarchies**: Use `--depth=N` to limit tree depth
- **Recent failures**: Use `--since=<timestamp>` to filter by time
- **Full data**: Use `--raw` to see all errors without truncation
- **Specific job history**: Use `yarn inspect-job <job-def-id>` for repeat failures

## Key Commands Reference

```bash
# Full overview with all sections
yarn inspect-workstream <id> --show-all --format=summary

# Failed jobs only, full JSON
yarn inspect-workstream <id> --status=failed --show-all --raw --format=json

# Specific job execution - extracted debugging info
yarn inspect-job-run <request-id> --format=summary

# Specific job execution - full JSON for deep investigation
yarn inspect-job-run <request-id> --format=json

# Job definition history - runs table with failed details
yarn inspect-job <job-def-id> --format=summary

# Job definition history - full JSON
yarn inspect-job <job-def-id> --format=json
```

## Escalation Path

When debugging, start simple and escalate if needed:

1. **Quick overview**: `--format=summary` shows extracted errors, failed tools, timing, coverage
2. **More detail**: `--format=json` provides full telemetry data
3. **Raw telemetry**: The summary shows artifact CIDs - fetch directly from IPFS for complete data

---

**Now begin:** Run the triage command with the workstream ID provided in `$ARGUMENTS`.
