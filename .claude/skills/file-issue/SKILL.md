---
name: file-issue
description: Use when a person wants to file a GitHub issue — e.g. "file an issue", "file a bug", "report a bug", "log this as an issue", "I found a problem while testing", "/file-issue". Human-invoked while dogfooding the Jinn operator app.
---

# file-issue

You help a person who is dogfooding the Jinn app turn a fresh observation into a short, scoped, **triage-complete** GitHub issue. You interview them briefly, draft the issue, classify it against the DR-2026-05-20-b taxonomy, show them the result, and — only on their confirmation — file it via `gh`. A triage-complete issue is the entry condition to the autonomous dispatcher queue, so the quality bar is high: scoped, with binary acceptance criteria.

## Step 1 — Read first

Read the issue body the person gave you. Most of the information you need is already there. Start from what they said; ask only for what is missing.

## Step 2 — The interview

The person is mid-dogfooding with fresh context. Do not over-question. You need exactly five things:

| Slot | What you need | Acceptable if missing |
|------|---------------|----------------------|
| **Context** | What they hit or want, concretely — a surface, a behaviour, a gap | No — always needed |
| **Impact** | Why it matters / who it affects (operators, contributors, the loop) | Ask if absent |
| **Acceptance criteria** | What "done" looks like as binary yes/no statements | Ask if absent |
| **Files/components** | Where in the codebase, if they know | Yes — "don't know" is fine |
| **Dependencies / base** | What in-flight work this builds on (a stacked PR, unmerged branch, shared file), and which branch/PR it must stack on or wait for | Yes — infer "none / independent" if not mentioned |

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

## Step 3.5 — Human-surface check

Ask: **does this change alter the domain model or action surface of a load-bearing human surface?** A surface is *load-bearing* when it is currently visible to users or is canon other work derives from (DR-2026-06-03). The trigger is **not** "anything an operator sees" — a pure copy or value tweak is agent-reviewable at intake and is caught at merge by the CODEOWNERS human-review gate (DR-2026-06-03). What earns the intake fields is a change that alters the **model or action surface** of such a surface — a new or changed component, state, stream, action, or state-message — which is exactly the change CLAUDE.md §Frontends already says must land *with* a spec update.

If it does **not** alter the model / action surface of a load-bearing surface, skip to Step 4.

If it **does**, do two things:

1. **Mark it.** Apply the `human-surface` label when you file (Step 6).
2. **Collect three extra input fields** into the body. These are the preconditions the `implement-issue` gate enforces — an autonomous run is refused without them. Interview only for what is missing, under the same 1–3 question cap:

   - **Domain-model delta** — the change expressed as edits to the relevant `*-APP-SPEC.md` component(s) along the four axes (Static / Streams / Actions / State messages). The resulting model must be complete — no silent axis, empty/loading/error covered — and any banner/notification change reflected in the §2.10 notification taxonomy. Name the spec file and the component(s) touched. This *is* the operator-visible delta, expressed in the canonical model rather than as free text.
   - **Design artifact** — a link or path to the exported design + instructions (Claude Design / Figma / equivalent). A human-surface change without a design artifact is not ready to implement: set `Blocked on: Human` (a design pass is needed first) rather than filing it as ready.
   - **Existing-user impact + comms plan** — the predicted effect on current users, whether the change needs communicating, and the plan if so.

Do **not** route the person to a separate design skill — the required fields above force the design work on their own. Two further requirements (frontend/UX-rule compliance and a verify artifact) are *outputs* the `implement-issue` pipeline produces, not fields you collect here.

## Step 4 — Draft the issue body

The issue body has five short sections. Keep it tight — scoped issues with binary acceptance criteria and file/component hints raise autonomous-implementation merge rates; long bodies lower them. External web URLs and Slack links go in comments after filing, not in the body; internal repo paths (spec files, source files) belong in `Files/components` and are encouraged.

**Title:** a one-line summary, no shape prefix (the Issue Type field carries the shape).

**Body sections:**

```
**Context.** [What they hit or want, concretely. Two to four sentences max.]

**Impact.** [Who it affects and why it matters. One to two sentences.]

**Acceptance criteria.**
- [ ] [Binary yes/no statement.]
- [ ] [Binary yes/no statement, if there are multiple.]

**Files/components.** [Path(s) and surface name(s), or "Unknown." If a path was inferred by you — not stated by the person — mark it `(estimated)`. If genuinely uncertain, write "Unknown." Internal repo paths (spec files, source files) are welcome here; they help autonomous agents navigate the codebase.]

**Base / stacking.** [The branch/PR this stacks on or must wait for, or "None — independent of all in-flight work." When the base is an unmerged PR/branch, name it here **and** set `Blocked on: Another issue` referencing that PR — not `Nothing`.]
```

**Human-surface section (only when the `human-surface` label applies).** After the five sections above, append a `## Human-surface change` block carrying the three fields from Step 3.5 — Domain-model delta, Design artifact, and Existing-user impact + comms plan.

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

**Files/components.** `operator/src/dashboard/spa/` — HeroStats, and the
claim-status query that feeds it.

