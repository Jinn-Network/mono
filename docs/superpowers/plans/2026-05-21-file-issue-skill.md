# `file-issue` Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. The core authoring task (Task 1) additionally uses superpowers:writing-skills. Steps use checkbox (`- [ ]`) syntax.
>
> **Note on task shape:** the deliverable is a *skill* — a markdown playbook plus one reference file — and behavioural verification. Tasks are larger-grained than a code plan; classic write-test-first TDD does not apply to a markdown playbook, so verification here is *behavioural* (run the skill against scenarios, observe the issue it drafts).

**Goal:** Build the `file-issue` skill — agent-assisted issue authoring that turns a dogfooder's fresh observation into a short, scoped, **triage-complete** GitHub issue ready for the dispatcher queue.

**Architecture:** A Claude Code skill at `.claude/skills/file-issue/SKILL.md`, with one reference file for the `gh` mechanics. Always human-invoked (while dogfooding). It interviews the person briefly, drafts a scoped issue (context, impact, binary acceptance criteria, file/component hints), classifies the Issue Type, sets the routing fields, shows the human the result, and on confirmation files via `gh` — creating the issue with its Issue Type and adding it to the "Jinn engineering" Project with `Blocked on` / `Effort` / `Priority` set.

**Tech Stack:** Markdown skill definition; the `gh` CLI (issues + Projects v2 + GraphQL); the DR-2026-05-20-b issue taxonomy.

**Depends on:**
- `docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md` §1 — this plan is Phase 1, the issue-intake unit.
- DR-2026-05-20-b (`log/decisions/2026-05-20-issue-taxonomy-redesign.md`) — the nine work-shape Issue Types and the `Blocked on` / `Effort` / `Priority` Project fields. Those must be **provisioned** (org-level Issue Types created; the three fields present on the "Jinn engineering" Project, number 1 on `Jinn-Network`) before Task 4's real end-to-end run — provisioning is tracked separately (#425).

**Out of scope:** the in-session pipeline, the merge skill, the dispatcher — each a separate plan. The **triage-finish backstop pass** (spec §1) is also out of scope: it is a headless dispatcher stage that re-shapes raw issues filed *without* this skill, so it belongs to the dispatcher plan.

---

## File structure

- `.claude/skills/file-issue/SKILL.md` — the interview-and-file playbook (the main deliverable).
- `.claude/skills/file-issue/references/gh-taxonomy.md` — the concrete `gh` recipe: setting the Issue Type, adding the issue to the Project, and setting the `Blocked on` / `Effort` / `Priority` fields, including how to discover the field and option IDs dynamically.
- No code modules — the skill drives the `gh` CLI directly.

---

### Task 1: Draft the `file-issue` SKILL.md

**Files:**
- Create: `.claude/skills/file-issue/SKILL.md`

Use `superpowers:writing-skills` for this task. Match the frontmatter and tone of an existing repo skill (`.claude/skills/eng-day/SKILL.md`, `.claude/skills/testing-jinn-app/SKILL.md`). The SKILL.md must contain the following sections.

- [ ] **Step 1: Frontmatter + overview**

YAML frontmatter: `name: file-issue`; a `description` that triggers when a person wants to file a GitHub issue — e.g. "file an issue", "file a bug", "report a bug", "log this as an issue", "I found a problem while testing", "/file-issue". Overview paragraph: "You help a person who is dogfooding the Jinn app turn a fresh observation into a short, scoped, **triage-complete** GitHub issue. You interview them briefly, draft the issue, classify it against the DR-2026-05-20-b taxonomy, show them the result, and — only on their confirmation — file it via `gh`. A triage-complete issue is the entry condition to the autonomous dispatcher queue, so the quality bar is high: scoped, with binary acceptance criteria."

- [ ] **Step 2: The interview**

Document a *brief* interview — the person is mid-dogfooding, context fresh; do not over-question. Start from whatever they already said; ask only for what is missing. Extract exactly four things:
- **Context** — what they hit or what they want, concretely.
- **Impact** — why it matters / who it affects (operators, contributors, the loop itself).
- **Acceptance criteria** — what "done" looks like, as one or more **binary** (yes/no, testable) statements.
- **File/component hints** — where in the code, if they know (a directory, a file, a surface). "Don't know" is acceptable.

Use `AskUserQuestion` for the structured picks (Step 3's Issue Type confirmation, Step 5's Effort/Priority); use plain conversational questions for the open ones. Cap the interview at ~1–3 questions beyond their opening description.

- [ ] **Step 3: Classify the Issue Type**

