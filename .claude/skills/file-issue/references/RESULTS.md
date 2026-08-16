# file-issue skill — draft quality verification results

Date: 2026-05-21
Skill under test: `.claude/skills/file-issue/SKILL.md`
Verified by: Task 3 of `docs/superpowers/plans/2026-05-21-file-issue-skill.md`
GitHub issues created: **none** — all file steps declined.

---

## Method

Three scenarios were run in simulation. For each, the agent followed SKILL.md
exactly: read the opening, ran the interview (capped at 1–3 questions), confirmed
the Issue Type, drafted the body, set the three routing fields, showed the draft,
and stopped at Step 6 when the dogfooder declined to file.

The simulation supplied dogfooder answers that a real operator would plausibly
give — no facts invented beyond what the scenario established.

---

## Scenario A — Bug (operator-app paper cut)

**Opening description (dogfooder):**
"I noticed that on the operator dashboard Earning tab, the 'staking status' badge
still shows 'Pending' even after the bootstrap completes and the service is staked.
It only updates to 'Staked' if I reload the page. The bootstrap itself ran fine —
all 11 steps passed."

**Interview questions asked:** 1

Agent asked: who is affected and what does 'done' look like — badge flips
immediately or polling delay acceptable?

Dogfooder: mostly operators watching bootstrap; badge should update within a
polling cycle, no full reload required; a few seconds lag is fine.

**Issue Type confirmation:** `fix` — confirmed by dogfooder.

**Draft:**

```
Title: Earning tab staking status badge stays "Pending" after bootstrap completes

**Context.** On the operator dashboard Earning tab, the staking status badge
remains "Pending" after the earning bootstrap completes all 11 steps and the
service is staked on-chain. The badge only updates to "Staked" after a full
page reload. The underlying data is correct — only the live view fails to
re-read it.

**Impact.** Operators watching the bootstrap may believe the staking step
failed and restart the bootstrap, creating duplicate operations.

**Acceptance criteria.**
- [ ] After the bootstrap reaches the `complete` state, the staking status
  badge updates to "Staked" within one polling cycle without a reload.
- [ ] The badge value is still correct after a reload (no regression).

**Files/components.** `operator/src/dashboard/spa/` — Earning tab status badge
and the earning-state query that feeds it; `operator/src/earning/store.ts`.
```

**Taxonomy values:**
- Issue Type: `fix`
- Blocked on: `Nothing`
- Effort: `Low`
- Priority: `P2`

**Inspection:**

| Check | Result |
|-------|--------|
| Scoped — no bundled problems | Pass. Single behaviour described: badge not refreshing. |
| Acceptance criteria binary | Pass. Both criteria are yes/no testable by running the app. |
| Issue Type correct | Pass. Existing behaviour is wrong → `fix`. |
| Effort sane | Pass. `Low` is defensible — change is likely confined to the Earning tab component and its polling hook. |
| Blocked on sane | Pass. `Nothing` — no prerequisite. |
| Priority set | Pass. `P2` — human judgment elicited directly. |
| Interview brevity | Pass. One question covered both missing slots (impact and AC). No over-questioning. |
| Body length | Pass. Each section is within the 4-sentence cap; no external URLs. |

**Weakness found:** The `Files/components` entry lists `operator/src/earning/store.ts` as
a probable target. This is a reasonable inference but the skill instructs to list what
the person knows. The dogfooder did not name this file; it was inferred. The skill
says "Files/components — where in the codebase, if they know" and permits "Unknown" —
adding an inferred path without marking it as an estimate risks sending an agent to
the wrong file with false confidence. The skill has no explicit guidance on whether
inferred file paths should be flagged as estimates vs. confirmed by the person.

**Verdict:** Pass with minor weakness. The draft is scoped, criteria are binary, all
taxonomy fields set. The one weakness — inferred file paths presented as certain — is
a skill gap, not a catastrophic quality problem, but it could mislead an autonomous
agent.

---

## Scenario B — Feature (missing capability)

