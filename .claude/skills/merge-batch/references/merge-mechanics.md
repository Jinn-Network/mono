# merge-mechanics — concrete git/`gh` recipe

This reference is the step-by-step recipe the `merge-batch` SKILL.md delegates to.
All commands assume `Jinn-Network/mono` as the repo and `next` as the integration branch.
`next` requires linear history — rebase-merge only, no merge commits.

---

## Step 1 — Detect the ready PRs

### Fetch all open PRs against `next`

```bash
gh pr list \
  --repo Jinn-Network/mono \
  --base next \
  --state open \
  --json number,title,headRefName,statusCheckRollup,files
```

### Reading `statusCheckRollup`

Each PR in the JSON result contains a `statusCheckRollup` array. Each entry has:

| Field | Meaning |
|-------|---------|
| `conclusion` | `"SUCCESS"`, `"FAILURE"`, `"CANCELLED"`, `"SKIPPED"`, or `null` (pending) |
| `status` | `"COMPLETED"`, `"IN_PROGRESS"`, `"QUEUED"`, `"WAITING"` |
| `name` | The check name (e.g. `"typecheck"`, `"test"`, `"build"`) |

A PR is **green** when every entry has `conclusion == "SUCCESS"` (or `"SKIPPED"` for
non-required checks) and `status == "COMPLETED"`.

A PR is **red** when any entry has `conclusion` in `["FAILURE", "CANCELLED"]`.

A PR is **pending** when any entry has `status` in `["IN_PROGRESS", "QUEUED", "WAITING"]`
or `conclusion == null`.

**Drop from the batch:** any PR that is red or has pending checks.

### Fetch the linked issue and its `Blocked on` Project field

```bash
# Get the issue number and body
gh issue view <N> --json number,title,body,projectItems
```

Then read the `Blocked on` field from the "Jinn engineering" Project board
(project number 1 under the `Jinn-Network` org):

```bash
gh project item-list 1 \
  --owner Jinn-Network \
  --format json \
  | jq '.items[] | select(.content.number == <N>) | .fieldValues'
```

**Drop from the batch:** any PR whose linked issue has `Blocked on: Human`.
That item is already in a paused session — do not integrate it.

---

## Step 2 — Rebase a PR onto `next`

### Fetch latest remote state

```bash
git fetch origin
```

### Rebase the PR branch

```bash
git checkout <branch-name>
git rebase origin/next
```

### Telling a clean rebase from a conflicted one

`git rebase` exits **0** on success and drops you back to the shell with a
summary like:

```
Successfully rebased and updated refs/heads/<branch-name>.
```

On conflict it exits **non-zero**, prints something like:

```
CONFLICT (content): Merge conflict in src/daemon/daemon.ts
error: could not apply abc1234... feat(daemon): add balance topup loop
hint: Resolve all conflicts manually, mark them as resolved with
hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
```

Check the current state at any point with `git status` — lines marked
`both modified:` or `deleted by us:` are conflicts requiring resolution.

After resolving conflicts:

```bash
git add <resolved-file(s)>
git rebase --continue
```

To abort and restore the branch to its pre-rebase state:

```bash
git rebase --abort
```

### Zero-commit guard

After a rebase that should have produced commits, verify:

```bash
git log origin/next..<branch-name> --oneline
```

If the output is empty when commits are expected, the rebase silently fast-forwarded
or nothing was applied. Investigate before proceeding — do not claim a "rebased fine"
result against an empty log.

### Force-push the rebased branch

```bash
git push origin <branch-name> --force-with-lease
```

`--force-with-lease` refuses the push if someone else has pushed to the same branch
since your last fetch. If it fails with `rejected ... stale info`, run
`git fetch origin` and re-verify before re-trying.

---

## Step 3 — Merge a PR into `next`

```bash
gh pr merge <N> --rebase --repo Jinn-Network/mono
```

`--rebase` performs a rebase-merge, keeping `next` linear (no merge commits).

### After merging — verify `next` advanced

```bash
git fetch origin
git log origin/next --oneline -5
```

The merged commits must appear at the HEAD of `origin/next`. If they do not,
investigate before touching the next PR in the batch.

### Auto-canary note

Pushing to `next` triggers the existing auto-canary workflow which publishes a
`<v>-canary.<sha>` npm package. This is **expected** — every merge into `next` emits
a new canary. It is not a concern and does not require intervention.

---

## Step 4 — Re-gate after `next` advances

After merging one PR, every remaining PR in the batch is stale against the new `next`
and must be rebased before it can merge. Re-gating is:

**4a. Force-push the rebased branch (from Step 2) — this re-triggers CI.**

The push to the PR branch automatically re-runs the branch's CI checks.

