---
name: swe-rebench-v2-diffmin
description: Bias the patch toward the smallest change that flips FAIL_TO_PASS without disturbing PASS_TO_PASS. Use diff_stats to validate hunk count, file count, and rename absence before submitting.
---

# Minimal-diff discipline for SWE-rebench v2

This skill keeps your patch as small as possible. Smaller diffs are easier to
verify, less likely to introduce regressions, and align with how maintainers
actually ship fixes. Apply it after the Orient phase has identified the root
cause and before writing the patch in the Execute phase.

## Core heuristics

### 1. Single-hunk preference

Prefer a patch that touches one contiguous code block in one file. A single
hunk means the diff is self-contained: reviewers can read it in isolation and
test runners can bisect it easily. If you find yourself adding a second hunk,
stop and ask whether the second change is strictly required to flip
`FAIL_TO_PASS`. Often the first hunk is the fix; the second hunk is cleanup
that can be deferred.

### 2. Single-file preference

When the root cause is clearly in one file, do not touch other files to make
tests pass. Fixes that spread across files indicate either (a) the root cause
analysis was incomplete, or (b) a larger refactor is being smuggled in. Neither
belongs in a minimal-diff submission.

If two files genuinely must change (e.g. a struct definition and one call
site), verify that both changes are causally required: remove one and confirm
that `FAIL_TO_PASS` fails again.

### 3. No-rename rule

Never rename functions, variables, or files to fix a bug. Renames change every
call site and inflate the diff with changes that are semantically neutral to
the failing test but risky for `PASS_TO_PASS` tests. If you feel a rename
would help, file a note in the solution cost field and ship the fix without the
rename.

### 4. Function-scope containment

Limit edits to the function or method that the failing test exercises. Check
the call graph: if the test calls `parse_netcdf_header()`, your change should
live inside `parse_netcdf_header()` or a helper it directly calls — not in a
shared utility ten layers up that happens to also be called by unrelated code.

### 5. Dead-code deletion last resort

Deleting dead code (unreachable branches, commented-out blocks) is tempting
but risky: it inflates the diff with changes unrelated to `FAIL_TO_PASS` and
can break `PASS_TO_PASS` if the "dead" code was actually reachable in some
path. Delete dead code only when it is the direct cause of the failing test
(e.g. an always-false guard that prevents a required code path from running).

## Using the diff_stats MCP tool

Before submitting, call `mcp__diff-stats__diff_stats` with your complete
unified diff string. The tool returns:

```json
{
  "hunks": 1,
  "filesTouched": 1,
  "addedLines": 3,
  "removedLines": 2,
  "hasRenames": false
}
```

Reject and revise your patch if:
- `hunks > 3` — almost always indicates scope creep
- `filesTouched > 2` — consider whether both files are causally required
- `hasRenames === true` — strip the rename and fix in place
- `addedLines + removedLines > 50` — verify against single-hunk and single-file rules

Accept the patch if all checks pass and `FAIL_TO_PASS` flips while
`PASS_TO_PASS` stays green.

## Worked example: unidata/netcdf-c-1925

**Instance:** `unidata__netcdf-c-1925`
**Problem:** `nc_get_var_string()` returns garbage when the variable has a
fill value because `NC_EEMPTY` was tested with `!=` instead of `==`.

**Bad patch (17 hunks, 3 files, 200 lines):**
Refactors the fill-value handling layer to share a common helper, moves the
check into a new function, renames `nc_fill_string` to `nc_fill_str`. Correct
in intent but violates every heuristic.

**Minimal patch (1 hunk, 1 file, 2 lines):**
```diff
--- a/libsrc/var.c
+++ b/libsrc/var.c
@@ -402,7 +402,7 @@ nc_get_var_string(int ncid, int varid, char **sp)
-    if (stat != NC_EEMPTY) {
+    if (stat == NC_EEMPTY) {
```
`diff_stats` returns `{ hunks: 1, filesTouched: 1, addedLines: 1, removedLines: 1, hasRenames: false }`.
All checks pass. The `FAIL_TO_PASS` test now sees a proper empty string
instead of garbage; `PASS_TO_PASS` tests are untouched.

## Integration with the Plan skill

The `swe-rebench-v2-plan` skill from `swe-rebench-v2-runtime` sketches the
edit list. Run this diffmin skill after Plan and before submitting:

1. Plan produces: "change line 402 in `libsrc/var.c` from `!=` to `==`."
2. Execute writes the patch.
3. **This skill validates:** call `mcp__diff-stats__diff_stats` on the patch,
   confirm `hunks: 1, filesTouched: 1, hasRenames: false`.
4. Submit via `submit_typed_payload` only after validation passes.

If validation fails, trim the patch and re-validate before submitting.
