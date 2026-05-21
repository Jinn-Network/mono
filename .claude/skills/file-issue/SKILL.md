---
name: file-issue
description: Use when a person wants to file a GitHub issue — e.g. "file an issue", "file a bug", "report a bug", "log this as an issue", "I found a problem while testing", "/file-issue". Human-invoked while dogfooding the Jinn operator app.
---

# file-issue

You help a person who is dogfooding the Jinn app turn a fresh observation into a short, scoped, **triage-complete** GitHub issue. You interview them briefly, draft the issue, classify it against the DR-2026-05-20-b taxonomy, show them the result, and — only on their confirmation — file it via `gh`. A triage-complete issue is the entry condition to the autonomous dispatcher queue, so the quality bar is high: scoped, with binary acceptance criteria.

## Step 1 — Read first

Read the issue body the person gave you. Most of the information you need is already there. Start from what they said; ask only for what is missing.

## Step 2 — The interview

The person is mid-dogfooding with fresh context. Do not over-question. You need exactly four things:

| Slot | What you need | Acceptable if missing |
|------|---------------|----------------------|
| **Context** | What they hit or want, concretely — a surface, a behaviour, a gap | No — always needed |
| **Impact** | Why it matters / who it affects (operators, contributors, the loop) | Ask if absent |
| **Acceptance criteria** | What "done" looks like as binary yes/no statements | Ask if absent |
| **Files/components** | Where in the codebase, if they know | Yes — "don't know" is fine |

**Cap the interview at 1–3 questions** beyond their opening description. If you can infer a slot from context, do — do not ask for what you can reasonably fill in.

Ask open questions conversationally. Reserve `AskUserQuestion` for the structured picks (Issue Type confirmation in Step 3, Priority in Step 5).

Acceptance criteria must be **binary** — each criterion is a yes/no, testable question. "The value updates" is binary. "It looks good" is not. Each criterion must also name the starting condition: phrase it as "After X, Y is true" so the test precondition is unambiguous.

## Step 3 — Classify the Issue Type

Pick the most likely Issue Type from the nine below. A wrong type mis-routes the issue in the dispatcher — always confirm it with the person before drafting.

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

**Decision shortcut:** If the person hit a broken thing → `fix` (or `incident` if urgent). If they want something new → `feat`. If it is a question without a clear answer yet → `spike`. If it is wording or documentation → `docs`.

Confirm with the person: "I'd classify this as **`fix`** — does that match what you're experiencing, or is it closer to something else?"

## Step 4 — Draft the issue body

The issue body has four short sections. Keep it tight — scoped issues with binary acceptance criteria and file/component hints raise autonomous-implementation merge rates; long bodies lower them. External web URLs and Slack links go in comments after filing, not in the body; internal repo paths (spec files, source files) belong in `Files/components` and are encouraged.

**Title:** a one-line summary, no shape prefix (the Issue Type field carries the shape).

**Body sections:**

```
**Context.** [What they hit or want, concretely. Two to four sentences max.]

**Impact.** [Who it affects and why it matters. One to two sentences.]

**Acceptance criteria.**
- [ ] [Binary yes/no statement.]
- [ ] [Binary yes/no statement, if there are multiple.]

**Files/components.** [Path(s) and surface name(s), or "Unknown." If a path was inferred by you — not stated by the person — mark it `(estimated)`. If genuinely uncertain, write "Unknown." Internal repo paths (spec files, source files) are welcome here; they help autonomous agents navigate the codebase.]
```

**Worked example — use this as the model:**

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

**Quality bar:** if an acceptance criterion cannot be answered yes or no by running the app or a test, rewrite it until it can.

**`docs` shape note:** for `docs` issues, acceptance criteria should describe what the new or updated content must *contain* (e.g. "The doc explains how to join a SolverNet, including the `joinedSolverNets` config entry"), not what it does not break. "No existing doc is broken" is unbounded and low-value for an autonomous agent — replace it with a specific, verifiable content statement.

## Step 5 — Set the routing fields

Three Project fields route the issue to the right queue. Set all three — an issue missing any field is not triage-complete and will not enter the dispatcher queue.

**Blocked on** — choose one:
- `Nothing` (default — almost all fresh dogfooding issues)
- `Human` — only if a product or design decision is needed before any work can start
- `Another issue` — only if the person names a prerequisite issue (the Project option is named `Another issue`; put the specific issue number in the issue body)

**Effort** — estimate from the drafted scope, then confirm with the person:
- `Low` — a localized change in one or two files
- `Medium` — a few files, or a small feature with tests
- `High` — cross-cutting, or design-heavy before any code

Offer your estimate: "I'd estimate this as **Low** effort — a change to one or two files in the HeroStats component. Does that match your sense of it?"

**Priority** — human judgment only; ask directly. Offer the options:
- `P0` — blocking, must fix now
- `P1` — important, next sprint
- `P2` — good to have, when bandwidth allows
- `P3` — nice to have, no commitment
- `P4` — backlog, someday / maybe

Ask: "What priority would you give this? P0 (blocking), P1 (next sprint), P2 (good to have), P3 (nice to have), or P4 (backlog)?"

## Step 6 — Confirm, then file

Filing a GitHub issue is an outward-facing, published action. Always show the person the complete draft and confirm before filing.

**Show:**
1. The full issue body (title + four sections) formatted for easy reading
2. The four taxonomy values:
   - Issue Type: `fix`
   - Blocked on: `Nothing`
   - Effort: `Low`
   - Priority: `P1`

Invite edits: "Here's the draft. Anything you'd like to change before I file it?"

**On confirmation:** follow `references/gh-taxonomy.md` — create the issue with its Issue Type, add it to the "Jinn engineering" Project (number 1, owner `Jinn-Network`), and set the three fields (`Blocked on`, `Effort`, `Priority`). Output the issue URL and number.

**On decline:** do not file. Leave the draft in the conversation. The person may copy it and file manually.

## Step 7 — Self-check before declaring done

Before you output the draft to the person, verify:

- [ ] Title is a one-line summary with no shape prefix.
- [ ] Issue Type is from the nine in Step 3 and confirmed.
- [ ] All four body sections are present and non-empty (or `Files/components: Unknown`).
- [ ] Every acceptance criterion is binary — answerable yes/no.
- [ ] All three routing fields are set (`Blocked on`, `Effort`, `Priority`).
- [ ] The body is short — no paragraph longer than 4 sentences, no external URLs or Slack links in the body (internal repo paths in `Files/components` are fine and encouraged).

If any check fails, fix before showing the draft.

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Acceptance criterion is not binary ("it should work correctly") | Rewrite as a testable yes/no: "After X, Y is visible without a reload" |
| Over-interviewing — asking for information already in the opening | Re-read the person's message; infer what you can |
| Filing without confirmation | Always show the draft first |
| Leaving a routing field unset | All three fields must be set; an issue without them is not triage-complete |
| Putting external URLs or Slack links in the body | Put web/Slack links in a comment after filing; internal repo paths in `Files/components` are fine |
| Long body with multiple problems bundled | One issue per problem; offer to file separate issues if scope is unclear |
