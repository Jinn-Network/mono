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

Both failures are **stop** — do not proceed past precondition checks.

---

## Step 2 — Create the worktree and branch

Per handbook workflow rule 1, all implementation work happens in a dedicated git worktree.

**When dispatched by the eng-loop dispatcher:** the dispatcher pre-creates the worktree and explicitly states the path and branch in the session prompt (look for the sentence "A git worktree for this issue already exists at `<path>` on branch `<branch>` — use it; do not create a new worktree."). If that sentence is present, skip directly to the "All subagents..." paragraph below — do not run `git worktree add`.

**When invoked by a human (interactive mode):** create the worktree yourself. First check whether one already exists for this issue number — if it does, use it:

```bash
# Check whether a worktree already exists for cargo/.tasks/<issue-number>
git worktree list --porcelain | grep "worktree.*cargo/.tasks/<issue-number>"
```

If the grep finds an entry, use that worktree path and branch (read them from the porcelain output). If not, create it:

```bash
# Derive a branch name from the issue number and title slug
BRANCH="<shape>/<issue-number>-<title-slug>"

# Create the worktree from next (absolute path avoids cwd ambiguity)
REPO_ROOT="$(git rev-parse --show-toplevel)"
git worktree add "${REPO_ROOT}/cargo/.tasks/<issue-number>" -b "$BRANCH" origin/next
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

**Zero-commit guard:** after this stage, verify that commits exist before proceeding:

```bash
git -C "cargo/.tasks/<issue-number>" log origin/next..HEAD --oneline
```

If the log is empty, dispatch a fix subagent before continuing.

---

### Stage 4 — `/simplify`

**Dispatcher:** dispatch a simplify subagent.

**Prompt the subagent to:** run the `/simplify` skill on the diff — tighten it for reuse, clarity, and minimal surface area. If simplifying reveals a structural problem (not just style), the subagent raises it as a finding (routes back through Stage 5 finding handling).

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

**Condition:** run this stage only when the change touches an operator-visible surface (the operator dashboard SPA, the daemon API, bootstrap flows, or any surface in `client/src/dashboard/`).

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

**PR title rule:** shape-prefixed Conventional Commit, e.g. `fix(dashboard): hero stats do not update after claim` or `feat(daemon): add balance topup loop`.

**Zero-commit guard:** after the subagent reports done, verify the PR exists externally before declaring this stage complete:

```bash
gh pr list --head "$BRANCH" --json number,url,isDraft
```

If the PR does not exist, dispatch a fix subagent.

**Move the issue to `In Review`.** Once the draft PR is confirmed, set the issue's Project `Status` to `In Review` — the pipeline's work is done and the issue now awaits the human's batch-merge. This also removes the issue from the dispatcher's in-flight set (`deriveInFlight` keys on `In Progress`), freeing the concurrency slot; without it a completed session lingers as in-flight. `Status` is single-select — discover the `In Review` option id via `gh project field-list` (Step 2), then `gh project item-edit ... --single-select-option-id <in-review-option-id>`.

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

The `/simplify`, review, and security stages need *the change's diff*. Compute it from the merge-base — never from `origin/next..HEAD`:

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
| Subagent reports "done" but zero commits | Dispatch a fix subagent; re-check git log. |
| Stage 5 reviewer is same as Stage 3 implementer | Re-dispatch Stage 5 with a genuinely fresh subagent. |
| PR does not appear after Stage 8 subagent reports success | Dispatch a fix subagent; re-check `gh pr list`. |
| Findings not converging across multiple rounds | Escalate with status `stuck`; stop. |
| Scope/design finding from any gate | Immediate escalation with status `needs-decision`; stop. |
| `spike` / `incident` / `design` shape passes Stage 2 | Stop — these shapes must not proceed to Stage 3. |

---

## Composition

- Composes with: `superpowers:brainstorming`, `superpowers:writing-plans`, `superpowers:test-driven-development`, `superpowers:executing-plans`, `/simplify`, `superpowers:requesting-code-review`, `/security-review`, `testing-jinn-app`, `superpowers:verification-before-completion`.
- Downstream of: `file-issue` (which produces the triaged issue this skill consumes).
- Upstream of: the merge skill (which batch-integrates the draft PRs this skill produces into `next`).
- Dispatcher integration: `eng-orchestrator` invokes this skill per issue; the headless-override block is injected by the dispatcher, not this skill.