**4b. Wait for the rollup:**

```bash
gh pr checks <N> --watch
```

This streams check status in real time and exits when all checks have completed
(green or red).

**4c. Local gate fallback** — run this in parallel when CI is slow or during
offline development:

```bash
cd client && yarn typecheck && yarn test && yarn build
```

A PR is only ready to merge when the CI rollup is fully green. Do not substitute
a green local fallback for a red or pending CI rollup — local and CI environments
can differ.

---

## Step 5 — Clean-vs-semantic conflict detection

When `git rebase origin/next` hits a conflict, classify it before attempting
resolution.

### Clean conflict — auto-resolve and continue

A conflict is **clean** when its resolution is **mechanically unambiguous** and
**leaves both changes' intent intact**. The correct merged file is evident from
inspection alone, without needing to understand runtime behavior.

**Examples of clean conflicts:**

1. **Import ordering.** PR #A adds `import { foo } from './foo'` at line 3;
   PR #B adds `import { bar } from './bar'` at the same line. Resolution:
   intersperse the two imports in alphabetical order. Neither change's intent
   is lost.

2. **Adjacent non-overlapping edits.** PR #A changes the return value on line
   42; PR #B adds a `logger.debug` call on line 40. Git cannot auto-merge
   because the hunks are adjacent, but the resolution is visually obvious:
   accept both edits.

3. **Whitespace / formatting.** PR #A ran the formatter over a block while
   PR #B added a line inside the same block. The resolution is to accept
   PR #B's line inside the formatted block.

Resolve in place, record the resolution in the subagent report, and continue.

### Semantic conflict — escalate and skip

A conflict is **semantic** when a correct resolution **requires reasoning about
overlapping logic** — the right merged behavior is not mechanically derivable
from the two change-sets.

**Examples of semantic conflicts:**

1. **Same function, incompatible changes.** PR #A refactors `searchArtifacts`
   to be async; PR #B adds a synchronous retry loop inside the same function.
   Making both work together requires re-designing the retry path, not just
   combining text.

2. **Incompatible abstraction directions.** PR #A extracts `StoreInterface` and
   moves `daemon.ts` to use it; PR #B adds a new method directly to the
   concrete `Store` class that `daemon.ts` now calls before #A's refactor
   is applied. The correct resolution requires deciding which interface shape
   wins and updating the callers accordingly.

3. **Logic interacts across the conflict site.** PR #A changes the type of a
   config field from `string` to `string[]`; PR #B adds a `typeof`-guard
   branch that assumes the field is always a `string`. The guard's correctness
   depends on the type choice — the resolution cannot be made purely by
   looking at the diff.

**Do NOT guess on semantic conflicts.** Route the PR's issue to `Blocked on: Human`
and skip the PR (see `SKILL.md` §Step 4 for the full escalation protocol).

---

## Step 6 — Stacked PRs

### `gh-stack` availability

> **`gh-stack` is NOT installed in this environment** (`which gh-stack` returns
> nothing). The handbook (`docs/engineering/handbook.md`) lists it as the
> canonical stacking tool but it is not present on this machine. Use the
> plain-git fallback below until `gh-stack` is installed.

### Plain-git stacked-rebase fallback

Stacked PRs are linked chains: branch `B` is based on branch `A`, which is based
on `next`. When `next` advances (because `A` merged), each subsequent layer must
be rebased onto its parent in order, bottom-up.

**For a two-level stack (A → B):**

```bash
# A has already merged into next. Rebase B onto the new next.
git fetch origin
git checkout <B-branch>
git rebase origin/next
git push origin <B-branch> --force-with-lease
```

**For a three-level stack (A → B → C):**

```bash
git fetch origin

# After A merges: rebase B onto next
git checkout <B-branch>
git rebase origin/next
git push origin <B-branch> --force-with-lease

# After B merges: rebase C onto next
git checkout <C-branch>
git rebase origin/next
git push origin <C-branch> --force-with-lease
```

The rule: always rebase onto `origin/next`, not onto the parent branch. Once the
parent has merged into `next`, `origin/next` *is* the parent's base.

**Verify each layer before merging:**

```bash
# Confirm the layer's commits are present and the stack is intact
git log origin/next..<branch> --oneline
```

**Merge each layer in order** using the same `gh pr merge <N> --rebase` command
from Step 3. Never merge a dependent before its root.

### When `gh-stack` is installed

Once installed, `gh-stack` manages the rebase cascade automatically. Install via:

```bash
gh extension install timrogers/gh-stack
```

Verify installation: `gh stack --help`. After that, document the live commands
by running `gh stack --help` — replace this section's fallback with the actual
`gh-stack` commands once the extension is on-path.