Document the nine work-shape Issue Types and the decision logic, then: pick the most likely type and **confirm it with the person** (a wrong shape mis-routes the issue downstream).

| Issue Type | Use when |
|-----------|----------|
| `fix` | existing behaviour is wrong — a bug |
| `incident` | a bug that is urgent / affects production / needs a hotfix now |
| `feat` | a new capability that does not exist yet |
| `refactor` | restructure existing code with no behaviour change |
| `spike` | a research or exploration question; the output is a finding, not shipped code |
| `chore` | dependencies, CI, dev tooling |
| `docs` | documentation only |
| `test` | test-only changes |
| `design` | a spec or decision record (DR) |

- [ ] **Step 4: Draft the issue body**

Document the scoped issue shape and the quality bar. The body has four short sections — **Context**, **Impact**, **Acceptance criteria** (a binary checklist), **Files/components** (hints). State the quality principle from spec §1: scoped issues with binary acceptance criteria and file/component hints raise autonomous-implementation merge rates; long bodies and external-reference-heavy issues lower them — so keep it short and keep external references minimal. The title is a one-line summary, no shape prefix (the Issue Type field carries the shape). Include this worked example verbatim in the SKILL.md as the model:

```markdown
Title: Overview HeroStats shows "0 jinn earned" after a successful claim

**Context.** On the operator dashboard Overview, after the reward-claim loop
completes a claim, the "jinn earned" HeroStat stays at 0 until a full page
reload. The value is correct on reload, so the data is right — the live view
is not re-reading it.

**Impact.** Operators think claims are not working and re-trigger them.

**Acceptance criteria.**
- [ ] After a claim settles, the "jinn earned" HeroStat updates without a reload.
- [ ] The value is still correct after a reload (no regression).

**Files/components.** `client/src/dashboard/spa/` — HeroStats, and the
claim-status query that feeds it.
```

- [ ] **Step 5: Set the routing fields**

Document how the skill chooses the three Project fields:
- **Blocked on** — default `Nothing`. Set `Human` only if the issue needs a product/design decision before any work; set `Another issue #N` if the person names a prerequisite issue. A fresh dogfooding issue is almost always `Nothing`.
- **Effort** — the skill estimates `Low` / `Medium` / `High` from the drafted scope (Low: a localized change in one or two files; Medium: a few files or a small feature; High: cross-cutting or design-heavy) and confirms the estimate with the person.
- **Priority** — a human judgment; ask the person directly, offering the Project's Priority options.

- [ ] **Step 6: Confirm, then file**

Document the confirm-before-file gate (filing a GitHub issue is an outward-facing, published action — always confirm first). Show the person the complete drafted issue (title + body) and all four taxonomy values (Issue Type, Blocked on, Effort, Priority); let them tweak any of it. On their confirmation, file by following `references/gh-taxonomy.md`: create the issue with its Issue Type, add it to the "Jinn engineering" Project, set the three fields. Then output the issue URL and number. If the person declines, do not file — leave the draft in the conversation.

- [ ] **Step 7: Re-read against spec §1 + DR-2026-05-20-b, then commit**

Verify the skill produces an issue that is triage-complete by construction (Issue Type + all three routing fields set) and that the interview stays brief. Then:

```bash
git add .claude/skills/file-issue/SKILL.md
git commit -m "feat(eng-loop): file-issue skill — agent-assisted issue authoring"
```