**Base / stacking.** None — independent of all in-flight work.
```

If instead the issue built on unmerged code, that line would name the base and the `Blocked on` field would follow it:

```markdown
**Base / stacking.** Stacks on #1461 (branch `feat/1461-hero-schema`) — the
shared claim-status schema change lands there first. `Blocked on: Another
issue` (#1461).
```

**Quality bar:** if an acceptance criterion cannot be answered yes or no by running the app or a test, rewrite it until it can.

**`docs` shape note:** for `docs` issues, acceptance criteria should describe what the new or updated content must *contain* (e.g. "The doc explains how to join a SolverNet, including the `joinedSolverNets` config entry"), not what it does not break. "No existing doc is broken" is unbounded and low-value for an autonomous agent — replace it with a specific, verifiable content statement.

## Step 5 — Set the routing fields

Three Project fields route the issue to the right queue. Set all three — an issue missing any field is not triage-complete and will not enter the dispatcher queue.

**Blocked on** — choose one:
- `Nothing` (default — almost all fresh dogfooding issues)
- `Human` — only if a product or design decision is needed before any work can start
- `Another issue` — the person names a prerequisite. Two kinds both map here (the Project option is named `Another issue`; put the specific issue/PR number in the issue body):
  - **Branch/base dependency** — the work builds on unmerged code (a stacked PR / unmerged schema change / a shared file an open PR also edits), so it must start from that base, not `next`. Example: "builds on the JinnRouterV3 ABI change in unmerged PR #1461." This is the case the `Base / stacking` body line names.
  - **Resource / logical blocker** — a pure prerequisite that is not a code-base dependency (a decision, an external dependency, an ordering constraint). Example: "can't start until the testnet-gate secrets are provisioned."

  **Whenever the prerequisite is another issue, ALSO set the GitHub-native `blocked_by` edge — the Project field alone is not machine-readable.** The dispatcher's stacking resolver (#1626) reads ONLY native `blocked_by` edges: with the edge set, a dependent auto-unblocks the moment its blocker's PR opens and dispatches **stacked on that PR's branch**; without it, the tri-state field leaves the issue waiting for a manual flip, and same-surface siblings dispatched in parallel invalidate each other (observed 2026-07-15: Stage 1 PRs #1730/#1731 were built on stale bases and thrown away because the plan's ordering existed only as prose). Recipe:

  ```bash
  # node IDs for both issues
  gh api graphql -f query='query{repository(owner:"Jinn-Network",name:"mono"){issue(number:<N>){id}}}' --jq .data.repository.issue.id
  # set: <dependent> is blocked by <blocker>
  gh api graphql -H "GraphQL-Features: issue_dependencies" -f query='mutation{addBlockedBy(input:{issueId:"<dependent-node-id>",blockingIssueId:"<blocker-node-id>"}){clientMutationId}}'
  # verify
  gh api graphql -H "GraphQL-Features: issue_dependencies" -f query='query{repository(owner:"Jinn-Network",name:"mono"){issue(number:<N>){blockedBy(first:10){nodes{number}}}}}' --jq '.data.repository.issue.blockedBy.nodes'
  ```

  Set BOTH surfaces: the `Blocked on: Another issue` field (the dispatcher ready-filter reads it) and the native edge (the stacking resolver reads it).

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
1. The full issue body (title + five sections) formatted for easy reading
2. The four taxonomy values:
   - Issue Type: `fix`
   - Blocked on: `Nothing`
   - Effort: `Low`
   - Priority: `P1`
   - Label (only if a human-surface change): `human-surface`

Invite edits: "Here's the draft. Anything you'd like to change before I file it?"

**On confirmation:** follow `references/gh-taxonomy.md` — create the issue with its Issue Type, add it to the "Jinn engineering" Project (number 1, owner `Jinn-Network`), and set the three fields (`Blocked on`, `Effort`, `Priority`). For a human-surface change, also apply the `human-surface` label (create it once with `gh label create human-surface` if it does not yet exist). Output the issue URL and number.

**On decline:** do not file. Leave the draft in the conversation. The person may copy it and file manually.

## Step 7 — Self-check before declaring done

Before you output the draft to the person, verify:

- [ ] Title is a one-line summary with no shape prefix.
- [ ] Issue Type is from the nine in Step 3 and confirmed.
- [ ] All five body sections are present and non-empty (or `Files/components: Unknown` / `Base / stacking: None — independent`).
- [ ] Every acceptance criterion is binary — answerable yes/no.
- [ ] All three routing fields are set (`Blocked on`, `Effort`, `Priority`).
- [ ] If this touches files an open PR also touches, is the base/stacking stated (`Base / stacking` line set, and `Blocked on: Another issue` if it stacks on unmerged code)?
- [ ] The body is short — no paragraph longer than 4 sentences, no external URLs or Slack links in the body (internal repo paths in `Files/components` are fine and encouraged).
- [ ] If this is a human-surface change: the `human-surface` label is applied and the body carries the `## Human-surface change` block (domain-model delta, design artifact, existing-user impact + comms plan).

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
| Filing as `Blocked on: Nothing` when the issue stacks on an unmerged PR | Set `Another issue` (referencing that PR) and add the `Base / stacking` line naming the branch/base |
| Filing a frontend / operator-visible change without the human-surface fields | Run the Step 3.5 check; if it's a human-surface change, add the label and the `## Human-surface change` block, or `implement-issue` will refuse it |
