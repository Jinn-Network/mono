# merge-mechanics — concrete git/`gh` recipe

This reference is the step-by-step recipe the `merge-batch` SKILL.md delegates to.
All commands assume `Jinn-Network/mono` as the repo and `next` as the integration branch.
`next` requires linear history — rebase-merge only, no merge commits.

---

## Large-batch wave mechanics

For batches above 10 PRs, or any batch containing a large/solo PR, do not hold a
single 30-50 PR serial loop in working memory. Build a manifest and execute one
wave at a time.

Wave preflight uses a temporary branch:

```bash
git fetch origin
git switch --detach origin/next
git switch -c integrate/merge-batch-<date>-wave-<n>
```

Apply the wave's PR branches in manifest order. If a wave does not preflight
cleanly, split the wave or defer the specific PR that caused the conflict. Do
not mutate `next` until the current wave's plan is understood.

After each wave:

```bash
git fetch origin
git rev-parse origin/next
```

Record the new `origin/next` SHA in the batch report before planning or
executing the next wave. If `origin/next` changed outside the batch, stop and
rebuild the manifest.

---

## Step 1 — Detect the ready PRs

### Fetch all open PRs

```bash
gh pr list \
  --repo Jinn-Network/mono \
  --state open \
  --json number,title,headRefName,baseRefName,statusCheckRollup,files
```

