# Guard Integrity — Proving a Green Check Can Go Red

- **Version:** 1.0
- **Date:** 2026-09-05
- **Status:** **Proposed** — design-session output; decisions D1–D3 await an operator ruling
- **Shape:** `design` (Issue [#2443](https://github.com/Jinn-Network/mono/issues/2443), Effort High, P2)
- **Scope:** the class of repository checks that report green while testing nothing — both the
  unwired-guard shape and the vacuous-assertion shape named in #2443 — and the mechanism that
  makes each one detectable rather than a matter of individual coordinator diligence
- **Out of scope:** the individual re-seal fixes (already shipped in PRs #2398 / #2428 / #2437 /
  #2442); test coverage policy generally; the merge-queue required-check set; any change to what
  the guards themselves assert
- **Context:** #2443 filed the pattern rather than the instances, after the DevX re-seal program
  (#2396) hit it five times across two shapes. It proposed three countermeasures. This session
  re-grounds all three against the tree as it stands one month later, and finds the picture has
  changed enough that the original framing needs amending rather than executing.

## 1. Method

A reality check of the repository at `next` (merge-base `a4c9ac747`), covering: the
`.github/scripts` test population and its workflow wiring; every guard-shaped script declared in
a workspace `package.json` and whether any workflow invokes it; the handbook's test-discipline
rules; and the negative-assertion population that countermeasure 3 would have to audit.

No implementation was performed — `design` sessions produce a design doc, not code (handbook
§The shapes of work). Where a finding names a concrete fix, §6 proposes it as follow-up work
instead of applying it here. The session has no issue-filing authority, so §6 is a proposal for a
human or a subsequent session to enact, not a record of issues created.

One check could not be run: `yarn skill:check` needs an `operator` dependency install and build,
which this session did not perform. This document therefore claims only that **nothing runs it**,
never that its committed tables are currently drifted.

## 2. The reframing — one property, two shapes

#2443 describes two shapes. They are better treated as one property with two ways of failing:

> **A guard's green is evidence only if something can make it red.**

- **Shape 1** — nothing runs the guard, so it can never go red. Its green is not a signal; it is
  the absence of a signal, rendered in the same color.
- **Shape 2** — something runs the guard, but no reachable input makes it fail. Same outcome,
  reached from the other side.

The value of collapsing the two is that they stop needing separate countermeasures. Shape 1 has a
cheap mechanical proxy (is it wired?), already built. Shape 2 has no such proxy, which is why
#2443 called countermeasure 3 "genuinely open" — but it does not need one, because the underlying
property is directly demonstrable: **plant a violation and watch the guard fail.** That is what
the coordinators on C2 and C7 did by hand, and it is precisely what gave them confidence.

The design below promotes that hand-run ritual into the artifact, where it is durable and
reviewable, rather than into a checklist, where it is not.

## 3. Findings

### F1 — Countermeasure 1 shipped, and shipped well

`.github/scripts/workflow-script-tests.test.mjs` implements the proposed meta-check: it lists
every `.github/scripts/*.test.mjs`, collects the ones referenced by a workflow `node --test`
invocation, and fails naming each orphan alongside a suggested owning workflow — exactly the
failure message #2443 asked for. It is wired into `repository-structure.yml:87`. It has since
grown well past its original remit, and now also pins in-checkout fixture hygiene and
parallel-invocation isolation.

**Countermeasure 1 is closed as specified.** The decisions below concern its scope, not its
existence.

### F2 — The instance that motivated countermeasure 1 is still open

The check's population is exactly `.github/scripts/*.test.mjs`. The Shape-1 instance #2443 named
by name — `yarn skill:check`, the drift gate for the generated operator skill tables — is a
`package.json` script, so it falls outside that population and is **still unowned by any workflow
today**, a month after being filed as the motivating example.

A census of guard-shaped scripts across every workspace `package.json` (names matching
check / verify / guard / lint / audit) finds 18, of which 3 are referenced by no workflow:

| Script | What it guards | Assessment |
|---|---|---|
| `operator: skill:check` | drift between the generated operator `SKILL.md` tables and the live CLI/MCP registries | **Genuine gap.** The instance #2443 named. |
| `operator: generate:openapi:check` | drift between the committed OpenAPI artifact and the generator | **Genuine gap.** Its own header describes it as "the same shape as `.github/scripts/generate-architecture.mjs --check`" — and that sibling *is* wired (`platform-architecture-control.yml:50`). The asymmetry is unintentional. |
| `operator: substrate:verify` | live-chain substrate state (RPC, funded wallets) | **Correctly unwired.** Not a statically runnable CI guard. |

The third row is the load-bearing one for the design: a blanket "every guard must be wired" rule
would be wrong, and would be worked around rather than obeyed. The obligation has to admit a
declared, justified exemption — the same shape `workflow-script-tests.test.mjs` already uses for
`LIVE_TREE_MUTATING_TESTS`.

### F3 — The Shape-1 countermeasure contains a Shape-2 instance

`workflow-script-tests.test.mjs` carries a test named
`findOrphanedScriptTests detects a planted orphan`. Its entire body is:

```js
assert.deepEqual(findOrphanedScriptTests(scriptsDir, workflowsDir), []);
```

`scriptsDir` and `workflowsDir` are the real repository directories, and are also the function's
defaults. **Nothing is planted.** The test asserts that the live tree has no orphans — which is
what the test immediately above it already asserts. If `findOrphanedScriptTests` were broken to
return `[]` unconditionally, both tests would still pass, and the name of the second would still
claim otherwise.

Contrast the fixture-scanner tests later in the same file, which do it correctly — they build a
violating source string, run the detector against it, and assert it is caught:

```js
const violating = [
  "const root = resolve(import.meta.dirname, '../..');",
  "mkdtempSync(join(root, 'packages', 'tmp-not-dot-prefixed-'));",
].join('\n');
const [{ segments }] = findInCheckoutFixtureCalls(violating);
```

The correct pattern is not merely present elsewhere in the file; it is already a **named
convention** in the repository. `docs-key-guard.test.mjs` — run from the same workflow job, eight
lines above the orphan check — carries:

```
test('self-test: a non-Anvil key in key context is flagged; Anvil accounts #0 and #1 are not', ...)
```

It writes a synthetic key into a temp fixture, asserts the scanner flags exactly that key, and
asserts the two legitimate Anvil keys are *not* flagged — proving in one test that the guard is
neither blind nor over-broad. The `self-test:` prefix is the convention's name.

The convention is therefore already established, already carries a name, and is already applied
correctly by some guards and not others. D2a below codifies it rather than inventing it.

This is the strongest available evidence for §2's thesis. The vacuity is not in a neglected
corner; it is inside the countermeasure built to answer #2443, written by coordinators who were
thinking about exactly this failure mode, sitting one screen away from the correct pattern. A
review-checklist item would not have caught it, because the misleading name is what makes it
invisible — a reader scanning the test list sees a planted-orphan test and moves on. Only an
executable obligation catches this.

### F4 — Countermeasure 2 is absent

`docs/engineering/handbook.md` contains no red-test discipline: no mention of demonstrating a
guard failing, planting a violation, or vacuity. The natural home exists and has precedent —
rule 7 ("TDD for new features, regression test for fixes") already carries a sub-bullet,
**Boundary tests for numeric gates**, added the same way for the same reason: a specific observed
failure class that generic TDD did not prevent. Red-test discipline is a second such sub-bullet.

Also relevant: the `test` shape's own row in §The shapes of work lists its observed pitfall as
"Adding tests that pass without exercising the surface" — the Shape-2 class, already named in the
handbook, with no mechanism attached.

### F5 — Countermeasure 3 is unbounded as stated

A periodic vacuity audit of negative assertions would face roughly 200 occurrences across 48
files in `.github/scripts` alone, before counting `operator/test` or any package suite. Every one
would need a human to reason about reachability. The yield would be low — most negative
assertions are fine — and the cost recurs on every audit cycle, which is the profile of a
practice that is adopted once and quietly dropped.

More usefully: every Shape-2 instance in #2443's own table shares one precipitating event. C1's
prefix check, C1's record-kind assertions, C2's three negative guards, C7's `selfIdentifyingClaim`
skip and its retired-apex skip all went vacuous because **an identifier, origin, or namespace was
renamed and the assertion kept naming the old one**. That is not a property of negative assertions
in general. It is a property of negative assertions during a rename — which is a bounded,
observable event, not a continuous audit obligation.

## 4. Decisions

Three decisions, each stated as a recommendation for operator ratification.

### D1 — Extend the wiring obligation to declared guard scripts

**Recommended.** Generalize the population from `.github/scripts/*.test.mjs` to *declared
guards*: a workspace `package.json` script may be marked as a CI guard, and every marked guard
must be invoked by at least one workflow.

Mechanism, in the shape the existing check already uses:

- A manifest in `workflow-script-tests.test.mjs` (or a sibling) enumerating guard scripts and
  their expected owning workflow, with an explicit `NOT_CI_RUNNABLE` set carrying a one-line
  justification per entry — `substrate:verify` being the first member, because it needs live RPC.
- Discovery stays name-based (`check` / `verify` / `guard` / `lint` / `audit`) so a newly added
  guard is caught by default rather than needing to be remembered into a list. A new
  guard-shaped script that is neither wired nor justified fails the check.
- Failure message keeps #2443's requirement: name the orphan and the nearest workflow that ought
  to own it.

This closes the specific gaps in F2. `skill:check` and `generate:openapi:check` each need a
workflow owner as part of the same change — the check is only honest if the tree it guards is
clean when it lands.

**Rejected alternative:** a blanket rule with no exemption set. It would misclassify
`substrate:verify`, and a guard that cries wolf on a correct configuration gets an exemption
added to it anyway — informally, and without the justification text.

### D2 — Red-test discipline, in the artifact rather than the checklist

**Recommended, in two parts.**

**D2a — the self-red test convention.** Adopt the `self-test:` prefix already in use (F3) as
the repository convention, and make it an obligation: a guard that exposes a detector function
must carry a `self-test:` case that feeds it a constructed violation and asserts the violation is
caught. Where a guard can be over-broad as well as blind, the same case should also assert that a
legitimate near-miss is not flagged, as `docs-key-guard.test.mjs` does. The constructed
input must not be the live tree: a detector run against the real repository proves only that the
repository is currently clean, which is what the guard's own assertion already proves. This is
the difference between the two exhibits in F3, stated as a rule. The prefix buys a cheap
secondary property: a reviewer scanning a test list can see at a glance which guards carry a red
proof and which do not — exactly the visibility F3 shows was missing.

Where the detector is not separable from the check — a workflow step that greps, a `--check` flag
on a generator — the equivalent is a fixture the guard is pointed at, or, failing that, a written
note in the PR body recording the by-hand red run (plant, observe non-zero, remove), which is
what C2 and C7 did.

**D2b — the handbook rule.** Add a sub-bullet under AI workflow rule 7, alongside **Boundary
tests for numeric gates**, following its established form: name the failure class, name the
observed instances, name the mechanism, and point at the canonical example. Proposed wording is
carried in the follow-up issue rather than inlined here, since the handbook is CODEOWNER-gated
(`.github/CODEOWNERS`) and its wording is properly settled in the PR that lands it.

**Rejected alternative:** requiring a self-red test for every existing guard as a precondition.
That is an unbounded retrofit with the same profile as F5. The obligation applies to guards
added or materially changed from ratification onward; the existing population is left alone
except where a guard is being touched anyway.

### D3 — Decline the general vacuity audit; adopt the rename trigger instead

**Recommended.** Do not adopt a periodic audit of negative assertions (F5). Replace it with two
narrower obligations that cover the same instances at a fraction of the cost:

1. **Forward cover** — D2a. New guards carry their own red proof, so new Shape-2 instances do not
   accumulate.
2. **The rename trigger** — a PR that renames an identifier, origin, namespace, or record kind
   must re-ground every negative assertion naming the old spelling, in the same PR. This lands as
   a classification item in the reviewer's pass (`.claude/skills/review-pr/SKILL.md` §Review
   pass), deliberately rather than as a mechanical gate, because it is triggered by an event a
   reviewer can see in the diff rather than requiring a standing sweep. It is also the one place
   the trigger reaches both human and Autopilot reviews through a single edit. Every Shape-2 instance in #2443's table would
   have been caught by it.

The residue this leaves is honest and worth stating: **Shape-2 instances that predate ratification
and are never touched again stay undetected.** No mechanism in this design finds them. The
alternative — the standing audit — was assessed as more likely to be dropped than to find them,
so the design accepts the residue rather than pricing in a practice it does not expect to survive.

## 5. Non-goals

- No change to what any existing guard asserts.
- No retrofit of self-red tests across the existing guard population.
- No new required check in the merge queue; D1 extends an existing check that already runs.
- No tooling to detect vacuity by static analysis. Reachability of a negative assertion is not
  decidable cheaply, and the attempt would produce a guard that itself needs a vacuity audit.

## 6. Proposed follow-up work

This session produces no implementation. Four follow-up issues are proposed; the first is
independently valuable and small enough to land on its own.

| # | Shape | Work | Depends on |
|---|---|---|---|
| 1 | `fix` | Make `findOrphanedScriptTests detects a planted orphan` actually plant one — pass it a constructed scripts/workflows pair containing a known orphan and assert it is returned. F3; a live broken guard, and the change is a few lines. | none |
| 2 | `chore` | Implement D1: guard-script manifest with a justified `NOT_CI_RUNNABLE` set, name-based discovery, orphan-naming failure message; wire `skill:check` and `generate:openapi:check` to owning workflows in the same PR. | D1 ratified |
| 3 | `docs` | Implement D2b: rule 7 sub-bullet in `docs/engineering/handbook.md`, naming `.github/scripts/docs-key-guard.test.mjs` as the canonical `self-test:` example — the form rule 7's boundary-test bullet already uses. CODEOWNER-gated; author and approve under different operator credentials. | D2 ratified |
| 4 | `docs` | Implement D3's rename trigger as a classification item under §Review pass in `.claude/skills/review-pr/SKILL.md`, and update the skill-text contract pins in the same change (`.github/scripts/autopilot-skill-contracts.test.mjs`), per `docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md` §7. | D3 ratified |

Issue 1 does not depend on ratification of anything — it repairs a guard that is broken today
against the standard the guard's own file already sets elsewhere.

## 7. Questions for ratification

1. **D1 scope** — is name-based discovery (`check` / `verify` / `guard` / `lint` / `audit`) the
   right default, accepting that it will occasionally catch a script that is not a guard and need
   a justification line? The alternative is an opt-in marker, which is cheaper to get right and
   easier to forget, reintroducing the failure this closes. Recommendation: name-based.
2. **D2a strictness** — should a missing self-red test fail CI, or be a review expectation? A
   mechanical check would have to decide what counts as a constructed input, which is the kind of
   judgment that produces false positives and then exemptions. Recommendation: review
   expectation, backed by the handbook rule, with the mechanical half of the coverage carried by
   D1 where it can be mechanical.
3. **D3 residue** — is the untouched pre-ratification Shape-2 population an acceptable residue
   (§4, D3)? If not, the scoped alternative is a one-time audit bounded to assertions naming any
   identifier touched by the re-seal, rather than to negative assertions generally.
