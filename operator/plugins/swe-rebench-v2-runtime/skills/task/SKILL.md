---
name: swe-rebench-v2-task
description: Reference for swe-rebench-v2.v1 task structure — input fields, repo setup, FAIL_TO_PASS/PASS_TO_PASS semantics, the swe-rebench-v2-solution.v1 output schema, and how to submit a typed payload. Consult this skill when orienting on a task or constructing a solution.
---

# SWE-rebench v2 task reference

Domain reference for `swe-rebench-v2.v1` restoration tasks. Describes the task
shape, the repo layout the runtime expects, the test-set semantics that define
success, and the schema your final payload must satisfy.

## Task input shape

The full task body carries the following fields under `goal.spec`:

- `goal.spec.instance_id` — e.g. `unidata__netcdf-c-1925`
- `goal.spec.repo` — `org/repo`
- `goal.spec.base_commit` — git SHA
- `goal.spec.language` — `python | javascript | typescript | go | c | cpp | cs | java | rust | dart`
- `goal.spec.problem_statement` — the issue description
- `goal.spec.interface` — auxiliary interface info (function names, signatures, descriptions). May be empty. When non-empty, treat it as authoritative for function names and signatures of the API you must implement or fix.

## Repository handling

Treat `$workingDir/repo` as the only task repository checkout. Do not reuse a repo from another `workingDir` or from `implStateDir`. All in-tree edits must live in `$workingDir/repo` — that's both where the test infrastructure expects to find them and where the daemon's harvester reads a `git diff` from as a last-resort fallback if a typed-payload submission never lands.

If `$workingDir/repo/.git` is missing, materialise the repo at `<goal.spec.base_commit>` by fetching that exact SHA — **do not** `git clone` and then `git checkout`. Run these commands verbatim (substituting the two task fields):

```bash
mkdir -p "$workingDir/repo" && cd "$workingDir/repo"
git init
git remote add origin https://github.com/<goal.spec.repo>.git
git fetch --depth 1 origin <goal.spec.base_commit>
git checkout FETCH_HEAD
```

Why this exact sequence, and not a clone: `<goal.spec.base_commit>` is frequently **off the default branch** (a commit on a PR branch or an old point in history). A `git clone` only brings down the default branch tip, so `git checkout <goal.spec.base_commit>` then fails with `fatal: reference is not a tree` / `unable to read tree`, and a plain `git fetch origin` without the SHA won't help (it only pulls branch refs). GitHub serves any SHA by id, so `git fetch --depth 1 origin <goal.spec.base_commit>` retrieves exactly that one commit — fast, shallow, and robust whether or not the SHA is on a branch. After `git checkout FETCH_HEAD`, confirm you are on the base commit with `git rev-parse HEAD` (it must equal `<goal.spec.base_commit>`) before editing.

## Test semantics: FAIL_TO_PASS and PASS_TO_PASS

Two test sets, derived from the HF row, jointly define success:

- `FAIL_TO_PASS` — tests that fail at `base_commit` and must pass after the patch. These define the success criterion for the issue. Find them in the codebase via grep or filesystem search.
- `PASS_TO_PASS` — tests that already pass at `base_commit` and must continue passing after the patch. They guard against regressions; the minimal diff is the one that flips FAIL_TO_PASS without disturbing PASS_TO_PASS.

### Prior execution data in the Jinn corpus

Prior execution data from similar SWE-rebench v2 work may exist in the Jinn knowledge corpus. Search for records with:

- `solverType: "swe-rebench-v2.v1"`
- `role: "restoration"`
- `artifactType: "swe-rebench-v2_v1_solution"`

The available Jinn corpus tools expose separate **search**, **inspect**, and **acquire** operations — pick each by what you are trying to do (find candidates → examine one → download bytes). For any promising hit, examine its index card before deciding to spend on artifact bytes; only download the full execution data when the index card suggests it is likely relevant.

## Solution payload schema and submission

The final solution is handed back to the daemon as a **typed structured payload**. The Jinn client tools available in this harness include a dedicated "submit typed payload" action that validates the payload against the active SolverNet contract schema before persisting it. The validator runs server-side — on schema mismatch you will receive a Zod-style `issues[]` tree describing the mismatch path and can correct the payload and re-submit.

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

If — and only if — the active harness exposes no typed-payload submission tool at all, the same payload object can be written directly to `<workingDir>/.execute/solution-payload.json` (create the `.execute` directory if needed). The daemon's harvester reads that file post-execution and applies the same SolverNet payload schema during envelope assembly. Prefer the tool path whenever it exists, because the tool gives immediate schema validation feedback while the file path does not.
