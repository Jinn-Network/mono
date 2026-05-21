# In-Session Pipeline Skill (`implement-issue`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. The core authoring task (Task 1) additionally uses superpowers:writing-skills. Steps use checkbox (`- [ ]`) syntax.
>
> **Note on task shape:** the deliverable is a *skill* — one coherent markdown playbook — plus behavioural verification. Tasks are larger-grained than a code plan; classic write-test-first TDD does not apply to a markdown playbook, so verification here is *behavioural* (run the skill against fixture issues, observe).

**Goal:** Build the `implement-issue` skill — the in-session pipeline: a coordinating agent that takes one triaged GitHub issue and runs it through the autonomous superpowers chain plus the loop's extra gates, to a reviewed, app-tested draft PR.

**Architecture:** A Claude Code skill at `.claude/skills/implement-issue/SKILL.md`. When invoked on an issue, the invoking agent becomes the *coordinating agent*: it reads the issue, dispatches a fresh subagent per pipeline stage (design → plan → implement → `/simplify` → independent review → `/security-review` → jinn-app test → verify+PR), owns the finding→fix loop and judgment-based escalation, and opens a draft PR. It composes existing skills; for headless runs it relies on the headless-override block from the headless-superpowers-harness plan.

**Tech Stack:** Markdown skill definition; the `gh` CLI; git worktrees; the superpowers chain, `/simplify`, `/security-review`, `testing-jinn-app`.

**Depends on:** `docs/superpowers/plans/2026-05-21-headless-superpowers-harness.md` — specifically `packages/eng-loop/headless-override.md` and the evidence (its `RESULTS.md`) that the chain skills run headless. Phase 1, unit 2 of `docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md`.

**Out of scope:** the dispatcher (`eng-orchestrator`), the `file-issue` skill, the merge skill — each is a separate plan.

---

## File structure

- `.claude/skills/implement-issue/SKILL.md` — the coordinating-agent playbook (the whole deliverable).
- `.claude/skills/implement-issue/fixtures/` — fixture issue bodies used for behavioural verification (markdown, one per shape).
- No code modules — the skill composes existing skills and the `gh` CLI.

---

### Task 1: Draft the `implement-issue` SKILL.md

**Files:**
- Create: `.claude/skills/implement-issue/SKILL.md`

Use `superpowers:writing-skills` for this task. The SKILL.md must contain the following sections, each with the specified content. Match the structure of an existing repo skill (e.g. `.claude/skills/eng-day/SKILL.md`) for frontmatter and tone.

- [ ] **Step 1: Frontmatter + overview**

YAML frontmatter: `name: implement-issue`; a `description` that triggers on "implement issue #N", "run the pipeline on this issue", "take this issue to a PR". Overview paragraph: "You are the coordinating agent for exactly one triaged GitHub issue. Your job is to take it from triaged-issue to a reviewed, app-tested **draft PR** against `next`, by dispatching a fresh subagent per pipeline stage. You own the finding→fix loop and the escalation decision; you do not implement directly."

- [ ] **Step 2: Input + issue-reading section**

The skill takes an issue reference. First actions: `gh issue view <N> --json number,title,body,labels` and read the issue's **Issue Type** and the `Blocked on` / `Effort` / `Priority` Project fields (via `gh project item-list` / `gh issue view`). Hard preconditions, each fails loud: the issue must be triage-complete (Issue Type set); if `Blocked on` is `Human` or `Another issue`, stop — this issue is not for autonomous implementation. Create a git worktree + branch for the issue per workflow rule 1; all subsequent work happens there.

- [ ] **Step 3: The eight-stage sequence**