(End the commit message with a trailing blank line then `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.)

---

### Task 2: Write the `gh` taxonomy reference

**Files:**
- Create: `.claude/skills/file-issue/references/gh-taxonomy.md`

This reference is the concrete, copy-pasteable `gh` recipe the skill's Step 6 follows. It must cover, in order:

- [ ] **Step 1: Repo + Project constants**

State the targets: repo `Jinn-Network/mono`; the "Jinn engineering" Project is number `1`, owner `Jinn-Network`. Note that if `gh project item-list 1 --owner Jinn-Network` errors with "project not found", the number has changed — discover it with `gh project list --owner Jinn-Network --format json`.

- [ ] **Step 2: Create the issue with its Issue Type**

Document `gh issue create --repo Jinn-Network/mono --title "<title>" --body-file <file> --type "<Issue Type>"`. Note the `--type` flag requires a recent `gh` (≥ 2.63); include the GraphQL fallback (`createIssue` mutation referencing the org `issueType` node id) for older `gh`, and how to check the version (`gh --version`). Capture the created issue's URL and number from the command output.

- [ ] **Step 3: Add the issue to the Project**

Document `gh project item-add 1 --owner Jinn-Network --url <issue-url>`, which prints the item id.

- [ ] **Step 4: Discover the field and option IDs**

Document `gh project field-list 1 --owner Jinn-Network --format json` and how to read out, for each of `Blocked on` / `Effort` / `Priority`: the field id, and — since all three are single-select — the option id for each choice. Discover these at run time rather than hardcoding; ids change if a field is recreated.

- [ ] **Step 5: Set each field**

Document `gh project item-edit --id <item-id> --project-id <project-id> --field-id <field-id> --single-select-option-id <option-id>`, one call per field. Show the full three-call sequence with placeholders.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/file-issue/references/gh-taxonomy.md
git commit -m "docs(eng-loop): gh taxonomy reference for the file-issue skill"
```

---

### Task 3: Behavioural verification — draft quality, no filing

Run the skill through the interview-and-draft stages on three scenarios; inspect the draft and the taxonomy choices; **decline the file step** each time so no issues are created.

- [ ] **Step 1:** Invoke `file-issue` for a **bug** scenario — a plausible operator-app paper cut (e.g. a stale value, a layout overflow). Drive the interview, let it draft. Verify: Issue Type `fix`; a Context/Impact/Acceptance/Files body; the acceptance criteria are **binary**; `Effort` and `Blocked on` are sane.
- [ ] **Step 2:** Invoke `file-issue` for a **feature** scenario — a small missing capability. Verify: Issue Type `feat`; binary acceptance criteria; a sane `Effort` estimate.
- [ ] **Step 3:** Invoke `file-issue` for a **docs** scenario — a stale or missing doc. Verify: Issue Type `docs`; `Effort: Low`.
- [ ] **Step 4:** Record observations (what the interview did well, where it over- or under-questioned, any weak acceptance criteria) in `.claude/skills/file-issue/references/RESULTS.md`.
- [ ] **Step 5: Commit** the RESULTS.md.

---

### Task 4: Behavioural verification — one real end-to-end file

One genuine run including the `gh` filing, to prove the taxonomy mechanics in `gh-taxonomy.md` actually work.

- [ ] **Step 1:** Pick a **genuine** small repo improvement worth tracking (a real paper cut or doc gap — not a fake). Run `file-issue` on it fully, including Step 6's confirm-and-file.
- [ ] **Step 2:** Verify on GitHub: the issue exists in `Jinn-Network/mono`; its **Issue Type** is set; it is on the "Jinn engineering" Project with `Blocked on` / `Effort` / `Priority` all populated. Confirm it is triage-complete.
- [ ] **Step 3:** If the issue is genuine, keep it (it is real work); if it was only a mechanics test, close it with a note. Record the outcome and the issue number in `RESULTS.md`.
- [ ] **Step 4: Commit** the RESULTS.md update.

---

### Task 5: Refine the SKILL.md from the verification runs

- [ ] **Step 1:** Review `RESULTS.md` across Tasks 3–4. For each awkwardness or failure — an over-long interview, a non-binary acceptance criterion, a mis-classified Issue Type, a `gh` command that needed adjusting — make a minimal, targeted edit to `SKILL.md` or `gh-taxonomy.md`.
- [ ] **Step 2:** Re-run whichever scenario exposed the problem; confirm the edit fixed it.
- [ ] **Step 3: Commit**

```bash
git add .claude/skills/file-issue
git commit -m "fix(eng-loop): refine file-issue skill from verification runs"
```

---

## Self-review

- **Spec coverage.** Task 1 implements spec §1's `file-issue` skill — the brief interview (Step 2), the scoped-issue shape with binary acceptance criteria and file hints (Step 4), the taxonomy fields (Steps 3, 5), filing via `gh` (Step 6). Task 2 makes the `gh` mechanics concrete. The queue-eligibility gate (§1: "triage-complete = Issue Type + routing fields") is satisfied by construction — Task 1 Step 7 verifies it. The triage-finish backstop (§1) is correctly excluded as a dispatcher stage.
- **Placeholder scan.** Task 1's steps specify *what each SKILL.md section must contain*, drawn from spec §1 and DR-2026-05-20-b; the worked issue example in Step 4 is given verbatim. Task 3's scenarios are specified by shape + constraint rather than pre-written prose, because each interview is conversational input chosen at execution time. These are content specifications, not "TODO".
- **Type consistency.** The four taxonomy fields — Issue Type, `Blocked on`, `Effort`, `Priority` — keep the same names and value vocabularies across Task 1 (Steps 3, 5, 6), Task 2 (Steps 4–5), and Tasks 3–4.
- **Scope.** One skill plus one reference file and its behavioural verification. Right-sized for a single plan; larger-grained tasks are appropriate for skill-authoring.