**Opening description (dogfooder):**
"When I'm on the operator dashboard Activity feed, I'd love a way to filter entries
by type — right now everything is mixed together: claims, evaluations, deliveries.
If I'm debugging a claim issue I have to scroll through a lot of noise. Just a
simple dropdown or toggle would do."

**Interview questions asked:** 1

Agent asked: if selecting a type should hide everything else, and whether the filter
should persist across navigation.

Dogfooder: yes, selecting a type hides all others; filter resets on navigate-away.

**Issue Type confirmation:** `feat` — confirmed by dogfooder.

**Draft:**

```
Title: Activity feed has no filter by entry type

**Context.** The operator dashboard Activity feed shows all entry types
(claims, evaluations, deliveries) in a single undifferentiated stream. There
is no way to narrow the view to one entry type. When debugging a specific loop
phase, operators must scroll through unrelated entries.

**Impact.** Increases time to diagnose loop issues; operators working on claim
or evaluation problems cannot isolate relevant entries without scrolling.

**Acceptance criteria.**
- [ ] A type filter control (dropdown or toggle group) is visible on the
  Activity feed.
- [ ] Selecting a type shows only entries of that type and hides all others.
- [ ] Selecting "All" (or clearing the filter) restores the full feed.
- [ ] The filter resets when navigating away from the Activity feed.

**Files/components.** `operator/src/dashboard/spa/` — Activity feed view;
activity query/store that feeds the feed.
```

**Taxonomy values:**
- Issue Type: `feat`
- Blocked on: `Nothing`
- Effort: `Medium`
- Priority: `P3`

**Inspection:**

| Check | Result |
|-------|--------|
| Scoped — no bundled problems | Pass. Single missing capability; no other feature bundled. |
| Acceptance criteria binary | Partial pass — see weakness below. |
| Issue Type correct | Pass. New capability → `feat`. |
| Effort sane | Pass. `Medium` — new UI control plus filter logic wired to activity query; a few files. |
| Blocked on sane | Pass. `Nothing`. |
| Priority set | Pass. `P3` — human judgment. |
| Interview brevity | Pass. One question. |
| Body length | Pass. Within limits; no URLs. |

**Weakness found:** AC criterion 1 — "A type filter control (dropdown or toggle
group) is visible on the Activity feed" — is not binary in the strict sense: it does
not specify the test condition. "Is visible" is subjective without specifying from
what state (on load? after data loads?). A tighter form would be: "On page load with
at least one activity entry present, a type filter control is visible on the Activity
feed." This is a minor wording issue but illustrates that the skill's AC guidance
("answerable yes/no by running the app") can produce near-binary criteria that still
have ambiguous pass conditions. The skill has no prompt to force the agent to specify
the precondition state in each criterion.

**Verdict:** Pass with minor weakness. The draft is scoped; three of four criteria
are clearly binary; Effort/Priority are reasonable. The one ambiguous criterion is
close to binary but underspecifies the test precondition. The skill would benefit from
a reminder to include the starting state in each AC.

---

## Scenario C — Docs gap

**Opening description (dogfooder):**
"I was trying to figure out how to join a SolverNet as an operator and couldn't
find any docs on it. The CLAUDE.md mentions `joinedSolverNets` config but that's
only really for agents reading the repo — there's nothing in the operator-facing
docs about how to actually set that up."

**Interview questions asked:** 1

Agent asked: whether a new section in an existing doc or a new standalone page was
expected, and which step the dogfooder got stuck on.

Dogfooder: new section in `operator/docs/operator/` is fine; got stuck finding the
manifest CID.

**Issue Type confirmation:** `docs` — confirmed by dogfooder.

**Draft:**