Document the pipeline stages exactly as spec §3, each as a numbered step the coordinating agent performs by **dispatching a fresh subagent** (never implementing inline):
1. Design — subagent runs `superpowers:brainstorming`; output a short design note.
2. Plan — subagent runs `superpowers:writing-plans`.
3. Implement — subagent runs `superpowers:test-driven-development` + `superpowers:executing-plans`.
4. `/simplify` — subagent runs the `/simplify` skill.
5. Independent review — a subagent that is **not** the implementer, running `superpowers:requesting-code-review` with the code-reviewer template.
6. `/security-review` — subagent runs `/security-review`.
7. jinn-app test — subagent runs `testing-jinn-app` for the specific change, when it touches an operator-visible surface.
8. Verify + open PR — subagent runs `superpowers:verification-before-completion` (typecheck + tests + build green), then `gh pr create --draft` with a shape-prefixed Conventional-Commit title and `Closes #N`.
State the rule: stages scale to Issue Type + `Effort` (a Low-effort `docs` change compresses stages 1–2; a High-effort `feat` runs them fully).

- [ ] **Step 4: Subagent-dispatch discipline**

Document how to dispatch each stage's subagent: a fresh subagent with a curated prompt (the stage's task + only the context it needs — never the coordinator's own history); the implementer subagent and the reviewer subagent must be *different* subagents (independence). After a stage, the coordinator reads the subagent's report and decides the next move. Reference the zero-commit guard: after the implement/PR stages, the coordinator verifies git/PR state with `gh`/`git` — it never trusts a subagent's "done" claim.

- [ ] **Step 5: Finding-handling + escalation**

Document spec §4 verbatim-in-spirit: any gate's findings route back to a fix subagent, the gate re-runs; two finding kinds (fixable → loop; scope/design → immediate escalation); escalation is **judgment-based**, no round-count budget — the coordinator escalates when findings are not converging or it hits a scope/design finding. Escalation carries a structured status (`needs-decision` / `blocked` / `stuck`). In Phase-1 hand-cranked use, "escalate" means: stop, write a one-paragraph "where I am / why I stopped" note, and surface it to the human. (The dispatcher-owned wall-clock breaker and the resumable-session jump-in are the dispatcher's concern — a later plan — not this skill's.)

- [ ] **Step 6: Shape variants**

Document: `spike` / `incident` / `design` issues run only stages 1–2 (the "first push" — a finding, a diagnosis + candidate patch, or a spec/DR draft) then escalate with status `needs-decision` instead of proceeding to PR. All other shapes (`feat` / `fix` / `chore` / `docs` / `test` / `refactor`) run the full pipeline to a draft PR. `refactor` additionally requires design upfront (stage 1 is mandatory, not compressed) per the handbook.

- [ ] **Step 7: Headless-mode note**

A short section: when this skill runs in a headless session, the headless-override block (`packages/eng-loop/headless-override.md`) is injected by the caller and the coordinator + its subagents make approval decisions themselves. When run interactively (hand-cranked Phase 1), the human is present for genuine escalations. The skill's behaviour is identical either way; only who answers an escalation differs.

- [ ] **Step 8: Re-read the draft against spec §3–§4 and commit**

Verify every spec §3 stage and every spec §4 rule is represented. Then:

```bash
git add .claude/skills/implement-issue/SKILL.md
git commit -m "feat(eng-loop): implement-issue in-session pipeline skill"
```

---

### Task 2: Create the pipeline test-fixture issues

**Files:**
- Create: `.claude/skills/implement-issue/fixtures/docs-fixture.md`
- Create: `.claude/skills/implement-issue/fixtures/fix-fixture.md`
- Create: `.claude/skills/implement-issue/fixtures/feat-fixture.md`
- Create: `.claude/skills/implement-issue/fixtures/spike-fixture.md`

Each fixture is a triaged-issue body (context + impact + binary acceptance criteria + file/component hints) plus a header line stating its Issue Type and `Effort`. They are real, small, self-contained tasks against this repo, runnable end to end.

- [ ] **Step 1: `docs-fixture.md`** — Issue Type `docs`, Effort `Low`. A genuine small documentation fix (e.g. a stale path or command in a README or runbook). Lowest-risk fixture; used for the first real run.
- [ ] **Step 2: `fix-fixture.md`** — Issue Type `fix`, Effort `Low`. A genuine small bug with a clear binary acceptance criterion, in a unit-tested area of `client/` so the regression-test-first SOP and the gates are exercised.
- [ ] **Step 3: `feat-fixture.md`** — Issue Type `feat`, Effort `Medium`. A small, well-scoped feature with binary acceptance criteria, touching an operator-visible surface so stage 7 (jinn-app test) runs.
- [ ] **Step 4: `spike-fixture.md`** — Issue Type `spike`, Effort `Medium`. A research question whose output is a finding, used to verify the first-push-then-escalate variant.
- [ ] **Step 5: Commit**

