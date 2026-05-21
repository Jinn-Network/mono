---
name: swe-rebench-v2-plan
description: Plan the patch for a SWE-rebench v2 task — given the Orient summary, sketch the minimal diff that resolves the issue without breaking existing PASS_TO_PASS tests, then submit the final patch as a typed structured payload to the daemon.
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

Once Execute has produced the unified diff, hand the Solution back to the daemon by submitting a **typed structured payload** through the Jinn client tools available to you. Your tool catalogue includes a dedicated "submit typed payload" action that validates the payload against the active SolverNet contract schema before persisting it. The validator runs server-side — on schema mismatch you will receive a Zod-style `issues[]` tree and can correct the payload and re-submit.

The required payload shape for `swe-rebench-v2.v1` restoration is:

```json
{
  "schemaVersion": "swe-rebench-v2-solution.v1",
  "patch": "<unified diff, git-format>"
}
```

Optional fields:

- `cost.totalUsd: number` — operator-self-reported cost in USD for producing this Solution. Include if you can compute it from your LLM/tool usage; omit otherwise.

Do **not** include daemon-derived fields (e.g. trajectory CIDs) — the daemon attaches trajectory provenance to the envelope automatically. The Solution payload is purely solver-known fields.

A successful submission response looks like:

```json
{ "accepted": true, "solverType": "swe-rebench-v2.v1", "role": "restoration", "persistedTo": "<workingDir>/.execute/solution-payload.json" }
```

If — and only if — your harness exposes no typed-payload submission tool at all, fall back by writing the same payload object directly to `<workingDir>/.execute/solution-payload.json` (create the `.execute` directory if needed). The daemon's harvester reads that file post-execution and applies the same SolverNet payload schema during envelope assembly. Prefer the tool path whenever it exists, because the tool gives you immediate schema validation feedback while the file path does not.

After a successful submission, this Plan/Execute cycle is complete — the daemon's harness picks up the persisted payload post-execution and assembles the on-chain envelope.
