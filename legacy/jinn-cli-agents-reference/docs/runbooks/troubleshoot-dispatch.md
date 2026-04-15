---
title: Troubleshoot Dispatch
purpose: runbook
scope: [worker, gemini-agent]
last_verified: 2026-02-07
related_code:
  - gemini-agent/mcp/tools/dispatch_new_job.ts
  - gemini-agent/mcp/tools/dispatch_existing_job.ts
  - worker/control_api_client.ts
  - worker/status/autoDispatch.ts
keywords: [dispatch, job, validation, blueprint, dependency, mech, ponder]
when_to_read: "When dispatch_new_job or dispatch_existing_job tools fail with validation or execution errors"
---

# Troubleshoot Dispatch

Debug job dispatch failures for `dispatch_new_job` and `dispatch_existing_job` tools.

## Error Code Reference

| Error Code | Symptom | Cause | Fix |
|------------|---------|-------|-----|
| `VALIDATION_ERROR` | Tool returns validation failure | Zod schema validation failed - missing required fields or invalid types | Check `jobName` is non-empty string. For `dispatch_existing_job`, provide either `jobId` (UUID) or `jobName`. |
| `CHILD_REVIEW_REQUIRED` | Dispatch blocked before execution | Completed child jobs exist but haven't been reviewed | Call `get_details` with completed child request IDs and `resolve_ipfs=true` before dispatching new work. |
| `INVALID_BLUEPRINT` | Blueprint rejected | `blueprint` is not valid JSON | Validate JSON: `echo '<blueprint>' \| jq .` |
| `INVALID_BLUEPRINT_STRUCTURE` | Blueprint schema error | Blueprint doesn't match `blueprintStructureSchema` | Ensure `invariants` array exists with valid invariant objects (id, type, assessment required). |
| `INVALID_INVARIANT_SEMANTICS` | Invariant logic error | Invariant fails semantic validation | Check RANGE has `min <= max`, FLOOR has `min`, CEILING has `max`, BOOLEAN has `condition`. |
| `INVALID_DEPENDENCY_ID` | Dependencies rejected | Dependencies array contains non-UUID values | Use full UUID format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. Use `get_details` or `search_jobs` to find job definition IDs. |
| `INVALID_DEPENDENCIES` | Dependencies rejected (alternate) | Same as above, different code path | Same fix as `INVALID_DEPENDENCY_ID`. |
| `MISSING_DEPENDENCY` | Dependencies not found | Dependency job definition not indexed in Ponder yet | Wait for Ponder indexing. Increase retries: `JINN_DEPENDENCY_VALIDATION_RETRIES=5`. Increase delay: `JINN_DEPENDENCY_VALIDATION_DELAY_MS=1000`. |
| `CIRCULAR_DEPENDENCY` | Child depends on parent | Child job lists its parent job definition in dependencies | Remove circular dependency. Children cannot wait on parents - this creates deadlock. Dependencies are for sibling coordination only. |
| `UNAUTHORIZED_TOOLS` | Tool policy violation | Requested tool not in template's `availableTools` | Use meta-tools or update template policy. Universal tools (dispatch, search, etc.) are always allowed. |
| `DEPRECATED_MODEL` | Model rejected | Requested model is deprecated/removed from Gemini API | Use a current model (e.g., `gemini-3-flash`, `gemini-2.5-pro`). Check `details.suggestion` for recommended alternative. |
| `UNAUTHORIZED_MODEL` | Model not in allowlist | Requested model not in blueprint `models.allowed` or parent workstream's `allowedModels` | Use a model from the allowlist. Check `details.allowedModels` for permitted models. |
| `PAYLOAD_BUILD_ERROR` | IPFS payload build failed | Error in `buildIpfsPayload` | Check code metadata collection, branch creation. Review logs for specific field errors. |
| `DISPATCH_FAILED` | Marketplace returns no request IDs | On-chain transaction failed or mech misconfigured | Check mech balance, private key, RPC endpoint. See diagnostics below. |
| `EXECUTION_ERROR` | Runtime error during dispatch | Mech address/private key missing or marketplace call threw | Verify `.operate` config has `MECH_TO_CONFIG`. Check `.operate/keys` directory. |
| `UNEXPECTED_ERROR` | Unhandled exception | Bug or unexpected state | Check full error message. Report if reproducible. |
| `NOT_FOUND` | Job definition not found | `dispatch_existing_job` can't find job by ID or name | Use `dispatch_new_job` to create job first. Verify job exists in Ponder. |
| `MISSING_BLUEPRINT` | No blueprint to dispatch | Job definition exists but has no blueprint content | Use `dispatch_new_job` with blueprint, or provide `blueprint` override. |
| `SUBGRAPH_ERROR` | Ponder query failed | GraphQL error querying job definition | Check Ponder service is running. Verify `PONDER_GRAPHQL_URL`. |

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `JINN_DEPENDENCY_VALIDATION_RETRIES` | Retry count for dependency validation | 3 |
| `JINN_DEPENDENCY_VALIDATION_DELAY_MS` | Delay between retries (multiplied by attempt) | 500 |
| `JINN_SKIP_DEPENDENCY_VALIDATION` | Set to `1` to skip validation (testing only) | - |
| `PONDER_GRAPHQL_URL` | Ponder GraphQL endpoint | Required |

## Diagnostic Commands

```bash
# Check mech balance
cast balance $JINN_SERVICE_MECH_ADDRESS --rpc-url $RPC_URL

# Query job definition by ID
curl -X POST $PONDER_GRAPHQL_URL \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id:String!){jobDefinition(id:$id){id name blueprint}}","variables":{"id":"<uuid>"}}'

# Query job definition by name
curl -X POST $PONDER_GRAPHQL_URL \
  -H "Content-Type: application/json" \
  -d '{"query":"query($n:String!){jobDefinitions(where:{name:$n},limit:1){items{id name}}}","variables":{"n":"<name>"}}'

# Check dependency exists
curl -X POST $PONDER_GRAPHQL_URL \
  -H "Content-Type: application/json" \
  -d '{"query":"query($ids:[String!]!){jobDefinitions(where:{id_in:$ids}){items{id}}}","variables":{"ids":["<uuid1>","<uuid2>"]}}'
```

## Common Patterns

**Sibling coordination with dependencies:**
```json
{
  "dependencies": ["<sibling-job-def-uuid>"]
}
```
Sibling must have at least one delivered request before this job executes.

**Blueprint with all invariant types:**
```json
{
  "invariants": [
    {"id": "F-1", "type": "FLOOR", "metric": "quality", "min": 70, "assessment": "Rate 0-100"},
    {"id": "C-1", "type": "CEILING", "metric": "cost", "max": 20, "assessment": "Sum API costs"},
    {"id": "R-1", "type": "RANGE", "metric": "frequency", "min": 3, "max": 7, "assessment": "Count per week"},
    {"id": "B-1", "type": "BOOLEAN", "condition": "Tests pass", "assessment": "Run test suite"}
  ]
}
```
