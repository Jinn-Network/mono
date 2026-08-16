---
name: swe-rebench-v2-test-map
description: Walk PASS_TO_PASS test names to their source files via repo grep, identify the test-to-source ratio, and pre-load the relevant call graph into context before writing the patch.
---

# PASS_TO_PASS test mapping for SWE-rebench v2

Before writing a single line of fix code, map the test names you must preserve
(`PASS_TO_PASS`) to their source files. This gives you an accurate picture of
the call graph your patch must not disturb, which is the information needed to
apply minimal-diff discipline correctly.

## Why this matters

`PASS_TO_PASS` names are the regressions you cannot afford. A patch that fixes
`FAIL_TO_PASS` but breaks five `PASS_TO_PASS` tests scores zero on the
`brier-loss.v1` evaluator. The test map shows you exactly which functions,
structs, and files are exercised by those tests — a constraint that shapes
where you can safely edit.

## Steps

### Step 1: Extract PASS_TO_PASS names from the task spec

The task body includes `goal.spec.PASS_TO_PASS`, a list of test identifiers
in the form `<module>::<function>` or `<file>::<class>::<method>`. Example:

```
goal.spec.PASS_TO_PASS = [
  "test_nc_get_var_string::test_basic_string_read",
  "test_fill_value::test_default_fill",
  "test_fill_value::test_custom_fill"
]
```

### Step 2: Grep test names to source files

For each `PASS_TO_PASS` test name, grep the repo for the function or class
definition. Use the filesystem tools or bash to run:

```bash
grep -r "test_basic_string_read" <repo_root> --include="*.c" --include="*.py" -l
```

Build a map: `test name → test file → source file under test`.

Identify the source file by reading the test: find the `#include`, `import`,
or `open()` call that loads the module under test. This is the source file your
patch may not break.

### Step 3: Compute the test-to-source ratio

Count the number of `PASS_TO_PASS` test functions that exercise each source
file. A high ratio (e.g. 8 tests → 1 source file) means the file is heavily
covered and every edit carries regression risk. A low ratio means fewer hidden
dependencies.

Annotate your edit plan: "source file `libsrc/var.c` is exercised by 3
PASS_TO_PASS tests; edits must not change the function signature or remove any
branch reachable from `test_fill_value`."

### Step 4: Pre-load the call graph for the affected function

Read the function you intend to edit. Trace:
- Which sub-functions does it call?
- Which of those sub-functions appear in the PASS_TO_PASS test map?

If a sub-function appears in the test map, your patch must not change its
behaviour. If it does not appear, it may be safe to touch — confirm with
step 3's ratio.

### Step 5: Write the edit constraint list

Output a structured list summarising what the patch may and may not touch:

```
Edit constraint list:
- File: libsrc/var.c
- Function: nc_get_var_string
- Lines: 400-410
- PASS_TO_PASS coverage: 3 tests depend on this function
- Sub-functions NOT to touch: nc_fill_string (covered by test_fill_value::test_default_fill)
- Safe to change: local variable stat comparison on line 402
```

This list is the input to writing the patch itself.

## Worked example: org__repo-42 (fictional)

**Instance:** `org__repo-42`
**FAIL_TO_PASS:** `test_parser::test_malformed_json`
**PASS_TO_PASS:** `test_parser::test_valid_json`, `test_parser::test_empty_object`, `test_roundtrip::test_encode_decode`

**Step 1:** Extract names — three tests to preserve.

**Step 2:** Grep reveals:
- `test_valid_json` and `test_empty_object` live in `tests/test_parser.py`, which imports `src/parser.py`.
- `test_encode_decode` lives in `tests/test_roundtrip.py`, which imports both `src/parser.py` and `src/encoder.py`.

**Step 3:** Ratio for `src/parser.py`: 3 tests. Ratio for `src/encoder.py`: 1 test. `src/parser.py` is more risky.

**Step 4:** The function to fix is `parse_json()` in `src/parser.py`. It calls `_tokenize()` and `_validate_token()`. `_validate_token()` appears in `test_valid_json` (it is called on valid JSON). Do not change `_validate_token()`; it is covered. `_tokenize()` does not appear — lower risk.

**Step 5:** Edit constraint list:
```
- File: src/parser.py
- Function: parse_json
- PASS_TO_PASS coverage: 3 tests via parse_json + _validate_token
- Sub-functions NOT to touch: _validate_token (PASS_TO_PASS coverage)
- Sub-functions safe to touch: _tokenize (no direct PASS_TO_PASS coverage)
- Preferred: fix on lines 88-92 where malformed JSON triggers early return
```

This constraint list feeds directly into the diffmin skill's heuristics: one
hunk, one file, no renames, no changes to `_validate_token`.

## Relationship to the diffmin skill

The test-map constraint list (which sub-functions are covered by
PASS_TO_PASS) is the natural input to the diffmin skill's heuristics: it
tells you which functions are safe to touch and which would inflate
regression risk. The `mcp__diff-stats__diff_stats` tool described in the
diffmin skill can then confirm that the resulting patch satisfies the hunk
and file count constraints.