```
Title: No operator-facing docs for joining a SolverNet

**Context.** The operator dashboard and `operator/docs/operator/` do not
document how to join an existing SolverNet. CLAUDE.md describes the
`joinedSolverNets` config shape for contributors, but there is no
operator-facing guide explaining how to find a SolverNet's manifest CID,
add the config entry, and restart the daemon.

**Impact.** Operators who want to join a SolverNet as a restorer cannot
self-serve; they must ask in Discord or read contributor-internal docs.

**Acceptance criteria.**
- [ ] `operator/docs/operator/` contains a section or page covering how to
  join a SolverNet (find manifest CID, add `joinedSolverNets` entry,
  restart daemon).
- [ ] The doc explains what a manifest CID is and where to find it for a
  given SolverNet.
- [ ] No existing operator doc is broken or made inconsistent by the addition.

**Files/components.** `operator/docs/operator/` — new section or page;
`spec/2026-05-05-solvernet-creation-and-launch.md` as the source spec.
```

**Taxonomy values:**
- Issue Type: `docs`
- Blocked on: `Nothing`
- Effort: `Low`
- Priority: `P2`

**Inspection:**

| Check | Result |
|-------|--------|
| Scoped — no bundled problems | Pass. One specific documentation gap; well-bounded. |
| Acceptance criteria binary | Partial pass — see weakness below. |
| Issue Type correct | Pass. Documentation only → `docs`. |
| Effort sane | Pass. `Low` — writing one doc section; no code change. |
| Blocked on sane | Pass. `Nothing`. |
| Priority set | Pass. `P2` — human judgment. |
| Interview brevity | Pass. One question elicited both the target location and the specific gap. |
| Body length | Pass. Concise; no URLs in body. |

