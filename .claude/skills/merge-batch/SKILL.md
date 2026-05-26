---
name: merge-batch
description: Use when the human is ready to integrate the ready pull requests into `next` — e.g. "merge the batch", "integrate the ready PRs", "batch-merge into next", "/merge-batch". Human-invoked only; not called by the dispatcher.
---

# merge-batch

You are the coordinating agent for one batch integration. The human invokes you when they are ready to integrate the ready pull requests into `next`. You survey the open ready PRs, decide a conflict-aware merge order, merge them one at a time, rebase and re-gate each remaining PR after `next` advances, auto-resolve clean conflicts, and escalate a genuine semantic conflict — routing that one PR's issue to `Blocked on: Human` — without blocking the rest of the batch. You do not touch the Monday `next` → `main` cut; you only feed `next`.

## Read first

- [`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md) — work shapes, stacked PRs (strangler-fig mandate for `refactor`), `gh-stack` as the named stacking tool, the canary / Monday-cut cadence.
- [`CLAUDE.md`](../../../CLAUDE.md) — agent-canonical project guide.
- [`docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md`](../../../docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md) §5 (the merge skill design), §4 (the escalation model this skill inherits), §6 (the human integration cycle downstream).
- [`references/merge-mechanics.md`](references/merge-mechanics.md) — the concrete git/`gh`/`gh-stack` recipe for each step below.

---

## Step 1 — Survey the ready PRs

Fetch all open PRs against `next`:

```bash
gh pr list \
  --repo Jinn-Network/mono \
  --base next \
  --state open \
  --json number,title,headRefName,labels,statusCheckRollup,files
```

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

**Drop from the batch:**
- Any PR whose CI rollup is red or has pending checks.
- Any PR whose linked issue has `Blocked on: Human` (it is already a paused session; do not integrate it).
- Any PR that fails the **Code-owner review gate** below.

### Code-owner review gate

After the CI and `Blocked on: Human` drops, apply this gate to every surviving
PR. The operational mechanics (exact `gh` invocation, JSON-shape details,
CODEOWNERS-parsing recipe, glob semantics, pseudocode) live in
[`references/merge-mechanics.md`](references/merge-mechanics.md) §Step 1.5; this
section states the rule the gate enforces.

For each surviving PR, fetch:

```bash
gh pr view <N> --repo Jinn-Network/mono \
  --json author,latestReviews,reviewDecision,files,headRefOid
```

Then:

1. **Parse `.github/CODEOWNERS`** at the current `next` HEAD into ordered
   path-pattern → owner-set entries. CODEOWNERS uses **last-match-wins**
   precedence (this is GitHub's documented behaviour, *not* `.gitignore`'s
   first-match-wins). State this explicitly so the executing agent does not
   improvise glob precedence.

2. **Compute `requiredOwners`** per PR: for each file the PR touches, find the
   **last** matching CODEOWNERS pattern; collect that entry's owner set. Take
   the distinct owner-sets produced across all touched files as
   `requiredOwnerSets`; the union as `requiredOwnersUnion`. Each distinct
   owner-set must be satisfied by at least one matching approval.

3. **Exclude the PR author.** Remove `author.login` from every set in
   `requiredOwnerSets` and from `requiredOwnersUnion`. An author can never
   satisfy their own code-owner requirement.

4. **Filter `latestReviews` to current approvals.** From `latestReviews`, keep
   entries where `state == "APPROVED"` AND `commit.oid == headRefOid` AND
   `author.login != PR.author.login`. Call the resulting reviewer-set
   `currentApprovers`. Approvals against earlier head SHAs are **stale** and do
   not count — rebases during the merge loop change head SHAs, and the gate
   must re-verify at survey time rather than trust branch protection.

5. **Decide approval by cases:**

   - **Coverage case** (`requiredOwnerSets` is non-empty): keep the PR iff
     every distinct owner-set in `requiredOwnerSets` has at least one current
     approver in it — i.e. for every `S ∈ requiredOwnerSets`,
     `S ∩ currentApprovers ≠ ∅`. Otherwise drop with
     `skipped: awaiting code-owner review`.

   - **No-coverage case** (`requiredOwnerSets` is empty — the common case in
     this repo, since CODEOWNERS only covers eight canonical docs): keep the
     PR iff at least one entry in `currentApprovers` has
     `authorAssociation ∈ {"OWNER", "MEMBER"}`. `authorAssociation` is
     GitHub's own org-membership signal, returned inline in each
     `latestReviews` entry, so no separate allow-list file is needed.
     Otherwise drop with `skipped: awaiting maintainer review`.

   The two distinct skip reasons (`awaiting code-owner review` vs
   `awaiting maintainer review`) tell the human which rule the PR failed —
   the canonical-doc CODEOWNERS rule or the no-coverage maintainer rule.

#### Refusal clause — operator authorization does not bypass the gate

Operator authorization to approve PRs is procedural only — it never
substitutes for code-owner review. **The code-owner gate runs *before*
operator authorization is consulted.** If the gate would drop a PR, the skill
drops it; it does not submit an approving review on the operator's behalf,
regardless of any blanket authorization given for this batch. This applies
verbatim to the "approve any PR you would have approved yourself" pattern that
preceded the PR #423 / PR #607 incident on 2026-05-25 — that authorization is
exhausted before the gate runs, not after.

The remaining PRs form the **candidate set** for ordering.

---

## Step 2 — Decide the merge order

Ordering is a **reasoning task, not a sort**. Inspect the candidate set and apply the three stacking tiers in order of precedence.

### Tier 1 — Known dependency stacks

A PR whose linked issue carries `Blocked on: Another issue #A` is already branched on A's branch (the dispatcher stacked it at dispatch time). A must merge before its dependents. Order each stack bottom-up: root first, dependents after it in the sequence.

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
1. Fetches `origin/next`.
2. Rebases the PR branch onto `origin/next`.
3. Handles any conflicts (see Step 4 — Conflict handling).
4. Force-pushes the rebased branch (`--force-with-lease`).
5. Reports: branch rebased to SHA `<sha>`, conflict status, and the updated CI rollup URL.

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
yarn typecheck && yarn test && yarn build
```

Do not proceed to merge until the CI rollup is fully green.

**3c. Merge into `next`.**

```bash
gh pr merge <N> --rebase --repo Jinn-Network/mono
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

1. **Route the PR's issue to `Blocked on: Human`.** Update the issue's Project field:
   ```bash
   gh project item-edit --id <item-id> --project-id <project-id> \
     --field-id <blocked-on-field-id> --single-select-option-id <human-option-id>
   ```

2. **Leave a one-paragraph note** as a comment on the issue explaining where you stopped and why:
   > "Stopped during merge-batch: this PR's branch conflicted semantically with PR #N (`<title>`). The conflict is in `<file>` — both PRs modified `<function/section>` in ways that interact. A correct resolution requires deciding `<the trade-off or re-implementation needed>`. Branch left at `<sha>` on `<branch>`. Resume with: `git checkout <branch>`."

3. **Skip this PR** — remove it from the active merge sequence.

4. **Continue the batch** with the remaining PRs. One bad PR never blocks the others.

### The two-queue property

When the batch is complete, every PR is in exactly one of two states:
- **Integrated into `next`** — merged, linear, canary build triggered.
- **`Blocked on: Human`** — a paused, resumable item with a note explaining why.

No PR is left in an ambiguous state (partially rebased, merged without gates, or silently dropped).

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
| Semantic conflict cannot be cleanly described in one paragraph | Route to `Blocked on: Human` with whatever partial context you have; do not let classification difficulty block the batch. |
| All PRs in the batch route to `Blocked on: Human` | Report this outcome — the batch is empty-merged. The human needs to jump into the paused sessions. |
| PR drops to "awaiting code-owner review" (or "awaiting maintainer review") | Report the PR in the Step 5 skipped-PRs surface with the missing owner-set or `no CODEOWNERS coverage` note. Do **not** approve the PR on the operator's behalf and do **not** route the linked issue to `Blocked on: Human` — the gate is a queue signal, not an escalation. |

---

## Composition

- Upstream: `implement-issue` produces the draft PRs this skill consumes. The skill works on any ready PRs against `next`; it does not require `implement-issue` to have produced them.
- Downstream: `next` advances; the existing auto-canary publishes a canary build; the human app-tests `next` (spec §6); the Monday `promote-main.yml` cut is unchanged.
- Rebase mechanics: see `references/merge-mechanics.md`.
- Does not invoke: `eng-orchestrator` (the dispatcher is not involved in the merge phase), the Monday cut (untouched by this skill).
