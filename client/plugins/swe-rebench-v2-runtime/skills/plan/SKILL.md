---
name: swe-rebench-v2-plan
description: Plan the patch for a SWE-rebench v2 task — given the Orient summary, sketch the minimal diff that resolves the issue without breaking existing PASS_TO_PASS tests, then submit the final patch via the `submit_typed_payload` MCP tool.
---

# Plan the patch

Inputs:
- The Orient summary from the previous phase.
- The repo at `goal.spec.base_commit`.
- The `FAIL_TO_PASS` test names (must pass after your patch).
- The `PASS_TO_PASS` test names (must continue passing — don't break them).

Steps:

1. Read the failing test(s). Understand exactly what behaviour they assert.
2. Locate the source file(s) that need editing. Use grep, AST tools, or filesystem search.
3. Sketch the minimal diff:
   - What lines change in which files?
   - What does the new code do?
   - Which existing tests must continue to pass (briefly justify why they will)?
4. Output the plan as a list of file-level edits.

Pass this plan forward to the Execute phase, which produces the actual patch.

## Submitting the final patch

Once Execute has produced the unified diff, call the **`submit_typed_payload`** MCP tool exposed by the daemon to register the Solution. The daemon validates the payload against the SolverNet contract's solution schema before persisting it; if validation fails, the tool returns the Zod error tree under `error.issues` and you can retry.

If `submit_typed_payload` is not available in the current harness, write the same payload object directly to `<workingDir>/.execute/solution-payload.json`. Create the `.execute` directory if needed. The daemon's harvester reads that file after the harness exits and applies the same SolverNet payload schema during envelope assembly.

Required payload shape for `swe-rebench-v2.v1`:

```json
{
  "schemaVersion": "swe-rebench-v2-solution.v1",
  "patch": "<unified diff, git-format>"
}
```

Optional fields:

- `cost.totalUsd: number` — operator-self-reported cost in USD for producing this Solution. Include if you can compute it from your LLM/tool usage; omit otherwise.

Do **not** include daemon-derived fields (e.g. trajectory CIDs) — the daemon attaches trajectory provenance to the envelope automatically. The Solution payload is purely solver-known fields.

Example call:

```
submit_typed_payload({
  payload: {
    schemaVersion: "swe-rebench-v2-solution.v1",
    patch: "--- a/src/foo.c\n+++ b/src/foo.c\n@@ -1 +1 @@\n-old\n+new\n"
  }
})
```

A successful response looks like:

```json
{ "accepted": true, "solverType": "swe-rebench-v2.v1", "role": "restoration", "persistedTo": "<workingDir>/.execute/solution-payload.json" }
```

After a successful submission, this Plan/Execute cycle is complete — the daemon's harness picks up the persisted payload post-execution and assembles the on-chain envelope.
