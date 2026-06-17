---
name: implement-issue
description: Use when asked to implement a specific GitHub issue — e.g. "implement issue #N", "run the pipeline on this issue", "take this issue to a PR". Coordinates the full autonomous superpowers pipeline for exactly one triaged issue, dispatching fresh subagents per stage, from worktree setup to a reviewed draft PR against `next`.
---

# implement-issue

You are the coordinating agent for exactly one triaged GitHub issue. Your job is to take it from triaged-issue to a reviewed, app-tested **draft PR** against `next`, by dispatching a fresh subagent per pipeline stage. You own the finding→fix loop and the escalation decision; you do not implement directly.

## Read first

- [`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md) — work shapes, per-shape skill chains, worktree rule, stacked PRs.
- [`CLAUDE.md`](../../../CLAUDE.md) — agent-canonical project guide.
- [`docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md`](../../../docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md) §3–§4 — the design rationale for this pipeline.

---

## Step 1 — Read the issue

**Input:** an issue reference — a number (`#N`) or a GitHub issue URL.

Fetch the issue in full:

```bash
gh issue view <N> --json number,title,body,labels,projectItems
```

Also read the three Project routing fields from the "Jinn engineering" board:

```bash
gh project item-list 1 --owner Jinn-Network --format json \
  | jq '.items[] | select(.content.number == <N>) | {issueType: .fieldValues, blockedOn: .fieldValues, effort: .fieldValues, priority: .fieldValues}'
```

The fields you need:
- **Issue Type** — the shape: `fix` / `feat` / `refactor` / `spike` / `chore` / `docs` / `test` / `design` / `incident`
- **Blocked on** — `Nothing` / `Human` / `Another issue`
- **Effort** — `Low` / `Medium` / `High`
- **Priority** — `P0`–`P4`

### Hard preconditions — fail loud if violated

| Precondition | Fail message |
|---|---|
| Issue Type is set | "Issue #N is not triage-complete (Issue Type missing). Set the Issue Type via the Project board, then re-invoke." |
| `Blocked on` is `Nothing` | "Issue #N is blocked (`Blocked on: <value>`). This issue is not for autonomous implementation. Resolve the block first." |
| Human-surface fields present (when the issue is a human-surface change) | "Issue #N is a human-surface change but is missing required fields: <list>. It must carry a domain-model delta, a design artifact, and an existing-user impact + comms plan. Add them via `file-issue` and re-invoke." |

All three failures are **stop** — do not proceed past precondition checks.

### Human-surface gate

A change that alters the **domain model or action surface of a load-bearing human surface** (one currently visible to users or canon other work derives from — DR-2026-06-03) carries extra preconditions. Treat the issue as human-surface when it is labeled `human-surface` **or** its `Files/components` / scope alters a render surface of the operator dashboard SPA (`client/src/dashboard/`) or an `*-APP-SPEC.md` model. A pure copy or value tweak is **not** in scope here — it stays agent-reviewable at intake and is caught at merge by the CODEOWNERS human-review gate (DR-2026-06-03). This is the merge-time gate's intake-side counterpart, not a duplicate of it.

For a human-surface change the issue body must already contain three **input** fields (the `file-issue` skill collects them):

1. **Domain-model delta** — the change as edits to the relevant `*-APP-SPEC.md` component(s) across the four axes (Static / Streams / Actions / State messages), the resulting model complete (no silent axis; empty/loading/error covered), and any banner/notification change reflected in the §2.10 taxonomy.
2. **Design artifact** — a link/path to the exported design + instructions (Claude Design / Figma).
3. **Existing-user impact + comms plan** — the predicted effect on current users and whether/how it is communicated.

If any is missing, **fail loud with the table message and stop** — do not start the pipeline. Check only that the fields are *present*; do not judge their quality (that is the Stage 5 reviewer's job and the spec's CODEOWNERS gate at PR time).

Two further requirements are **outputs** this pipeline produces, not preconditions:
- **Frontend/UX compliance** — the implementation is validated against the Frontend + Design-System rules in `CLAUDE.md` (shadcn-first/snowflake, tokens, radii, no-emoji, voice); attested in the Stage 8 PR body.
- **Verify artifact** — Stage 7 (`testing-jinn-app`) is mandatory for a human-surface change; its UI walk / screenshot is linked in the PR body.

---

## Step 1.5 — Reality check (gate Step 2)

Before any worktree is created and before `Status` is flipped to `In Progress`, triage validates that the issue still describes an unfixed problem. The dispatcher's pre-flight checks the Project board fields; this gate checks whether someone has already shipped a fix while the issue sat in the queue. It runs **even when the dispatcher's pre-flight has already passed** and **even when the skill is hand-invoked**.

### Invoke the CLI

Run the reality-check from the primary checkout (not the worktree — the worktree doesn't exist yet):

```bash
cd <repo-root>
yarn workspace @jinn-network/eng-loop triage:check <N>
# Emits one line of JSON to stdout; non-zero exit on failure.
```

Parse the JSON verdict:

```bash
VERDICT_JSON=$(yarn workspace @jinn-network/eng-loop triage:check <N>)
CLASSIFICATION=$(echo "$VERDICT_JSON" | jq -r '.classification')
SUGGESTED_COMMENT=$(echo "$VERDICT_JSON" | jq -r '.suggestedComment')
SUGGESTED_BLOCKED_ON=$(echo "$VERDICT_JSON" | jq -r '.suggestedBlockedOn')
```

### What the CLI does under the hood

For an issue numbered `<N>`, it sequences four shell commands (then `git branch -a --contains <sha>` per matching commit):

1. `git fetch --all --quiet`
2. `gh search prs "#<N> in:body" --repo Jinn-Network/mono --state all --json number,state,title,headRefName,mergedAt,closedAt,body,mergeCommit`
3. `gh issue view <N> --repo Jinn-Network/mono --json closedByPullRequestsReferences`
4. `git log --all --grep="#<N>" --format="%H%x09%D%x09%s"`
5. For each commit SHA: `git branch -a --contains <sha>` — buckets reachable refs into `{ origin/next, origin/main, origin/release/*, origin/hotfix/* }`.

### Classification table

| Classification | Trigger | Action |
|---|---|---|
| `pr-open` | An OPEN PR has `Closes/Fixes/Resolves #<N>` in its body (or is in the issue's `closedByPullRequestsReferences`) | Comment + `Blocked on: Another issue`, do NOT flip Status |
| `fixed-on-trunk` | A commit referencing `#<N>` is reachable from `origin/next` or `origin/main` and is associated with a merged PR | Comment + `Blocked on: Human`, do NOT flip Status |
| `fixed-pending-backmerge` | A commit referencing `#<N>` is reachable from `origin/release/*` or `origin/hotfix/*` but NOT from trunk | Comment + `Blocked on: Human`, do NOT flip Status |
| `fixed-direct-commit` | A commit referencing `#<N>` is reachable from `origin/next` but no PR is associated | Comment + `Blocked on: Human`, do NOT flip Status |
| `clear` | None of the above | Proceed to Step 2 |

### Edge cases the classifier handles

- **Revert downgrade.** If the most-recent reachable commit referencing `#<N>` on the dominant bucket has subject `^Revert "` or `^revert(`, the verdict is downgraded by one tier (so e.g. `fixed-on-trunk` collapses to `clear` when the revert wins). `evidence.revertedShas` lists the revert SHAs so a human can audit.
- **Body-grep false-positive filter.** A PR whose body merely mentions `#<N>` (without `Closes`/`Fixes`/`Resolves`) is ignored UNLESS the PR is in the issue's `closedByPullRequestsReferences`.
- **Squash-merge SHA.** The classifier matches a merged PR to its commit via `mergeCommit.oid`; if it isn't present, the grep-derived SHA still applies and the verdict falls through to `fixed-direct-commit`.
- **Digit boundary.** `#5721` does not match `#572` — the gatherer re-filters parsed commit subjects with a word-boundary regex.
- **`git fetch --all --quiet` runs once** at the top of the gather sequence so local ref state is current.

### Acting on a non-clear verdict

If `CLASSIFICATION != "clear"`:

1. Comment on the issue with the suggested text:
   ```bash
   gh issue comment <N> --repo Jinn-Network/mono --body "$SUGGESTED_COMMENT"
   ```
2. Set the Project `Blocked on` field to the suggested value. Discover the field id and option ids via `gh project field-list 1 --owner Jinn-Network --format json` (the `file-issue` skill's `references/gh-taxonomy.md` documents the discovery pattern), then:
   ```bash
   gh project item-edit --id <item-id> --project-id <project-id> \
     --field-id <blocked-on-field-id> \
     --single-select-option-id <human-or-another-issue-option-id>
   ```
3. **Do not flip `Status` to `In Progress`** — the issue stays in `Todo`. A human reviews the `Blocked on: Human` (or `Blocked on: Another issue`) signal and decides whether to close the issue or reopen the work.
4. **Exit the skill.** Step 2 onward is skipped entirely.

### Fail-loud posture

If the CLI exits non-zero (gh/git unavailable, network failure, JSON parse error), **abort triage entirely**. Do not fall back to "assume clear" — a swallowed failure here is exactly the bug Step 1.5 exists to prevent.

---

## Step 2 — Create the worktree and branch

If Step 1.5 returned `clear`, proceed. Per handbook workflow rule 1, all implementation work happens in a dedicated git worktree.

**When dispatched by the eng-loop dispatcher:** the dispatcher pre-creates the worktree and explicitly states the path and branch in the session prompt (look for the sentence "A git worktree for this issue already exists at `<path>` on branch `<branch>` — use it; do not create a new worktree."). If that sentence is present, skip directly to the "All subagents..." paragraph below — do not run `git worktree add`.

**When invoked by a human (interactive mode):** create the worktree yourself. First check whether one already exists for this issue number — if it does, use it:

```bash
# Canonical worktree base (matches packages/eng-loop dispatcher + CLAUDE.md rule #1)
REPO_ROOT="$(git rev-parse --show-toplevel)"
PARENT="$(dirname "$REPO_ROOT")"
if [[ "$(basename "$PARENT")" == "jinn-mono_worktrees" ]]; then
  WORKTREES_BASE="$PARENT"
else
  WORKTREES_BASE="${PARENT}/jinn-mono_worktrees"
fi
WORKTREE_PATH="${WORKTREES_BASE}/<issue-number>"

# Check whether a worktree already exists for this issue
git worktree list --porcelain | grep -F "worktree ${WORKTREE_PATH}"
```

If the grep finds an entry, use that worktree path and branch (read them from the porcelain output). If not, create it:

```bash
# Derive a branch name from the issue number and title slug
BRANCH="<shape>/<issue-number>-<title-slug>"

git worktree add "$WORKTREE_PATH" -b "$BRANCH" origin/next
```

All subagents dispatched in subsequent stages work in this worktree. Pass the worktree path and branch name in each subagent prompt.

Set the issue `Status` to `In Progress` on the Project board (skip if the dispatcher has already done this — the issue will already be `In Progress` in that case). `Status` is a single-select field — discover the Status field id and the `In Progress` option id with `gh project field-list 1 --owner Jinn-Network --format json` (the `file-issue` skill's `references/gh-taxonomy.md` documents this discovery), then:

```bash
gh project item-edit --id <item-id> --project-id <project-id> \
  --field-id <status-field-id> --single-select-option-id <in-progress-option-id>
```

---

## Step 3 — The eight-stage pipeline

Stages scale to **Issue Type + Effort**:

| Effort | Compression |
|---|---|
| `Low` `docs` / `chore` | Stages 1–2 compress to almost nothing: design note = one paragraph; plan = a bullet list. Continue through all stages. |
| `Medium` any shape | Run all stages at moderate depth. |
| `High` any shape | Run all stages fully. |
| `refactor` (any Effort) | Stage 1 is mandatory and must not be compressed — design upfront is a handbook requirement for this shape. |

**Rule:** Each stage is performed by dispatching a **fresh subagent** — the coordinating agent never implements inline. See Step 4 for dispatch discipline.

---

### Stage 1 — Design

**Dispatcher:** dispatch a design subagent.

**Prompt the subagent to:** run `superpowers:brainstorming` headlessly — explore the codebase for relevant code, constraints, and existing patterns; then write a short design note (target: 1–3 paragraphs) that names the chosen approach and the key trade-offs considered.

**Output the coordinator reads:** the design note. Confirm it is coherent and covers the issue's acceptance criteria before proceeding to Stage 2.

---

### Stage 2 — Plan

**Dispatcher:** dispatch a planning subagent, giving it the design note from Stage 1.

**Prompt the subagent to:** run `superpowers:writing-plans` — produce a step-by-step implementation plan with acceptance criteria mapped to specific tasks.

**Output the coordinator reads:** the plan. Confirm it is actionable before proceeding to Stage 3.

---

### Stage 3 — Implement

**Dispatcher:** dispatch an implement subagent, giving it the design note and the plan. Remember the identity of this subagent — the reviewer (Stage 5) must be a **different** subagent.

**Prompt the subagent to:** run `superpowers:test-driven-development` then `superpowers:executing-plans`. For a `fix` shape: write the regression test first, watch it fail, then implement the fix. For all shapes: tests must be written before or alongside implementation.

**Zero-commit guard:** after this stage, verify that commits exist before proceeding (use `WORKTREE_PATH` from Step 2, or the absolute path from the dispatcher prompt if the worktree was pre-created):

```bash
git -C "${WORKTREE_PATH}" log origin/next..HEAD --oneline
```

If the log is empty, dispatch a fix subagent before continuing.

---

### Stage 4 — `/code-review`

**Dispatcher:** dispatch a code-review subagent.

**Prompt the subagent to:** run the `/code-review` skill on the diff — tighten it for reuse, clarity, and minimal surface area, and self-review the change. If the pass reveals a structural problem (not just style), the subagent raises it as a finding (routes back through Stage 5 finding handling).

---

### Stage 5 — Independent review

**Dispatcher:** dispatch a **fresh** subagent that has not seen the Stage 3 implementer's work — independence is free when context is clean. This subagent must be different from the Stage 3 implementer.

**Prompt the subagent to:** run `superpowers:requesting-code-review` using the code-reviewer template. The reviewer has **send-back authority** — it may reject changes and enumerate findings. Give it: the diff, the issue body, the acceptance criteria.

**If findings:** route to finding handling (Step 5 below) before proceeding to Stage 6.

---

### Stage 6 — Security review

**Dispatcher:** dispatch a security review subagent. Runs on every session, no exceptions.

**Prompt the subagent to:** run `/security-review` on the diff. Same finding handling as Stage 5.

---

### Stage 7 — Jinn-app test

**Condition:** run this stage only when the change touches an operator-visible surface (the operator dashboard SPA, the daemon API, bootstrap flows, or any surface in `client/src/dashboard/`). For an issue under the **Human-surface gate** (Step 1) this stage is **mandatory** and must not be skipped — its UI walk / screenshot is the **verify artifact** that gate requires, and it is linked in the Stage 8 PR body.

**Dispatcher:** dispatch a test subagent.

**Prompt the subagent to:** run `testing-jinn-app` for the specific change — walk the affected UI surface and verify the acceptance criteria are met in the running app.

**If the change does not touch an operator-visible surface:** skip this stage and note the skip reason in the coordinator's running log.

---

### Stage 8 — Verify + open PR

**Dispatcher:** dispatch a verification subagent.

**Prompt the subagent to:** run `superpowers:verification-before-completion` — typecheck, tests, and build must all be green locally in the worktree. Then open the draft PR:

```bash
gh pr create \
  --draft \
  --base next \
  --label engine:review \
  --title "<shape>(scope): <title>" \
  --body "$(cat <<'EOF'
## Summary
<generated from design note>

## Test plan
<generated from plan + TDD steps>

Closes #<N>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

The `--label engine:review` opt-in flag enrols this PR in the independent `review-pr` loop (Autopilot's PR-triggered review). See `docs/superpowers/specs/2026-05-29-pr-review-loop-design.md`.

**PR title rule:** shape-prefixed Conventional Commit, e.g. `fix(dashboard): hero stats do not update after claim` or `feat(daemon): add balance topup loop`.

**Human-surface PR body:** for an issue under the Human-surface gate, the PR body must also include a `## Human-surface` section with (a) the **frontend/UX compliance** attestation (validated against the Frontend + Design-System rules in `CLAUDE.md`) and (b) a link to the **Stage 7 verify artifact** (the `testing-jinn-app` walk / screenshot).

**Zero-commit guard:** after the subagent reports done, verify the PR exists externally before declaring this stage complete:

```bash
gh pr list --head "$BRANCH" --json number,url,isDraft
```

If the PR does not exist, dispatch a fix subagent.

**Move the issue to `In Review`.** Once the draft PR is confirmed, set the issue's Project `Status` to `In Review` — the pipeline's work is done and the issue now awaits the human's batch-merge. This also removes the issue from the dispatcher's in-flight set (`deriveInFlight` keys on `In Progress`), freeing the concurrency slot; without it a completed session lingers as in-flight. `Status` is single-select — discover the `In Review` option id via `gh project field-list` (Step 2), then `gh project item-edit ... --single-select-option-id <in-review-option-id>`.

**Remove the worktree (final step).** The per-issue worktree is ephemeral scratch — the branch on `origin` is the durable artifact, so once the PR is open the worktree buys nothing and only produces dispatcher drift noise (`packages/eng-loop/src/dispatcher/state.ts` flags every "worktree exists but issue not In Progress" pair as drift, which would otherwise fire on this entirely-legitimate post-PR-open state). Remove it as the **last action of the run**.

`git worktree remove` refuses to remove the worktree you are standing in, and pulling the CWD out from under the shell breaks every subsequent command. `git -C "$PRIMARY"` does not move the coordinator shell/session out of `"$WORKTREE_PATH"`; the removal must run with the tool/session `workdir` set to the primary checkout, or the shell must actually `cd "$PRIMARY"` before removing. `WORKTREE_PATH` is the value from Step 2, or the absolute worktree path from the dispatcher prompt if the worktree was pre-created. Use `--force` only after the guards below pass; it is for ignored build output that can remain after a clean status, not for preserving uncommitted work:

```bash
set -euo pipefail

BRANCH="$(git -C "$WORKTREE_PATH" branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "Refusing to remove detached worktree: $WORKTREE_PATH" >&2
  exit 1
fi

git -C "$WORKTREE_PATH" fetch origin "refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
LOCAL_HEAD="$(git -C "$WORKTREE_PATH" rev-parse HEAD)"
REMOTE_HEAD="$(git -C "$WORKTREE_PATH" rev-parse "refs/remotes/origin/${BRANCH}")"
if [[ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
  echo "Refusing to remove worktree: local HEAD does not match origin/${BRANCH}" >&2
  echo "local:  $LOCAL_HEAD" >&2
  echo "remote: $REMOTE_HEAD" >&2
  exit 1
fi

STATUS="$(git -C "$WORKTREE_PATH" status --porcelain=v1 --untracked-files=all)"
if [[ -n "$STATUS" ]]; then
  echo "Refusing to remove worktree with uncommitted tracked changes or untracked files:" >&2
  printf '%s\n' "$STATUS" >&2
  exit 1
fi

# PRIMARY = path on the first `worktree ` line of `git worktree list --porcelain`
# (git always lists the main working tree first).
PRIMARY="$(git -C "$WORKTREE_PATH" worktree list --porcelain | sed -n 's/^worktree //p' | head -n1)"
cd "$PRIMARY" || exit 1
git worktree remove --force "$WORKTREE_PATH"
```

This is the **final action** of the run — do not read, write, or `cd` into the worktree afterward; it no longer exists. If a later review cycle requests changes, recreate it from `origin/<branch>` using the same canonical sibling path logic from Step 2 (the branch persists on `origin`):

```bash
# Recreate the canonical sibling worktree path from Step 2.
REPO_ROOT="$(git rev-parse --show-toplevel)"
PARENT="$(dirname "$REPO_ROOT")"
if [[ "$(basename "$PARENT")" == "jinn-mono_worktrees" ]]; then
  WORKTREES_BASE="$PARENT"
else
  WORKTREES_BASE="${PARENT}/jinn-mono_worktrees"
fi
WORKTREE_PATH="${WORKTREES_BASE}/<issue-number>"
BRANCH="<branch>"

git fetch origin "refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
git worktree add -B "$BRANCH" "$WORKTREE_PATH" "origin/${BRANCH}"
```

---

## Step 4 — Subagent-dispatch discipline

### Curated prompt, not forwarded history

Each subagent receives a **curated prompt** containing:
- The stage's task, verbatim from the relevant step above
- The issue body (context, impact, acceptance criteria, file hints)
- The worktree path and branch name
- Relevant prior-stage outputs (design note for Stage 2; design note + plan for Stage 3; etc.)

Never forward the coordinator's own conversation history to a subagent. Keep each subagent's context minimal and task-specific. Bloated context degrades output quality and wastes budget.

### Computing the change's diff

The `/code-review`, review, and security stages need *the change's diff*. Compute it from the merge-base — never from `origin/next..HEAD`:

```bash
git diff $(git merge-base origin/next HEAD)..HEAD
```

`origin/next` can advance while the pipeline runs (another PR merges); `origin/next..HEAD` would then show unrelated files and mislead a reviewer. The merge-base pins the diff to exactly this branch's change. The Stage 3 / Stage 8 zero-commit guard's `git log origin/next..HEAD` is a *commit-count* check and is unaffected — leave it as-is.

### Independence invariant

**The Stage 3 implementer and the Stage 5 reviewer must be different subagents.** The coordinator enforces this — they are never the same dispatch. Re-review after a fix stays with the independent reviewer.

### After each stage

The coordinator reads the subagent's report and decides: proceed to the next stage, or route to finding handling. The coordinator does not forward-continue until it is satisfied the stage is complete and sound.

### Zero-commit guard (repeated rule)

After Stages 3 and 8, the coordinator verifies git/PR state with `git log` and `gh pr list` respectively. **It never trusts a subagent's "done" claim.** Agents sometimes report success without committing. The external check is mandatory.

---

## Step 5 — Finding handling and escalation

### Two finding kinds

| Finding kind | Coordinator action |
|---|---|
| **Fixable** — wrong logic, missing test, failing CI, failing app-test, review comment about implementation | Dispatch a fix subagent with the findings; the gate re-runs after the fix. |
| **Scope / design** — the issue is mis-scoped, the approach is fundamentally wrong, a product decision is needed | Immediate escalation — do not loop. |

### Escalation is judgment-based — no round count

There is no round-count budget. The coordinator escalates **when it judges** that:
- Findings are not converging across retry loops, OR
- A scope/design finding is present

An arbitrary cap would escalate legitimate multi-round fixes prematurely. Use judgment.

### Escalation — what to do

Stop the pipeline. Write a one-paragraph note:

> **Where I am:** [last stage completed; what the subagent last produced]
> **Why I stopped:** [the finding, verbatim; or "findings not converging after N rounds"]
> **Status:** `needs-decision` | `blocked` | `stuck`

| Status | Meaning |
|---|---|
| `needs-decision` | A product or design decision is required to proceed |
| `blocked` | A prerequisite (another issue, external dependency) must be resolved first |
| `stuck` | Findings are not converging; coordinator cannot self-resolve |

Surface the note to the human (interactive mode) or leave it in the session transcript and set the issue `Blocked on: Human` (headless mode).

Do not open a PR from a failed or escalated pipeline.

---

## Step 6 — Shape variants

### Full pipeline shapes

`feat` / `fix` / `chore` / `docs` / `test` / `refactor` → run all 8 stages, to a draft PR.

- `refactor`: Stage 1 (design) is **mandatory and uncompressed**, per handbook. Do not skip or compress design for a refactor regardless of Effort.
- `docs` / `chore` at `Low` Effort: compress Stages 1–2 (a short design note and a bullet list plan are sufficient), but still run all remaining stages.

### First-push shapes

`spike` / `incident` / `design` → run **Stages 1–2 only**, then escalate with status `needs-decision`.

| Shape | First-push output |
|---|---|
| `spike` | A finding — what was learned, what options were surfaced |
| `incident` | A diagnosis + candidate patch (not a full implementation) |
| `design` | A spec or DR draft |

After the first push, **stop** — do not proceed to Stage 3 or open a PR. Write the escalation note with `status: needs-decision` and surface it to the human for steering.

---

## Step 7 — Headless-mode note

When this skill runs in a headless session (dispatched by `eng-orchestrator` with `-p` / `--print`), the caller injects the headless-override block from `packages/eng-loop/headless-override.md` at the top of the coordinating agent's prompt. The coordinator and all subagents then make approval decisions themselves — they do not wait for user input.

When run interactively (Phase 1, hand-cranked), the human is present for genuine escalations.

**The skill's behaviour is identical either way.** Only who answers an escalation differs: in headless mode, the coordinator self-judges and pauses; in interactive mode, the human reads the escalation note and steers.

The headless-override block also reminds subagents not to use `--mode plan` / `--permission-mode plan` — leaked plan-posture flags make agents narrate instead of execute.

---

## Failure modes

| Failure | Action |
|---|---|
| Issue Type not set | Fail loud; stop. Do not proceed. |
| `Blocked on` is `Human` or `Another issue` | Fail loud; stop. Do not proceed. |
| Reality-check CLI fails / `gh` or `git` unavailable | Fail loud; stop. Do not proceed past Step 1.5. |
| Step 1.5 returns `pr-open` / `fixed-on-trunk` / `fixed-pending-backmerge` / `fixed-direct-commit` | Comment on the issue, set `Blocked on` to the suggested value, do NOT flip `Status`, exit the skill. |
| Subagent reports "done" but zero commits | Dispatch a fix subagent; re-check git log. |
| Stage 5 reviewer is same as Stage 3 implementer | Re-dispatch Stage 5 with a genuinely fresh subagent. |
| PR does not appear after Stage 8 subagent reports success | Dispatch a fix subagent; re-check `gh pr list`. |
| Findings not converging across multiple rounds | Escalate with status `stuck`; stop. |
| Scope/design finding from any gate | Immediate escalation with status `needs-decision`; stop. |
| `spike` / `incident` / `design` shape passes Stage 2 | Stop — these shapes must not proceed to Stage 3. |

---

## Composition

- Composes with: `superpowers:brainstorming`, `superpowers:writing-plans`, `superpowers:test-driven-development`, `superpowers:executing-plans`, `/code-review`, `superpowers:requesting-code-review`, `/security-review`, `testing-jinn-app`, `superpowers:verification-before-completion`.
- Downstream of: `file-issue` (which produces the triaged issue this skill consumes).
- Upstream of: the merge skill (which batch-integrates the draft PRs this skill produces into `next`).
- Dispatcher integration: `eng-orchestrator` invokes this skill per issue; the headless-override block is injected by the dispatcher, not this skill.
