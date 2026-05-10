---
name: swe-rebench-v2-orient
description: Orient on a SWE-rebench v2 task — read the problem statement, repo, base commit, and auxiliary interface info; identify the test files in FAIL_TO_PASS; understand what change the issue requires.
---

# Orient on a SWE-rebench v2 task

Inputs you receive under `goal.spec` in the full task body:

- `goal.spec.instance_id` — e.g. `unidata__netcdf-c-1925`
- `goal.spec.repo` — `org/repo`
- `goal.spec.base_commit` — git SHA
- `goal.spec.language` — `python | javascript | typescript | go | c | cpp | cs | java | rust | dart`
- `goal.spec.problem_statement` — the issue description
- `goal.spec.interface` — auxiliary interface info (function names, signatures, descriptions). May be empty.

Steps:

1. Read the problem statement carefully. Note the symptom, the expected behaviour, and any hints about which files / symbols are involved.
2. If `task.interface` is non-empty, treat it as authoritative for function names + signatures of the API you must implement / fix.
3. Use Network Tools to look for prior execution data from similar SWE-rebench v2 work. Call `search_records` with `solverType: "swe-rebench-v2.v1"`, `role: "restoration"`, and `artifactType: "swe-rebench-v2_v1_solution"`; use `inspect_record` on promising refs. Call `acquire_artifact` only when the inspected record has donated IPFS sources and the full execution data is likely to help this task.
4. Check the `FAIL_TO_PASS` test names from the HF row — these define the success criterion. Find them in the codebase via grep / fs search.
5. Output a brief Orient summary (3-5 sentences): your hypothesis about the bug, the files you intend to touch, the test you intend to satisfy, and any donated execution data that affected the plan.

Pass this summary forward to the Plan phase.
