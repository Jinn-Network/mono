# `merge-batch` Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. The core authoring task (Task 1) additionally uses superpowers:writing-skills. Steps use checkbox (`- [ ]`) syntax.
>
> **Note on task shape:** the deliverable is a *skill* — a markdown playbook plus one reference file — and behavioural verification. Tasks are larger-grained than a code plan; classic write-test-first TDD does not apply to a markdown playbook, so verification here is *behavioural* (run the skill's reasoning against a scenario, observe).

**Goal:** Build the `merge-batch` skill — agent-driven batch integration: a coordinating-agent session the human invokes to merge the ready pull requests into `next`, one at a time, with conflict-aware ordering, rebase-and-re-gate between each, and clean escalation of genuine semantic conflicts.

**Architecture:** A Claude Code skill at `.claude/skills/merge-batch/SKILL.md`, with one reference file for the git/`gh` mechanics. Always human-invoked (when the human is ready to integrate). The invoking agent becomes the *coordinating agent*: it surveys the open ready PRs, decides a conflict-aware merge order (honouring the three stacking tiers), merges them into `next` one at a time, and after each advance dispatches a rebase subagent to rebase the next PR and re-run its gates. Clean (mechanical) conflicts auto-resolve; a genuine semantic conflict it cannot cleanly resolve routes that PR's issue to `Blocked on: Human` and the batch continues without it.

**Tech Stack:** Markdown skill definition; the `gh` CLI; git (rebase, merge); `gh-stack` for stacking mechanics.

**Depends on:**
- `docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md` §5 (the merge skill), §6 (the human integration cycle), §4 (the escalation mechanism this skill inherits) — this plan is Phase 1, the integration unit.
- DR-2026-05-20-b (`log/decisions/2026-05-20-issue-taxonomy-redesign.md`) — the `Blocked on` Project field, whose `Another issue` value carries known dependency stacks.
- Soft dependency: the `implement-issue` skill (`.claude/skills/implement-issue/`) produces the draft PRs this skill consumes. The skill works on any ready PRs against `next`; it does not require `implement-issue` to exist.

**Out of scope:** the dispatcher (`eng-orchestrator`) — a separate plan. The dispatcher's **backpressure throttle** (which bounds how many ready PRs accumulate) is the dispatcher's concern; this skill integrates whatever ready PRs exist when invoked. The Monday `next` → `main` cut and `promote-main.yml` are reused unchanged — this skill only feeds `next`.

---

## File structure

- `.claude/skills/merge-batch/SKILL.md` — the batch-integration playbook (the main deliverable).
- `.claude/skills/merge-batch/references/merge-mechanics.md` — the concrete git/`gh`/`gh-stack` recipe: detecting ready PRs, merging into `next`, rebasing onto an advanced `next` and re-gating, clean-vs-semantic conflict detection, the `gh-stack` commands.
- No code modules — the skill drives `git` and the `gh` CLI directly.

---

### Task 1: Draft the `merge-batch` SKILL.md

**Files:**
- Create: `.claude/skills/merge-batch/SKILL.md`

Use `superpowers:writing-skills` for this task. Match the frontmatter and tone of an existing repo skill (`.claude/skills/implement-issue/SKILL.md`, `.claude/skills/eng-day/SKILL.md`). The SKILL.md must contain these sections.

- [ ] **Step 1: Frontmatter + overview**

YAML frontmatter: `name: merge-batch`; a `description` that triggers when the human wants to integrate the ready PRs — e.g. "merge the batch", "integrate the ready PRs", "batch-merge into next", "/merge-batch". Overview paragraph: "You are the coordinating agent for one batch integration. The human invokes you when they are ready to integrate the ready pull requests into `next`. You survey the open ready PRs, decide a conflict-aware merge order, merge them one at a time, rebase and re-gate each remaining PR after `next` advances, auto-resolve clean conflicts, and escalate a genuine semantic conflict — routing that one PR's issue to `Blocked on: Human` — without blocking the rest of the batch. You do not touch the Monday `next` → `main` cut; you only feed `next`."

- [ ] **Step 2: Survey the ready PRs**

Document the survey: `gh pr list --repo Jinn-Network/mono --base next --state open --json number,title,headRefName,labels,statusCheckRollup,files` to list candidate PRs. A PR is **ready** when its CI gates are green (the `implement-issue` pipeline only opens a PR when every gate passed, but always re-check `statusCheckRollup` — a PR can have gone stale). For each ready PR, read its linked issue and the issue's `Blocked on` field (`gh issue view`). Drop from the batch any PR whose CI is red or whose issue is `Blocked on: Human`. The result is the candidate set for ordering.

- [ ] **Step 3: Decide the merge order**

Document the ordering decision — it is a reasoning task, not a sort. Three stacking tiers (spec §5):
1. **Known dependency stacks.** A PR whose issue is `Blocked on: Another issue #A` is already branched on A's branch. A must merge before its dependents; order the stack bottom-up.
2. **`refactor` stacks.** A `refactor`'s PRs form a strangler-fig stack (handbook mandate); merge them in stack order.
3. **Reactive overlap.** Detect unforeseen overlap — two PRs whose `files` lists intersect. Order overlapping PRs adjacent and merge the smaller/simpler first so the second rebases onto it; if the overlap is deep, plan to stack the second on the first reactively.
Produce an explicit ordered merge list, each entry annotated with its tier (independent / dependency-stack / refactor-stack / reactive-overlap). Independent PRs with no overlap can be ordered freely (FIFO by PR number is fine).

- [ ] **Step 4: The merge loop**

Document the loop, one PR at a time, following `references/merge-mechanics.md`:
1. Rebase the PR onto the current `next`; confirm its gates are green on the rebased head.
2. Merge it into `next` (rebase-merge, to keep `next` linear).
3. `next` has now advanced. Dispatch a **rebase subagent** for the *next* PR in the order: it rebases that PR's branch onto the new `next` and re-runs the gates / waits for CI. The coordinator never trusts a "rebased fine" claim — it verifies `git` state and the CI rollup itself (the zero-commit-guard discipline, spec Appendix).
4. Repeat until the order is exhausted.

- [ ] **Step 5: Conflict handling + escalation**

Document, inheriting spec §4's one uniform escalation model:
- **Clean conflict** — a mechanical rebase conflict the agent resolves unambiguously (import ordering, adjacent non-overlapping edits). The rebase subagent resolves it in place and continues.
- **Semantic conflict** — two PRs changed the same logic such that a correct resolution requires re-implementing the overlap, or the agent is not confident the resolution is correct. Do **not** guess. Route that one PR's issue to `Blocked on: Human` with a structured status (`needs-decision`), leave a one-paragraph "where I stopped / why" note, skip that PR, and **continue the batch** with the rest. One bad PR never blocks the others.
- The merged-vs-skipped split is the §4 two-queue property: a PR is either integrated into `next` or it is a paused item in the `Blocked on: Human` queue.

- [ ] **Step 6: Wrap-up report**

Document the closing report the coordinator produces: which PRs merged (in order) and the final `next` HEAD; which PRs were skipped and why (each now `Blocked on: Human`); a one-line pointer that the human's next step is to app-test `next` (spec §6). No PR is left in an ambiguous state.

- [ ] **Step 7: Re-read against spec §5 + commit**

Verify every spec §5 element is represented — survey, conflict-aware ordering, the three stacking tiers, the merge loop with rebase-and-re-gate, semantic-conflict escalation that continues the batch. Then:

```bash
git add .claude/skills/merge-batch/SKILL.md
git commit -m "feat(eng-loop): merge-batch skill — agent-driven batch integration"
```

(End the commit message with a trailing blank line then `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.)

---

### Task 2: Write the merge-mechanics reference

**Files:**
- Create: `.claude/skills/merge-batch/references/merge-mechanics.md`

The concrete, copy-pasteable git/`gh` recipe the SKILL.md delegates to. It must cover, in order:

- [ ] **Step 1: Detect the ready PRs**

Document the `gh pr list --repo Jinn-Network/mono --base next --state open --json number,title,headRefName,statusCheckRollup,files` query and how to read `statusCheckRollup` for green/red, and how to fetch each PR's linked issue and `Blocked on` field.

- [ ] **Step 2: Rebase a PR onto `next`**

Document the rebase: fetch, `git rebase origin/next` on the PR branch, how to tell a clean rebase from a conflicted one, and force-pushing the rebased branch (`--force-with-lease`).

- [ ] **Step 3: Merge a PR into `next`**

Document the rebase-merge into `next` (`gh pr merge <N> --rebase` or the equivalent), keeping `next` linear. Note that the push to `next` triggers the existing auto-canary — expected, not a concern.

- [ ] **Step 4: Re-gate after `next` advances**

Document how the rebase subagent re-runs gates on a rebased PR: pushing the rebased branch re-triggers CI; `gh pr checks <N> --watch` waits for the rollup. State the local gate fallback (typecheck + tests + build) when CI is slow.

- [ ] **Step 5: Clean-vs-semantic conflict detection**

Document the test: after a rebase conflict, a **clean** conflict is one whose resolution is mechanically unambiguous and leaves both changes' intent intact; a **semantic** conflict is one where a correct resolution needs judgement about overlapping logic. Give 2–3 concrete examples of each.

- [ ] **Step 6: `gh-stack` for stacked PRs**

Document the `gh-stack` commands for the stacking tiers — verify whether `gh-stack` is installed (`which gh-stack` / handbook reference) and document the actual commands available; if it is not installed, document the plain-git stacked-rebase fallback and flag the absence.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/merge-batch/references/merge-mechanics.md
git commit -m "docs(eng-loop): merge-mechanics reference for the merge-batch skill"
```

---

### Task 3: Behavioural verification — the ordering decision

Verify the skill's *reasoning* (survey → order → stacking → conflict routing) on a synthetic batch — **no real merges, no writes to `next`**.

- [ ] **Step 1:** Construct a synthetic batch of five described PRs and give them to the skill as if `gh pr list` had returned them: PR-1 and PR-2 — independent, no file overlap; PR-3 — its issue is `Blocked on: Another issue #1` (a dependency stack on PR-1); PR-4 and PR-5 — both touch the same file (unforeseen overlap), and PR-5's overlap with PR-4 is a genuine semantic conflict.
- [ ] **Step 2:** Run the skill's Steps 2–3 (survey + decide order) against the synthetic batch and **stop before Step 4** (no merging). Capture the ordered merge list and its tier annotations.
- [ ] **Step 3:** Verify the decision: PR-1 is ordered before PR-3 (dependency stack); PR-4 and PR-5 are adjacent with PR-4 first; PR-5 is flagged for the semantic-conflict path (it will route to `Blocked on: Human` at merge time, not block the batch); independent PRs are present and unblocked.
- [ ] **Step 4:** Record the scenario, the skill's ordering output, and the verdict in `.claude/skills/merge-batch/references/RESULTS.md`.
- [ ] **Step 5: Commit** the RESULTS.md.

---

### Task 4: Behavioural verification — one real batch integration

One genuine run including real merges into `next`, to prove the mechanics. **Consequential — it advances the shared `next` branch — so it is run deliberately, with the human, on a real batch.**

- [ ] **Step 1:** When a real batch of ready PRs against `next` exists (for example, the draft PRs produced by the `implement-issue` skill's verification), invoke `merge-batch` on it, with the human present.
- [ ] **Step 2:** Observe: the survey finds the ready PRs; the order is conflict-aware; each PR rebases, re-gates, and merges; `next` advances cleanly between merges.
- [ ] **Step 3:** Verify the final state: the merged PRs are in `next`; any skipped PR's issue is `Blocked on: Human` with a note; `next`'s canary build is green.
- [ ] **Step 4:** Record the batch, what merged, what was skipped, and the outcome in `RESULTS.md`; commit.

> **Note:** this task depends on a real ready-PR batch existing and on the human being present for a `next`-advancing run. If neither is available at execution time, defer Task 4 — Tasks 1–3 and 5 stand on their own — and run it when a real batch is ready.

---

### Task 5: Refine the SKILL.md from the verification runs

- [ ] **Step 1:** Review `RESULTS.md` across Tasks 3–4. For each awkwardness — a mis-ordered batch, a stacking tier not recognised, a conflict mis-classified, a `gh`/git command that needed adjusting — make a minimal, targeted edit to `SKILL.md` or `merge-mechanics.md`.
- [ ] **Step 2:** Re-run whichever scenario exposed the problem; confirm the edit fixed it.
- [ ] **Step 3: Commit**

```bash
git add .claude/skills/merge-batch
git commit -m "fix(eng-loop): refine merge-batch skill from verification runs"
```

---

## Self-review

- **Spec coverage.** Task 1 implements spec §5 — the survey (Step 2), the conflict-aware ordering with the three stacking tiers (Step 3), the merge loop with rebase-and-re-gate (Step 4), and semantic-conflict escalation that routes one PR to `Blocked on: Human` and continues the batch (Step 5), inheriting §4's one uniform escalation model. The wrap-up (Step 6) hands off to spec §6's app-test-`next` step. Task 2 makes the git/`gh`/`gh-stack` mechanics concrete. The dispatcher's backpressure throttle and the Monday cut are correctly excluded.
- **Placeholder scan.** Task 1's steps specify *what each SKILL.md section must contain*, drawn from spec §5; Task 3's synthetic batch is fully specified (five PRs with named properties). These are content specifications, not "TODO".
- **Type consistency.** The stacking tiers (dependency stack / refactor stack / reactive overlap), the conflict kinds (clean / semantic), and the escalation status (`needs-decision`) keep the same names across Task 1, Task 2, and Task 3.
- **Scope.** One skill plus one reference file and its behavioural verification. Task 4 is correctly marked deferrable — it advances the shared `next` branch and needs a real PR batch. Right-sized for a single plan.
