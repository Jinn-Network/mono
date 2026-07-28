---
name: jinn-repo-task
description: Reference for jinn-repo.v1 task structure — input fields, repo setup (checkout of Jinn-Network/mono at base_commit), the jinn-repo-solution.v1 output schema, and how the daemon harvests your diff. Consult this skill when orienting on a task or constructing a solution.
---

# jinn-repo task reference

Domain reference for `jinn-repo.v1` restoration tasks. A jinn-repo instance is a
real merged Jinn-Network/mono pull request, replayed as a coding task: you are
given the problem the PR fixed and the repo state immediately before it, and
must reproduce the fix. Describes the task shape, the repo layout the runtime
expects, and the schema your solution must satisfy.

## Task input shape

The task body (the solverView) carries the following fields under `goal.spec`:

- `goal.spec.instance_id` — e.g. `Jinn-Network__mono-1042`
- `goal.spec.repo` — always `Jinn-Network/mono`
- `goal.spec.base_commit` — git SHA: the commit the merged PR branched from
- `goal.spec.problem_statement` — the issue / PR description: what to fix

This is leak-controlled: the solverView deliberately carries **no test files and
no gold tests**. The PR's own test files are the held-out FAIL_TO_PASS gold the
evaluator runs against your patch. You do not see them, and you must not try to
reconstruct or satisfy them by editing test files — see Repository handling.

## Repository handling

Treat `$workingDir/repo` as the only task repository checkout. Do not reuse a
repo from another `workingDir` or from `implStateDir`. All in-tree edits must
live in `$workingDir/repo` — that's where the daemon's harvester reads a
`git diff` from to assemble your solution.

For a Relay round, follow this rule exactly:

```text
Clone goal.spec.relay.workspaceRepository when relay is present.
Fetch and checkout goal.spec.base_commit exactly.
Never push. Return only jinn-repo-solution.v1 patch bytes.
```

If `$workingDir/repo/.git` is missing, materialise the repo at
`<goal.spec.base_commit>` by fetching that exact SHA — **do not** `git clone`
and then `git checkout`. Run these commands verbatim (substituting the
base_commit and repository; use `goal.spec.relay.workspaceRepository` when
Relay is present, otherwise `goal.spec.repo`):

```bash
mkdir -p "$workingDir/repo" && cd "$workingDir/repo"
git init
git remote add origin https://github.com/<repository>.git
git fetch --depth 1 origin <goal.spec.base_commit>
git checkout FETCH_HEAD
```

Why this exact sequence, and not a clone: `<goal.spec.base_commit>` is the point
the merged PR branched from — frequently **off the current default branch tip**.
A `git clone` only brings down the default branch, so `git checkout
<goal.spec.base_commit>` then fails with `fatal: reference is not a tree`, and a
plain `git fetch origin` without the SHA won't help (it only pulls branch refs).
GitHub serves any SHA by id, so `git fetch --depth 1 origin
<goal.spec.base_commit>` retrieves exactly that one commit — fast, shallow, and
robust whether or not the SHA is on a branch. After `git checkout FETCH_HEAD`,
confirm you are on the base commit with `git rev-parse HEAD` (it must equal
`<goal.spec.base_commit>`) before editing.

## What to change, and what not to

- Read `<goal.spec.problem_statement>` and implement the fix **in
  `$workingDir/repo`**.
- **Do not write or edit tests.** The gold tests are held out; the harvester
  strips any test-file hunks from your diff before submission, so test edits are
  wasted effort at best and cannot satisfy the held-out gold tests.
- **Do not commit.** Leave your changes in the working tree (uncommitted) so
  `git diff` captures them. The harvester reads `git diff` over the checkout.

## Solution payload schema and submission

The solution is a **typed structured payload** handed back to the daemon. The
required shape for `jinn-repo.v1` restoration is:

```json
{
  "schemaVersion": "jinn-repo-solution.v1",
  "patch": "<unified diff, git-format>"
}
```

You do **not** need to assemble this payload by hand. After execution the daemon
harvests `git diff --binary` over `$workingDir/repo` automatically, strips
test-file hunks, and materialises the `jinn-repo-solution.v1` payload from the
result. Leaving your source fix uncommitted in the working tree is sufficient;
the diff is the solution.

If the active harness exposes a "submit typed payload" tool, you may submit the
payload above explicitly for immediate schema validation — but the auto-harvest
of the working-tree diff is authoritative and takes precedence over a stale
hand-written `<workingDir>/.execute/solution-payload.json`. Do **not** include
daemon-derived fields (e.g. trajectory CIDs) — the daemon attaches trajectory
provenance to the envelope automatically.