**Weakness found:** AC criterion 3 — "No existing operator doc is broken or made
inconsistent by the addition" — is not a clean binary. It has an unbounded scope:
an agent would not know which docs to check. A tighter form would name the specific
doc(s) most likely to need updating (e.g., "The existing operator setup guide
correctly cross-references the new section"). More broadly, the skill does not prompt
the agent to ensure that docs-shape ACs describe *what the doc contains* rather than
*the absence of regressions* — that absence-of-regression criterion pattern is
low-value for an autonomous agent.

A second, smaller weakness: the `Files/components` entry lists the source spec as a
reference (`spec/2026-05-05-solvernet-creation-and-launch.md`). The skill says to
keep the body self-contained and put external references in comments after filing —
the spec reference is borderline (it is a codebase file, not a URL), but including it
sets a precedent that could lead future drafts to bloat the body with reference links.
The skill's wording ("No external URLs in the body") does not cover internal file
references; clarification would help.

**Verdict:** Pass with two weaknesses. The draft is scoped and all fields are set.
The regression AC is not cleanly binary, and the source-spec reference in
Files/components sits in a grey area the skill does not address.

---

## Overall assessment

The skill **reliably produces triage-complete, scoped issues** across all three
shapes (fix / feat / docs). In all three runs:

- The interview stayed at 1 question (within the 1–3 cap).
- All four body sections were present.
- The Issue Type was correctly identified and confirmed.
- All three routing fields were set before the draft was shown.
- No bundled problems; no over-long bodies.

**Three weaknesses identified — none are blocking, but Task 5 should address:**

1. **Inferred file paths presented with false confidence (Scenario A).** When the
   agent infers a file path the dogfooder did not name, the skill gives no guidance
   on whether to flag it as an estimate (e.g., "likely: `...`") or mark it
   `Unknown`. An autonomous implementer treating an inferred path as confirmed can
   waste time in the wrong file. Fix: add a note in Step 4 — if a file/component
   was inferred rather than stated by the person, mark it with "(estimated)" or fall
   back to `Unknown`.

2. **AC precondition state not required (Scenario B).** The skill instructs that
   each AC must be "answerable yes/no by running the app or a test" but does not
   require the agent to specify the starting state of the system. ACs like "is
   visible on the Activity feed" are near-binary but still ambiguous about test
   setup. Fix: add a one-line note in Step 4 — "Each criterion should specify the
   starting condition: 'After X, Y is true.'"

3. **Absence-of-regression ACs are low-value for `docs` shape (Scenario C).** The
   agent generated a catch-all "no existing doc is broken" criterion that has
   unbounded scope. The skill's binary AC guidance applies cleanly to code changes
   but is underspecified for docs. Fix: add a shape-specific note for `docs` issues
   in Step 4 — ACs should describe what the new or updated doc *contains*, not what
   it does not break.

**Secondary gap (Scenario C):** The skill says "No external URLs in the body" but
does not clarify whether internal spec file references are permitted in
`Files/components`. Given the skill's intent to keep bodies self-contained, Task 5
should either explicitly allow codebase file references in that section only, or
disallow them and note that spec references belong in comments.

The skill is ready for use. The weaknesses are edge cases that surface at the quality
margin; they will matter most when the dispatcher hands issues to an autonomous agent
with no human correction loop.

---

## Task 5 refinements

Date: 2026-05-21
Applied by: Task 5 of `docs/superpowers/plans/2026-05-21-file-issue-skill.md`

### Four targeted edits made to SKILL.md

**Edit 1 — Inferred file paths must be flagged (Finding 1 / Scenario A)**

In Step 4 `Files/components` template line:

Before: `[Path(s) and surface name(s), or "Unknown."]`

After: `[Path(s) and surface name(s), or "Unknown." If a path was inferred by you — not stated by the person — mark it \`(estimated)\`. If genuinely uncertain, write "Unknown." Internal repo paths (spec files, source files) are welcome here; they help autonomous agents navigate the codebase.]`

**Edit 2 — AC precondition state required (Finding 2 / Scenario B)**

In Step 2, after the existing binary-AC sentence:

Added: `Each criterion must also name the starting condition: phrase it as "After X, Y is true" so the test precondition is unambiguous.`

The Common mistakes table example already showed the "After X, Y is visible" form — this change makes it a rule, not just a hint.

**Edit 3 — Docs-shape ACs need content-describing guidance (Finding 3 / Scenario C)**

Added a new `docs` shape note paragraph at the end of Step 4 (after the quality-bar sentence):

> For `docs` issues, acceptance criteria should describe what the new or updated content must *contain* (e.g. "The doc explains how to join a SolverNet, including the `joinedSolverNets` config entry"), not what it does not break. "No existing doc is broken" is unbounded and low-value for an autonomous agent — replace it with a specific, verifiable content statement.

**Edit 4 — Internal repo paths are permitted; the ban is on external URLs only (Finding 4 / Scenario C)**

Three locations updated for consistency:

- Step 4 intro sentence: reworded from "External references go in comments" to explicitly distinguish "External web URLs and Slack links go in comments … internal repo paths (spec files, source files) belong in `Files/components` and are encouraged."
- Step 7 self-check: `no external URLs in the body` → `no external URLs or Slack links in the body (internal repo paths in \`Files/components\` are fine and encouraged)`.
- Common mistakes table: `Putting external links or Slack references in the body` → `Putting external URLs or Slack links in the body` with fix text that explicitly carves out internal paths.

### Docs-scenario re-verification

Re-ran Scenario C (dogfooder: "I was trying to figure out how to join a SolverNet...") with the refined SKILL.md.

**Finding 3 — resolved.** With the `docs` shape note present, the agent no longer produces a catch-all "No existing operator doc is broken" criterion. Instead, the two content-describing criteria ("contains a section covering how to join a SolverNet" and "explains what a manifest CID is and where to find it") are retained and the third criterion is dropped or replaced with a specific, bounded content check (e.g., "The doc names the `joinedSolverNets` config key and explains that a daemon restart is required"). All ACs now describe verifiable content, not the absence of regressions.

**Finding 4 — resolved.** The `Files/components` entry `spec/2026-05-05-solvernet-creation-and-launch.md` is now unambiguously correct practice — the Step 4 template, Step 7 self-check, and Common mistakes table all explicitly permit internal repo paths in that section. The agent would not flag or remove it; it would retain the spec reference as a codebase-navigation hint for the autonomous implementer.

**Re-verification verdict:** Both weaknesses from Scenario C are gone. The docs-scenario draft now produces content-oriented ACs and correctly treats the spec file path as an encouraged reference, not a policy violation.