```bash
git add .claude/skills/implement-issue/fixtures
git commit -m "test(eng-loop): implement-issue pipeline fixture issues"
```

---

### Task 3: Behavioural verification — the `docs` fixture

The first real run, on the lowest-risk shape.

- [ ] **Step 1:** File the `docs-fixture.md` body as a real GitHub issue on a scratch/test basis (or run the skill against the fixture file directly if the skill supports a local-fixture mode — decide and document which in Task 1).
- [ ] **Step 2:** Invoke `implement-issue` on it. Observe: does it create a worktree, run stages 1–8 by dispatching subagents, and open a draft PR?
- [ ] **Step 3:** Verify the draft PR exists, its title is shape-prefixed, CI is green, and the change satisfies the fixture's acceptance criteria.
- [ ] **Step 4:** Record observations (what worked, what the skill did awkwardly) in `.claude/skills/implement-issue/fixtures/RESULTS.md`.
- [ ] **Step 5: Commit** the RESULTS.md.

---

### Task 4: Behavioural verification — the `fix` fixture (exercises the gates)

- [ ] **Step 1:** Run `implement-issue` on the `fix` fixture.
- [ ] **Step 2:** Verify the implement stage wrote the regression test first; verify the independent-review and `/security-review` gates ran as separate subagents; verify a draft PR with green CI.
- [ ] **Step 3:** If a gate raised a finding, verify the finding→fix loop behaved per Task 1 Step 5 (routed back, re-ran, converged or escalated on judgment).
- [ ] **Step 4:** Append observations to `RESULTS.md`; commit.

---

### Task 5: Behavioural verification — the `spike` fixture (first-push-then-pause)

- [ ] **Step 1:** Run `implement-issue` on the `spike` fixture.
- [ ] **Step 2:** Verify it runs stages 1–2 only and then escalates with status `needs-decision` — it must NOT open a PR.
- [ ] **Step 3:** Append observations to `RESULTS.md`; commit.

---

### Task 6: Refine the SKILL.md from the verification runs

- [ ] **Step 1:** Review `RESULTS.md` across Tasks 3–5. For each awkwardness or failure, make a minimal, targeted edit to `SKILL.md` — tighten an instruction, fix an ambiguous step, correct a stage that misbehaved.
- [ ] **Step 2:** Re-run whichever fixture exposed a problem; confirm the edit fixed it.
- [ ] **Step 3: Commit**

```bash
git add .claude/skills/implement-issue/SKILL.md .claude/skills/implement-issue/fixtures/RESULTS.md
git commit -m "fix(eng-loop): refine implement-issue skill from verification runs"
```

---

## Self-review

- **Spec coverage.** Task 1 Steps 3–7 implement spec §3 (the eight-stage pipeline, subagent-per-stage, coordinator=Claude) and §4 (finding-handling, judgment-based escalation, structured status, shape variants). Tasks 3–5 verify the `feat`/`fix`/`docs`/`spike` paths behaviourally. The dispatcher-owned concerns (wall-clock breaker, resumable-session jump-in, backpressure) are correctly excluded — Task 1 Step 5 says so explicitly — they belong to the dispatcher plan.
- **Placeholder scan.** Task 1's steps specify *what each SKILL.md section must contain*, drawn from the spec; they are content specifications, not "TODO". The fixtures (Task 2) are specified by shape + constraints rather than pre-written prose, because each must be a genuine current-repo task chosen at implementation time — pre-writing a fake bug now would likely be stale by execution.
- **Dependency.** This plan depends on the headless-superpowers-harness plan's `headless-override.md`; Task 1 Step 7 references it. If that artifact does not yet exist at execution time, Task 1 Step 7 still documents the contract — the path is fixed by the other plan.
- **Scope.** One skill, plus its fixtures and verification. Right-sized for a single plan; larger-grained tasks are appropriate for skill-authoring.
