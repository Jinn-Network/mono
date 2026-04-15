---
title: Error Codes Reference
purpose: reference
scope: [worker, gemini-agent, mcp]
last_verified: 2026-02-07
related_code:
  - gemini-agent/mcp/tools/shared/types.ts
  - worker/mech_worker.ts
  - worker/delivery/transaction.ts
keywords: [error codes, UNAUTHORIZED_TOOLS, UNAUTHORIZED_MODEL, DEPRECATED_MODEL, NOT_FOUND, INVALID_BLUEPRINT, tool errors]
when_to_read: "Use when debugging job failures, understanding error codes in telemetry, or handling MCP tool errors"
---

# Error Codes Reference

Quick reference for error codes encountered in job execution and tool calls.

---

## Tool Call Errors

These errors appear in telemetry when tool calls fail.

| Code | Meaning | Common Cause | Fix |
|------|---------|--------------|-----|
| `UNAUTHORIZED_TOOLS` | Tool not in template whitelist | Used individual tool instead of meta-tool, or tool not in template | See `TOOL_POLICY.md` |
| `EXECUTION_ERROR` | Tool threw due to missing config | Environment variables not set on worker | Add missing vars to Railway worker (see `deploy-railway-worker.md`) |
| `NOT_FOUND` | Resource doesn't exist | Invalid ID, resource deleted, or not yet indexed | Verify ID exists, wait for Ponder indexing |
| `INVALID_BLUEPRINT` | Blueprint validation failed | Missing required fields, invalid invariant format | Check blueprint structure |
| `INVALID_CURSOR` | Pagination cursor invalid | Cursor expired or malformed | Start fresh without cursor |
| `HTTP_ERROR` | External HTTP request failed | Network issue, auth failure, rate limit | Check URL, credentials, retry |
| `CHAIN_MISMATCH` | Wrong blockchain network | CHAIN_ID mismatch | Verify environment config |
| `CONTROL_API_ERROR` | Control API call failed | API down, auth issue, payload error | Check Control API logs |
| `ALLOWLIST_VIOLATION` | Action blocked by allowlist | Tool/action not in security allowlist | Update allowlist if intentional |

---

## Understanding Tool Call Success vs Result Success

**IMPORTANT:** MCP tools have TWO levels of success/failure:

### 1. Tool Call Success (`success` field)

```json
{
  "tool": "dispatch_new_job",
  "success": true,        ← Tool executed without throwing
  "result": { ... }
}
```

`success: true` only means the tool **executed** - it does NOT mean the operation succeeded!

### 2. Result Success (`result.meta.ok` field)

```json
{
  "result": {
    "meta": {
      "ok": false,        ← Operation failed
      "code": "UNAUTHORIZED_TOOLS",
      "message": "enabledTools not allowed..."
    }
  }
}
```

**Always check `result.meta.ok`** to determine if the operation actually succeeded.

### Summary

| `success` | `result.meta.ok` | Meaning |
|-----------|------------------|---------|
| `true` | `true` | Operation succeeded |
| `true` | `false` | Tool ran but operation failed (check `meta.code`) |
| `false` | N/A | Tool threw exception (execution error) |

---

## Error Types

### Execution Errors (`success: false`)
- Tool threw an exception
- Network/timeout error
- Usually transient - may succeed on retry

### Logical Errors (`success: true`, `meta.ok: false`)
- Tool executed but operation was rejected
- Business logic failure (invalid input, unauthorized, etc.)
- Check `meta.code` and `meta.message` for details
- Usually needs fix before retry

---

## Dispatch Errors

Errors when dispatching jobs:

| Error | Meaning | Fix |
|-------|---------|-----|
| `UNAUTHORIZED_TOOLS` | enabledTools contains tools not in template | Use meta-tool names, check template whitelist |
| `DEPRECATED_MODEL` | Requested model removed from Gemini API | Use current model (see `details.suggestion`) |
| `UNAUTHORIZED_MODEL` | Model not in blueprint/workstream allowlist | Use a model from `details.allowedModels` |
| `INVALID_BLUEPRINT` | Blueprint JSON invalid or missing fields | Validate blueprint structure |
| `DEPENDENCY_NOT_MET` | Dependencies not yet delivered | Wait for dependency jobs to complete |
| `DUPLICATE_JOB_NAME` | Job name already exists in workstream | Use unique job name |

---

## Worker Errors

Errors during worker execution:

| Error | Meaning | Fix |
|-------|---------|-----|
| `LOOP_DETECTED` | Agent output repetition threshold exceeded | Job will auto-redispatch with `loop_recovery` |
| `TIMEOUT` | Execution exceeded timeout | Job will auto-redispatch with `timeout_recovery` |
| `IPFS_TIMEOUT` | IPFS upload/fetch timed out | Transient - will retry with different gateway |
| `RPC_RATE_LIMIT` | Blockchain RPC rate limited | Backoff and retry |
| `NONCE_FAILURE` | Transaction nonce conflict | Worker handles retry |

---

## Ponder/Indexing Errors

| Error | Meaning | Fix |
|-------|---------|-----|
| `STALE_DATA` | Ponder hasn't indexed recent events | Wait and retry query |
| `NOT_INDEXED` | Resource not yet in Ponder | Wait for indexing (usually < 30s) |

---

## Interpreting Error in Telemetry

Tool call errors appear in telemetry like:

```json
{
  "tool": "dispatch_new_job",
  "success": false,
  "result": {
    "meta": {
      "ok": false,
      "code": "UNAUTHORIZED_TOOLS",
      "message": "enabledTools not allowed by template policy: telegram_send_message"
    }
  }
}
```

**Key fields:**
- `success: false` - Tool call failed
- `result.meta.code` - Error code
- `result.meta.message` - Human-readable explanation

---

## Related Documentation

- Tool policy: `docs/reference/tool-policy.md`
- Recovery mechanisms: `docs/reference/dispatch-types.md`
- Job lifecycle: `docs/reference/job-lifecycle.md`
