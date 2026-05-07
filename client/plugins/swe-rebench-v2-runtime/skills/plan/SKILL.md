---
name: swe-rebench-v2-plan
description: Plan the patch for a SWE-rebench v2 task — given the Orient summary, sketch the minimal diff that resolves the issue without breaking existing PASS_TO_PASS tests.
---

# Plan the patch

Inputs:
- The Orient summary from the previous phase.
- The repo at `task.base_commit`.
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