`baseRefName` is required so candidate-set discovery (`enumerateStacks`) can classify each PR as root / stacked / orphan. Dropping `--base next` is what lets the survey see upper stack layers (PRs based on another open PR's head branch).

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

## Step 1.5 — Review/admin gate mechanics

This section is the operational source-of-truth for the Review/admin gate
introduced in `SKILL.md` §Step 1. `SKILL.md` states the rule; this section
states the algorithm.

### Detect admin/autopilot authorization

Before applying review gating, decide whether the human explicitly authorized
admin/autopilot integration for this `next` batch. Treat phrases such as "use
admin to approve and merge", "admin merge into next", or "autonomous autopilot
flow" as authorization for the current batch. This flag applies only to `next`
integration and never to `main` promotion.

### Fetch the review state

For each PR that survives the CI and `Blocked on: Human` drops:

```bash
gh pr view <N> --repo Jinn-Network/mono \
  --json author,latestReviews,reviewDecision,files,headRefOid
```

`reviewDecision` alone is insufficient. The 2026-05-25 PR #423 / PR #607
incident proved that `reviewDecision` returns `APPROVED` for any approving
review, with no signal about *who* approved or against *which* head SHA. The
gate ignores `reviewDecision` and reasons from `latestReviews` directly.

### `latestReviews` shape

`latestReviews` returns the **most recent review per reviewer** — not the full
review history. For each entry, the gate consumes these fields:

```json
{
  "author":             { "login": "oaksprout" },
  "authorAssociation":  "OWNER",
  "state":              "APPROVED",
  "commit":             { "oid": "ccc3333..." },
  "submittedAt":        "2026-05-26T09:00:00Z"
}
```

- `author.login` — the reviewer's GitHub handle, without the `@` prefix.
- `authorAssociation` — the reviewer's relationship to the repo, set by
  GitHub. Documented values: `OWNER`, `MEMBER`, `COLLABORATOR`,
  `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, `NONE`.
  The no-coverage rule whitelists `OWNER` and `MEMBER` **only**.
- `state` — one of `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`,
  `PENDING`. The gate counts only `APPROVED`.
- `commit.oid` — the head SHA the review was submitted against. The gate
  compares this against the PR's current `headRefOid` to detect stale
  approvals.

Because `latestReviews` returns the most recent review per reviewer, a later
`CHANGES_REQUESTED` or `DISMISSED` review from the same reviewer **supersedes**
an earlier `APPROVED` review from that reviewer. State this explicitly so the
agent does not double-count an obsolete approval — there is no "approved once,
counts forever" path.

### CODEOWNERS parsing recipe

Read `.github/CODEOWNERS` from disk (the worktree at the current `next` HEAD).
Each non-blank, non-comment line is a CODEOWNERS rule:

```
<glob>   <owner1>   <owner2>   ...
```

- Skip blank lines and lines beginning with `#` (comments).
- Each remaining line yields an ordered entry `(pattern, owners[])`.
- Owner tokens in CODEOWNERS begin with `@` (e.g. `@oaksprout`); the
  `latestReviews[*].author.login` field is the bare handle (e.g.
  `oaksprout`). The gate compares owners against approver logins **without
  the leading `@`** — normalize the CODEOWNERS owner tokens by stripping the
  `@` prefix before set-membership tests. Team owners (`@org/team-name`) are
  not used in the current CODEOWNERS file; if added later, the matcher must
  expand them to their member set.
- An empty owner set on a matching pattern explicitly clears coverage (rare
  but possible).

**Precedence: last-match-wins.** This is GitHub's documented behaviour and
differs from `.gitignore`'s first-match-wins. For a given file path, iterate
the entries from top to bottom; the **last** entry whose pattern matches the
path is the entry that applies. Earlier matches are overridden.

#### Glob semantics

- `/PATH` is repo-rooted (relative to repo root, like `/PRINCIPLES.md`).
- `*` matches anything **except** `/` (does not cross directory boundaries).
- `**` matches anything including `/` (crosses directory boundaries).

For the current `Jinn-Network/mono` CODEOWNERS, the only patterns are
exact-file rules (`/PRINCIPLES.md`, `/SPEC.md`, …) so the matcher does not
need full gitignore-style pattern support. State this as the **current-state**
observation, not a permanent simplification — if CODEOWNERS later grows
overlapping glob patterns, the matcher must implement the rules above
faithfully.

Reference: GitHub's CODEOWNERS documentation describes the syntax and the
last-match-wins precedence.

### The gate algorithm

For each PR `P` that survives the prior Step 1 drops:

1. Parse `.github/CODEOWNERS` into an ordered list of `(pattern, owners[])`
   entries.
2. Fetch the JSON payload with the `gh pr view` invocation above.
3. **Per-file owner-set lookup.** For each `file` in `P.files`, walk the
   ordered CODEOWNERS entries; record the owner set of the **last** entry
   whose `pattern` matches `file.path`. A file matched by no entry contributes
   an empty owner set.
4. **Build `requiredOwnerSets` and `requiredOwnersUnion`.**
   - `requiredOwnerSets` = the distinct non-empty owner sets produced across
     the touched files. (Empty owner sets from unmatched files are discarded
     here — they signal no coverage for that file, not a satisfied
     requirement.)
   - `requiredOwnersUnion` = the union of all sets in `requiredOwnerSets`.
   - Remove `P.author.login` from every set in `requiredOwnerSets` and from
     `requiredOwnersUnion`. An author can never satisfy their own code-owner
     requirement (state this so it is not overlooked when the author is
     listed in a CODEOWNERS rule that covers a file they touched).
5. **Build `currentApprovers`.**
   ```
   currentApprovers = { r
                        | r ∈ P.latestReviews,
                          r.state == "APPROVED",
                          r.commit.oid == P.headRefOid,
                          r.author.login != P.author.login }
   ```
   `currentApprovers` is the set of qualifying review **entries** (each one
   carries `author.login` and `authorAssociation` alongside the other review
   fields). Set-membership tests against owner-sets compare against
   `r.author.login`; the no-coverage rule (Step 7) also inspects
   `r.authorAssociation`. The `commit.oid == headRefOid` clause is the
   stale-approval filter; a new commit pushed after the approval invalidates
   the approval. The `r.author.login != P.author.login` clause is the
   author-exclusion filter — an author can never satisfy their own review
   requirement (see Edge cases below).
6. **Coverage-case decision.** If `requiredOwnerSets` is non-empty: keep `P`
   iff for every `S ∈ requiredOwnerSets`,
   `S ∩ { r.author.login | r ∈ currentApprovers } ≠ ∅`. If this is false and
   admin/autopilot authorization is active, keep `P` as `admin-authorized`
   with detail `would otherwise be skipped: awaiting code-owner review`.
   Otherwise drop with `skipped: awaiting code-owner review`.
7. **No-coverage-case decision.** If `requiredOwnerSets` is empty (every
   touched file was unmatched by CODEOWNERS): keep `P` iff there exists
   `r ∈ currentApprovers` with `r.authorAssociation ∈ {"OWNER", "MEMBER"}`.
   If this is false and admin/autopilot authorization is active, keep `P` as
   `admin-authorized` with detail `would otherwise be skipped: awaiting
   maintainer review`. Otherwise drop with `skipped: awaiting maintainer
   review`. Note that `currentApprovers` (computed at Step 5) has already
   filtered for `state == "APPROVED"`, fresh `commit.oid`, and non-author —
   Step 7 composes on top of those filters rather than re-deriving them.

### Admin/autopilot merge execution

For `admin-authorized` PRs, keep all non-review gates intact:

1. CI must be fully green.
2. The linked issue must not be `Blocked on: Human`.
3. The PR must be in the surfaced ordered merge list.
4. Rebase/preflight must complete cleanly or any conflict must be classified
   and handled under the normal conflict rules.
5. `--match-head-commit` must match the head that was planned and checked.

Attempt the ordinary rebase merge first:

```bash
gh pr merge <N> --rebase --repo Jinn-Network/mono --match-head-commit <headRefOid>
```

If that fails solely because branch protection still requires review and the
human authorized the admin path for this `next` run, either submit an admin
approval if GitHub accepts it:

```bash
gh pr review <N> --repo Jinn-Network/mono --approve \
  --body "Admin/autopilot approval for next integration batch."
```

or perform the admin rebase merge:

```bash
gh pr merge <N> --admin --rebase --repo Jinn-Network/mono --match-head-commit <headRefOid>
```

Do not use `--admin` for red CI, pending CI, `Blocked on: Human`, semantic
conflicts, an unexpected head SHA, or `main` promotion.

### Edge cases

- **Author's own approval.** If the only `latestReviews` entry on a PR is an
  approval the author submitted on themselves (e.g. via the API), it must not
  satisfy either normal-review rule. This is enforced by the author-exclusion
  step in `currentApprovers` (the `r.author.login != P.author.login` clause).
  If the human authorized admin/autopilot integration, record the PR as
  `admin-authorized` instead of pretending the author's own approval satisfied
  the normal gate.
- **Superseded approvals.** Because `latestReviews` returns the most recent
  review per reviewer, a `DISMISSED` or `CHANGES_REQUESTED` review submitted
  after an earlier `APPROVED` review from the same reviewer fully supersedes
  the approval — the entry in `latestReviews` for that reviewer carries the
  later state, not the earlier one. The agent never needs to walk back through
  earlier reviews from the same reviewer.
- **Stale approvals after rebase.** When the merge loop rebases a PR in
  Step 2 and force-pushes (`--force-with-lease`), the head SHA changes. The
  strict survey-time gate filters approvals by `commit.oid == headRefOid`, so
  a rebased PR must either pass the gate again or satisfy the clean-rebase
  approval-preservation rule below. Do not assume approval persists across a
  rebase without the `range-diff` check.

### Drop-report wording

PRs that fail the gate are dropped with one of two reasons:

- `skipped: awaiting code-owner review` — the coverage case
  (`requiredOwnerSets` was non-empty but at least one owner-set was not
  satisfied by `currentApprovers`).
- `skipped: awaiting maintainer review` — the no-coverage case
  (`requiredOwnerSets` was empty and `currentApprovers` did not contain a
  reviewer with `authorAssociation ∈ {OWNER, MEMBER}`).

Surface each dropped PR in the Step 5 wrap-up report under the
"Awaiting code-owner review" subsection — name the missing owner-set (when
coverage was required) or the no-coverage flag.

If admin/autopilot authorization was active, these review gaps are not skip
reasons. Surface them in the merged/wave report as `admin-authorized` notes
instead.

---

## Step 2 — Rebase a PR onto `next`

### Locate the PR's worktree first

Before rebasing, find any existing checkout of the PR's branch:

```bash
git worktree list
```

A PR opened by `implement-issue` was authored in its own worktree, which
usually lives at `../jinn-mono_worktrees/<issue-number>/` (the current
handbook convention) or the legacy `cargo/.tasks/<issue>/` path. The location
is not fixed — treat the `git worktree list` output as authoritative rather
than guessing the path.

This matters because a branch already checked out in another worktree **cannot
be checked out again** in the primary tree: `git checkout <branch>` fails with
`fatal: '<branch>' is already checked out at '<path>'`. If the branch is listed
against a foreign worktree, do not `git checkout` it here — rebase inside that
worktree, or use the detached-worktree recipe below.

### When the existing worktree has uncommitted changes

If `git worktree list` shows the branch in a foreign worktree and that tree has
uncommitted changes (a dirty working tree carrying a contributor's WIP), do
**not** rebase in place — that would either fail on the dirty index or clobber
unsaved work. Instead, create a throwaway detached worktree pinned at the
remote ref and rebase there:

```bash
git fetch origin
git worktree add --detach /tmp/merge-batch-<N> origin/<branch>
cd /tmp/merge-batch-<N> && git rebase origin/next
git push origin HEAD:<branch> --force-with-lease
git worktree remove /tmp/merge-batch-<N>
```

This rebases from the canonical `origin/<branch>` ref and leaves the
contributor's WIP in their worktree untouched. The `--force-with-lease` push
updates the remote branch; the contributor re-syncs their worktree afterward.

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

### Approval preservation after clean rebase

Record the old base/head before rebasing:

```bash
OLD_BASE=$(git merge-base origin/next <branch-name>)
OLD_HEAD=$(git rev-parse <branch-name>)
```

After rebasing, compare the old and new patch series:

```bash
NEW_BASE=$(git merge-base origin/next <branch-name>)
NEW_HEAD=$(git rev-parse <branch-name>)
git range-diff "$OLD_BASE..$OLD_HEAD" "$NEW_BASE..$NEW_HEAD"
```

Only `=` lines preserve the normal review gate. A `!`, added commit, removed
commit, or conflict-resolution commit means the reviewed patch changed; move
the PR to `awaiting-review` unless explicit admin/autopilot authorization is
active for this `next` batch and the coordinator has re-checked the changed
patch. GitHub branch protection is authoritative unless the current run is
admin-authorized and the only remaining blocker is review state.

---

## Step 3 — Merge a PR into `next`

```bash
gh pr merge <N> --rebase --repo Jinn-Network/mono --match-head-commit <headRefOid>
```

For `admin-authorized` PRs, use the admin execution recipe in Step 1.5 if the
ordinary merge is blocked solely by review state.

`--rebase` performs a rebase-merge, keeping `next` linear (no merge commits).
`--match-head-commit` prevents a time-of-check/time-of-use race where a new
commit lands on the PR branch after the skill verified CI and review state.

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

The stack topology comes from `enumerateStacks` in
`packages/eng-loop/src/dispatcher/stack-order.ts` (base-ref graph:
`baseRefName === another open PR's headRefName` ⇒ stacked). After the parent
merges, the upper layer is pointed at the now-deleted parent branch — it must be
re-targeted to `next` (`gh pr edit <N> --repo Jinn-Network/mono --base next`)
*before* the rebase shown below, else the rebase has no valid base.

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

**Merge each layer in order** using the same `gh pr merge ... --match-head-commit`
command from Step 3. Never merge a dependent before its root.

### When `gh-stack` is installed

Once installed, `gh-stack` manages the rebase cascade automatically. Install via:

```bash
gh extension install timrogers/gh-stack
```

Verify installation: `gh stack --help`. After that, document the live commands
by running `gh stack --help` — replace this section's fallback with the actual
`gh-stack` commands once the extension is on-path.
