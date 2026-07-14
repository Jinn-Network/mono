---
name: merge-batch
description: Use when the human is ready to integrate the ready pull requests into `next` — e.g. "merge the batch", "integrate the ready PRs", "batch-merge into next", "/merge-batch". Human-invoked only; not called by the dispatcher.
---

# merge-batch

You are the coordinating agent for one batch integration into `next`. For small
batches you may execute one wave. For large batches, especially 30-50 PRs, plan
deterministic waves first: survey PRs, build a manifest, group
dependency/overlap/refactor components, isolate large PRs, preflight each wave,
execute one wave at a time, checkpoint, and continue only while gates stay
green. For `next`, explicit human authorization may allow an admin/autopilot
approval or admin merge path after CI, Project, ordering, and conflict gates
pass. Do not bypass red CI, `Blocked on: Human`, semantic-conflict escalation,
or the Monday `next` → `main` cut.

## Read first

- [`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md) — work shapes, stacked PRs (strangler-fig mandate for `refactor`), `gh-stack` as the named stacking tool, the canary / Monday-cut cadence.
- [`CLAUDE.md`](../../../CLAUDE.md) — agent-canonical project guide.
- [`docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md`](../../../docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md) §5 (the merge skill design), §4 (the escalation model this skill inherits), §6 (the human integration cycle downstream).
- [`references/merge-mechanics.md`](references/merge-mechanics.md) — the concrete git/`gh`/`gh-stack` recipe for each step below.

---

## Step 1 — Survey the ready PRs

Fetch all open PRs:

```bash
gh pr list \
  --repo Jinn-Network/mono \
  --state open \
  --json number,title,headRefName,baseRefName,labels,statusCheckRollup,files
```

The survey must see PRs whose base is another open PR's head branch (upper stack layers), not just PRs based on `next` — dropping `--base next` is what makes the candidate set complete (AC #2). `baseRefName` feeds `enumerateStacks` (`packages/autopilot/src/dispatcher/stack-order.ts`), the candidate-set discovery + ordering function.

For each PR, re-check `statusCheckRollup`. The `implement-issue` pipeline only opened each PR when every gate passed, but CI can go stale — always verify the current rollup, not the one recorded at PR-open time.

A PR is **ready** when all CI checks are green (`statusCheckRollup` shows no failed or pending checks).

For each ready PR, fetch its linked issue and the issue's `Blocked on` Project field:

```bash
gh issue view <N> --json number,title,body,projectItems
```

Then read the `Blocked on` value from the "Jinn engineering" Project board:

```bash
gh project item-list 1 --owner Jinn-Network --format json \
  | jq '.items[] | select(.content.number == <N>) | .fieldValues'
```

Before applying review gating, determine whether this run has an explicit
`next` admin/autopilot authorization from the human. Phrases like "use admin to
approve and merge", "admin merge into next", or "autonomous autopilot flow" are
sufficient. This authorization applies only to this `next` batch run.

**Drop from the batch:**
- Any PR whose CI rollup is red or has pending checks.
- Any PR whose linked issue has `Blocked on: Human` (it is already a paused session; do not integrate it).
- Any PR that fails the **Review/admin gate** below.

### Review/admin gate

After the CI and `Blocked on: Human` drops, apply this gate to every surviving
PR. The operational source-of-truth — exact `gh` invocation, `latestReviews`
JSON shape, CODEOWNERS parsing (last-match-wins, `@`-stripping normalization),
glob semantics, admin authorization handling, and the gate pseudocode — lives in
[`references/merge-mechanics.md`](references/merge-mechanics.md) §Step 1.5.
This section states the rule the gate enforces; do not improvise mechanics
that disagree with the reference.

The rule, in one paragraph: for each surviving PR, parse `.github/CODEOWNERS`
at current `next` HEAD; for each touched file find the **last** matching
pattern (last-match-wins, GitHub's documented behaviour, *not*
`.gitignore`'s first-match-wins); collect the distinct owner-sets produced
across all touched files as `requiredOwnerSets`; exclude the PR author from
every set; filter `latestReviews` to entries that are `APPROVED`, were
submitted against the current `headRefOid` (stale approvals against earlier
SHAs do not count), and were not submitted by the author — call that set
`currentApprovers`.

Then decide by cases:

- **Coverage case** (`requiredOwnerSets` non-empty): keep iff every
  `S ∈ requiredOwnerSets` has `S ∩ currentApprovers ≠ ∅`. Otherwise drop
  with `skipped: awaiting code-owner review` unless admin/autopilot
  authorization is active for this `next` batch.

- **No-coverage case** (`requiredOwnerSets` empty — the common case in this
  repo, since CODEOWNERS only covers eight canonical docs): keep iff some
  entry in `currentApprovers` has `authorAssociation ∈ {"OWNER", "MEMBER"}`.
  `authorAssociation` is GitHub's own org-membership signal, returned inline
  in each `latestReviews` entry, so no separate allow-list file is needed.
  Otherwise drop with `skipped: awaiting maintainer review` unless
  admin/autopilot authorization is active for this `next` batch.

The two distinct skip reasons (`awaiting code-owner review` vs
`awaiting maintainer review`) tell the human which rule the PR failed —
the canonical-doc CODEOWNERS rule or the no-coverage maintainer rule. When
admin/autopilot authorization is active, do not drop these PRs for review
alone; keep them as `admin-authorized` candidates and annotate the manifest
with the missing review reason.

#### Admin/autopilot approval path for `next`

The autonomous autopilot flow is allowed to use admin authority for `next`
integration when the human explicitly authorizes it for the current batch. This
is a procedural integration approval, not a relaxation of CI or Project-state
gates. Use it only after:

1. CI is fully green.
2. The linked issue is not `Blocked on: Human`.
3. The ordered merge list has been surfaced.
4. The PR rebases/preflights cleanly, or any conflict is classified and handled.
5. The current `headRefOid` still matches the reviewed/planned head.

If those gates hold and a PR lacks a qualifying current reviewer, the merge
loop may submit an admin approval (`gh pr review <N> --approve ...`) when that
is accepted by GitHub, or use `gh pr merge --admin --rebase ...` when branch
protection blocks solely on review state and the authenticated account has
admin rights. Never use this path for `main` promotion.

After the CI / `Blocked on: Human` / code-owner drops, feed the surviving PRs' `{number, headRefName, baseRefName}` into `enumerateStacks(prs, 'next')`. Its `candidates` (ordered, tiered) are the **candidate set** for ordering; its `orphans` (base = deleted branch or a cycle) are reported separately (Step 5) and never dropped silently.

### Large-batch mode

Use large-batch mode when there are more than 10 candidate PRs, any PR is
`large` or `solo`, or the human asks to integrate multiple batches.
Large-batch mode is:

1. Produce a manifest with the `jinn-merge-batch plan` helper when structured
   PR metadata is available, or manually build the same manifest shape from the
   survey output.
2. Show waves and skipped PRs to the human.
3. Execute one wave at a time.
4. After each wave, verify `origin/next`, canary trigger, and manifest state.
5. Stop when drift, CI failure, semantic conflict, or human review need makes
   the next wave unsafe.

---

## Step 2 — Decide the merge order

Ordering is a **reasoning task, not a sort**. Inspect the candidate set and apply the three stacking tiers in order of precedence.

### Tier 1 — Known dependency stacks

The base-ref graph from `enumerateStacks` is the **authoritative** stack enumeration: a PR is stacked iff its `baseRefName` is another open PR's `headRefName`, regardless of the issue's `Blocked on: Another issue #A` field. The `Blocked on` field becomes a corroborating signal only — on disagreement the base graph wins, because it reflects actual branch topology. When `gh-stack` is available it is the named canonical tool for reading declared stack order; the base-graph walker (`enumerateStacks`) is the documented fallback (and the source of truth for the topology either way).

A PR whose `baseRefName` is another open PR's head branch is already branched on that PR's branch (the dispatcher stacked it at dispatch time). The root must merge before its dependents. Order each stack lower-layer-first (root depth 0 first), matching `OrderedPr.depth`.

If a stack has multiple levels (A blocks B which blocks C), order them A → B → C.

### Tier 2 — `refactor` stacks

A `refactor` shape's PRs form a strangler-fig stack per the handbook mandate. The `refactor` coordinating agent decomposed its work into a stack; integrate those PRs in their declared stack order. When `gh-stack` is available it is the authoritative source of the declared stack order; use `gh stack list` to read it. The title-prefix + overlapping-file-paths heuristic is the fallback for when `gh-stack` is not installed (see `references/merge-mechanics.md` — `gh-stack` is currently not installed in this environment).

### Tier 3 — Reactive overlap

Inspect the `files` lists of all remaining (non-stacked) PRs. Two PRs with intersecting file sets have unforeseen overlap. For each overlapping pair:
- Order them adjacent in the merge sequence.
- Merge the simpler one first (fewer changed files, or the narrower change) so the second rebases onto it.
- If the overlap is deep (the two changes touch the same function or module in ways that interact), plan to stack the second on the first reactively: after merging the first, rebase the second's branch on the new `next` immediately before merging it.

### Independent PRs

PRs with no overlap and no dependency/refactor relationship can be ordered freely. FIFO by PR number is correct for these.

### Inter-group ordering

All members of a Tier 1 dependency stack, a Tier 2 refactor stack, or a Tier 3 reactive-overlap group must stay **consecutive** in the merge order — a group is never interleaved with unrelated PRs. Once each group's internal order is fixed, order the groups (and any independent PRs) by each group's or PR's **lowest member number** (FIFO). This makes the full ordering deterministic when multiple groups and independent PRs are present.

### Output

Produce an **explicit ordered merge list** before executing any merges. Each entry must be annotated with its tier:

```
1. PR #42 — "fix(dashboard): hero stats do not update after claim"   [independent]
2. PR #38 — "feat(daemon): add balance topup loop"                   [independent]
3. PR #45 — "refactor(store): extract store interface, step 1/3"     [refactor-stack]
4. PR #46 — "refactor(store): migrate daemon to store interface"      [refactor-stack]
5. PR #47 — "refactor(store): remove legacy store path"               [refactor-stack]
6. PR #40 — "feat(bootstrap): add wallet recovery flow"               [dependency-stack, root]
7. PR #44 — "feat(bootstrap): recovery UI in operator dashboard"      [dependency-stack, on #40]
8. PR #50 — "fix(api): correct artifact search pagination"            [reactive-overlap, after #38]
```

Surface this list to the human **before** beginning the merge loop. The human may re-order or drop entries; proceed with their confirmation (or proceed without pausing if running in headless mode and the reasoning is sound).

---

## Step 3 — The merge loop

Work through the ordered merge list one PR at a time. For each PR, follow the recipe in `references/merge-mechanics.md`. The high-level loop:

### For each PR in order:

**3a. Rebase onto current `next`.**

Dispatch a **rebase subagent** with the PR's branch name and the current `next` HEAD. The subagent:
1. Runs `git worktree list` first to locate any existing worktree for the branch — a PR authored by `implement-issue` already has one. A branch checked out elsewhere cannot be re-checked-out in the primary tree, and a worktree carrying uncommitted changes must not be rebased in place (it would clobber the contributor's WIP); in that case rebase via a detached worktree pinned at `origin/<branch>`. See `references/merge-mechanics.md` §Step 2 for the locate and detached-worktree mechanics.
2. Fetches `origin/next`.
3. Rebases the PR branch onto `origin/next`.
4. Handles any conflicts (see Step 4 — Conflict handling).
5. Force-pushes the rebased branch (`--force-with-lease`).
6. Reports: branch rebased to SHA `<sha>`, conflict status, and the updated CI rollup URL.

**The coordinator verifies — it never trusts a "rebased fine" claim:**

```bash
# Verify the rebase subagent actually rebased (zero-commit-guard discipline)
git log origin/next..<branch> --oneline

# Re-check CI on the rebased head
gh pr checks <N> --watch
```

If the log is empty after a rebase that should have produced commits, dispatch a fix subagent.

**3b. Confirm gates are green on the rebased head.**

Wait for CI on the rebased branch. While waiting, the local fallback (typecheck + tests + build) can run in parallel:

```bash
cd client && yarn typecheck && yarn test && yarn build
```

Do not proceed to merge until the CI rollup is fully green.

**Review preservation after clean rebase.**

A clean rebase may preserve the skill's review gate only when:

```bash
git range-diff <old-base>..<old-head> <new-base>..<new-head>
```

shows patch-equivalent commits (`=` lines only). If `range-diff` shows changed,
added, or removed commits, move the PR to `awaiting-review` unless the human's
explicit admin/autopilot authorization is active for this `next` batch and the
coordinator has re-checked the changed patch. If GitHub branch protection
dismisses approvals after a push, either re-approve through the authorized
admin path or pause if the changed patch needs human review.

**3c. Merge into `next`.**

```bash
gh pr merge <N> --rebase --repo Jinn-Network/mono --match-head-commit <headRefOid>
```

If branch protection blocks solely on review state and this run is
admin/autopilot-authorized, use:

```bash
gh pr merge <N> --admin --rebase --repo Jinn-Network/mono --match-head-commit <headRefOid>
```

This keeps `next` linear (rebase-merge, not a merge commit). The push to `next` triggers the existing auto-canary — this is expected and not a concern.

**3d. Verify `next` advanced.**

```bash
git fetch origin
git log origin/next --oneline -3
```

Confirm the merged commits appear at the HEAD of `origin/next`. If they do not, investigate before proceeding.

**3e. Advance to the next PR in the list.**

`next` has now advanced. The remaining PRs need to be rebased onto the new `next` before they are ready to merge. Dispatch a **rebase subagent** for the *next* PR immediately (it can run while the coordinator records the just-completed merge). Apply the same verification discipline (3a) when the subagent reports back.

**Re-target stacked upper layers after the parent merges.** When a parent PR `A` (head branch `b/A`) merges into `next`, its branch is deleted by the rebase-merge. Any open PR whose base *was* `A`'s head branch is now pointed at a deleted branch — it must be re-targeted to `next`, then rebased, before it can merge:

```bash
gh pr edit <N> --repo Jinn-Network/mono --base next
# then dispatch the rebase subagent (3a) to rebase b/N onto origin/next
```

This closes the orphaned-upper-layer gap — the #534 / #593 failure described in the issue, where the upper layer of a stack was never discovered or re-targeted and silently fell out of the batch. Apply the same 3a verification discipline to the re-targeted PR.

**Repeat** until the ordered list is exhausted.

---

## Step 4 — Conflict handling and escalation

When a rebase produces a conflict, the rebase subagent classifies it before attempting resolution.

### Clean conflict — auto-resolve and continue

A conflict is **clean** when its resolution is mechanically unambiguous and leaves both changes' intent intact:
- Import ordering — two PRs added imports at the same location; intersperse them.
- Adjacent non-overlapping edits — two PRs changed different lines within a few lines of each other in a way git cannot auto-merge; the resolution is visually apparent.
- Formatting / whitespace — one PR reformatted a block while another edited it.

The rebase subagent resolves these in place, notes the resolution in its report, and continues.

### Semantic conflict — escalate and skip

A conflict is **semantic** when a correct resolution requires re-implementing the overlap, or when the subagent is not confident the resolution is correct:
- Two PRs changed the same function in ways that interact — the correct merged behavior must be reasoned about, not just mechanically combined.
- Two PRs refactored the same abstraction in incompatible directions.
- Any case where the subagent cannot confidently assert that the resolution preserves both PRs' intent.

**Do NOT guess.** On a semantic conflict:

1. **Ensure the issue is on the Project board.** An escalated PR's linked issue may not yet be on the "Jinn engineering" Project — `gh project item-edit` requires an existing board item, so add it first (idempotent — skip if already present):
   ```bash
   gh project item-add 1 --owner Jinn-Network \
     --url https://github.com/Jinn-Network/mono/issues/<issue-number>
   ```

2. **Route the PR's issue to `Blocked on: Human`.** Update the issue's Project field:
   ```bash
   gh project item-edit --id <item-id> --project-id <project-id> \
     --field-id <blocked-on-field-id> --single-select-option-id <human-option-id>
   ```

3. **Leave a one-paragraph note** as a comment on the issue explaining where you stopped and why:
   > "Stopped during merge-batch: this PR's branch conflicted semantically with PR #N (`<title>`). The conflict is in `<file>` — both PRs modified `<function/section>` in ways that interact. A correct resolution requires deciding `<the trade-off or re-implementation needed>`. Branch left at `<sha>` on `<branch>`. Resume with: `git checkout <branch>`."

4. **Skip this PR** — remove it from the active merge sequence.

5. **Continue the batch** with the remaining PRs. One bad PR never blocks the others.

### End-state property

At wrap-up, every PR from the manifest is in exactly one state:

- `merged` — integrated into `next`.
- `blocked-human` — semantic conflict or decision needed; linked issue set to
  `Blocked on: Human`.
- `awaiting-review` — review gate not satisfied; no Project mutation.
- `awaiting-ci` — CI pending or red; no Project mutation unless the failure is
  a semantic merge-batch finding.
- `deferred-large` — explicitly left for a solo wave.

No PR is left partially rebased, silently dropped, or merged without a matching
manifest entry.

---

## Step 5 — Wrap-up report

After the merge loop is exhausted, produce a structured report:

### Merged PRs (in order)

| Order | PR | Title | Final `next` HEAD after merge |
|-------|----|-------|-------------------------------|
| 1 | #42 | fix(dashboard): hero stats do not update after claim | `abc1234` |
| 2 | #38 | feat(daemon): add balance topup loop | `def5678` |
| … | | | |

Final `next` HEAD: `<sha>`

### Skipped PRs

| PR | Title | Reason | Issue status |
|----|-------|--------|--------------|
| #50 | fix(api): correct artifact search pagination | Semantic conflict with #38 in `src/api/server.ts` — both modified `searchArtifacts`; resolution needs re-implementation | `Blocked on: Human` |
| #61 | feat(client): add foo helper | Awaiting code-owner review — touched `/PRINCIPLES.md`, requires approval from `@oaksprout` or `@ritsukai` | unchanged (not routed to `Blocked on: Human`) |
| #62 | fix(daemon): correct foo race | Awaiting maintainer review — no CODEOWNERS coverage on touched paths; needs an approving review from a reviewer with `authorAssociation ∈ {OWNER, MEMBER}` | unchanged (not routed to `Blocked on: Human`) |

### Orphaned-base PRs

PRs whose base ref is neither `next` nor any other open PR's head branch — the
base branch was deleted, or the base graph contains a cycle. These were never
in the candidate set and were **not** dropped silently. Surface each with its
number, title, and current `baseRefName`, so the human can re-point or close it.

### Awaiting code-owner review

The last two skipped-PR rows above are **reporting-only**: the skill does not
write any Project field change for these. The PRs remain in their normal queue
state and become mergeable once a qualified reviewer approves. They are not in
`Blocked on: Human` — the gate is a queue signal at survey time, not an
escalation. Surface each such PR with:

- The PR number and author login.
- The missing owner-set, when the PR touched a CODEOWNERS-covered path
  (e.g. `requires approval from @oaksprout or @ritsukai`).
- The no-coverage flag, when no touched path matched CODEOWNERS
  (`no CODEOWNERS coverage — needed maintainer (OWNER/MEMBER) approval`).

When admin/autopilot authorization was active, include a separate line in the
merged table or notes for each PR merged through that path:

- `admin-authorized` — review gate was not already satisfied; merged into
  `next` using explicit admin/autopilot authorization after CI and Project gates
  passed.

### Human's next step

App-test `next`: install the canary build and use the app. Whatever you find while testing → `file-issue` skill → dispatcher queue.

```bash
npm install -g @jinn-network/client@canary
jinn run
```

---

## Failure modes

| Failure | Action |
|---|---|
| No ready PRs (all CI red or `Blocked on: Human`) | Report the empty candidate set and stop. No merges to perform. |
| Rebase subagent reports "rebased fine" but log is empty | Zero-commit guard: dispatch a fix subagent; re-verify git log. |
| Merge does not appear on `origin/next` after `gh pr merge` | Investigate and re-run before touching next PR. |
| CI stays pending on a rebased branch beyond a reasonable wait | Run local gates (typecheck + tests + build); if local is green, flag CI as the problem, surface to human, and pause. |
| A CI check fails on infrastructure grounds unrelated to the diff (runner timeout, network/registry flake, transient action error) | Re-run the failed check (`gh run rerun <run-id> --failed`) and re-read the rollup. Do **not** route the issue to `Blocked on: Human` — an infra flake is not a semantic conflict. Escalate only if it fails again on the same infra grounds after the re-run. |
| Semantic conflict cannot be cleanly described in one paragraph | Route to `Blocked on: Human` with whatever partial context you have; do not let classification difficulty block the batch. |
| All PRs in the batch route to `Blocked on: Human` | Report this outcome — the batch is empty-merged. The human needs to jump into the paused sessions. |
| PR drops to "awaiting code-owner review" (or "awaiting maintainer review") and no admin/autopilot authorization is active | Report the PR in the Step 5 skipped-PRs surface with the missing owner-set or `no CODEOWNERS coverage` note. Do not route the linked issue to `Blocked on: Human` — the gate is a queue signal, not an escalation. |
| PR lacks qualifying review and admin/autopilot authorization is active | Keep the PR as `admin-authorized`; merge with normal rebase merge first, then `--admin` only if branch protection blocks solely on review state. |

---

## Composition

- Upstream: `implement-issue` produces the draft PRs this skill consumes. The skill works on any ready PRs against `next`; it does not require `implement-issue` to have produced them.
- Downstream: `next` advances; the existing auto-canary publishes a canary build; the human app-tests `next` (spec §6); the Monday `promote-main.yml` cut is unchanged.
- Rebase mechanics: see `references/merge-mechanics.md`.
- Does not invoke: the Autopilot dispatcher (the dispatcher is not involved in the merge phase), the Monday cut (untouched by this skill).
