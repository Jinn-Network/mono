# merge-batch ordering-decision verification results

Date: 2026-05-21  
Task: 3 of `docs/superpowers/plans/2026-05-21-merge-batch-skill.md`  
Scope: Step 1 (Survey) + Step 2 (Decide order) only — no real merges, no writes to `next`, no `gh` mutations.

---

## Synthetic batch

Five PRs against `next`, all CI-green, none `Blocked on: Human`.

| PR | Title | Files | Linked-issue Blocked on |
|----|-------|-------|------------------------|
| #101 | `feat(daemon): add balance topup loop` | `client/src/daemon/balance-topup.ts` | Nothing |
| #102 | `fix(api): correct artifact search pagination` | `client/src/api/server.ts` | Nothing |
| #103 | `feat(daemon): balance topup metrics` | `client/src/daemon/balance-topup.ts`, `client/src/daemon/metrics.ts` | Another issue #101 (branched on PR #101's branch) |
| #104 | `fix(store): tighten artifact dedup` | `client/src/store/store.ts` | Nothing |
| #105 | `refactor(store): rework the artifact dedup key` | `client/src/store/store.ts` | Nothing; deep semantic overlap with #104 (same dedup logic) |

---

## Step 1 output — candidate set

Drop rules applied:
- CI red / pending: none dropped (all CI-green per scenario).
- `Blocked on: Human`: none dropped (no PR carries that field value).

**Candidate set:** PR #101, #102, #103, #104, #105 (all five retained).

---

## Step 2 output — reasoning trace

### Tier 1 — Known dependency stacks

PR #103's linked issue has `Blocked on: Another issue #101`. The dispatcher stacked #103 on #101's branch at dispatch time. #101 must merge before #103.

Stack identified: **#101 (root) → #103 (dependent)**.

No other `Blocked on: Another issue` relationships present.

### Tier 2 — `refactor` stacks

PR #105 carries the `refactor(store)` prefix. The skill inspects for strangler-fig stacks: overlapping file paths among other `refactor` PRs in the batch. PR #104 is `fix(store)`, not `refactor`. No declared multi-PR strangler-fig stack is detectable from titles + file lists alone. The #104/#105 overlap does not qualify as Tier 2 — it falls to Tier 3 as an unforeseen reactive overlap.

### Tier 3 — Reactive overlap

File-set intersection scan across non-stacked PRs (#102, #104, #105):

- `client/src/api/server.ts` — unique to #102. No overlap.
- `client/src/store/store.ts` — shared by #104 and #105.

PR #104 and PR #105 overlap on `store.ts`. The overlap is **deep**: both touch the same artifact dedup logic (PR #104 tightens it; PR #105 reworks the key — likely same function or module section). Tier 3 rules:
- Order them adjacent.
- Simpler first: PR #104 is a targeted fix (fewer lines of change expected for a "tighten"), PR #105 is a rework (broader). #104 merges first.
- Deep overlap flag: after #104 merges, rebase #105's branch on the new `next` immediately before merging it. Note the risk of a semantic conflict — if both PRs modified the same dedup function body, the rebase may produce a conflict that cannot be auto-resolved. Plan to escalate to `Blocked on: Human` if the rebase conflict is semantic.

### Independent PRs

PR #102 (`fix(api): correct artifact search pagination`) — file `client/src/api/server.ts` has no intersection with any other PR in the batch. No dependency, no overlap. FIFO.

### Ordered merge list

Groups ordered by their lowest member's PR number (inter-group FIFO):
- Tier 1 stack {#101, #103}: lowest = #101
- Independent {#102}: = #102
- Tier 3 overlap pair {#104, #105}: lowest = #104

```
1. PR #101 — "feat(daemon): add balance topup loop"          [dependency-stack, root]
2. PR #103 — "feat(daemon): balance topup metrics"           [dependency-stack, on #101]
3. PR #102 — "fix(api): correct artifact search pagination"  [independent]
4. PR #104 — "fix(store): tighten artifact dedup"            [reactive-overlap, simpler first]
5. PR #105 — "refactor(store): rework the artifact dedup     [reactive-overlap, after #104;
              key"                                            deep overlap — reactive-stack
                                                              before merge; semantic conflict
                                                              risk, escalate if needed]
```

---

## Verdict per check

### Check 1 — PR #101 ordered before PR #103

**PASS.** PR #101 is entry 1; PR #103 is entry 2. Tier 1 dependency-stack logic correctly identifies the `Blocked on: Another issue #101` field and enforces bottom-up ordering.

### Check 2 — PR #104 and #105 adjacent with #104 first; #104/#105 overlap flagged as deep; #105 noted for reactive stacking / semantic conflict

**PASS.** PR #104 is entry 4 and PR #105 is entry 5 — they are adjacent. #104 (narrower fix) is ordered first. The overlap is flagged as deep, and the plan notes: rebase #105 onto new `next` immediately after #104 merges, with explicit escalation path to `Blocked on: Human` if the rebase conflict is semantic. All three sub-criteria satisfied.

### Check 3 — PR #101 and PR #102 present as independent, correctly unblocked

**PASS (with a nuance noted below).** PR #102 appears as entry 3, annotated `[independent]`. PR #101 appears as entry 1, annotated `[dependency-stack, root]` — it is unblocked (its own `Blocked on` field is "Nothing") and correctly treated as the root of its stack, not as a dependent. Both are in the candidate set, neither was dropped.

### Check 4 — No PR dropped that should not be

**PASS.** All five PRs are in the ordered merge list. No PR has `Blocked on: Human` and none has failed CI, so none should have been dropped. The candidate set retention is correct.

---

## Weaknesses found

### Weakness 1 — Inter-group ordering is under-specified in the skill

The skill defines intra-group ordering clearly (bottom-up for Tier 1, adjacent-simpler-first for Tier 3) but is silent on how to order groups relative to each other when no cross-group dependency exists. In the synthetic batch, placing the Tier 1 stack (#101 → #103) before the independent (#102) before the Tier 3 pair (#104 → #105) is the most natural reading of "FIFO by PR number for independent PRs," extended across groups. But the skill does not state this explicitly. A reader could equally place #102 (PR number 102, lower than #103's 103) between #101 and #103, producing:

```
1. #101  [dependency-stack, root]
2. #102  [independent]
3. #103  [dependency-stack, on #101]  ← still after #101, so Tier 1 is satisfied
4. #104  [reactive-overlap, simpler first]
5. #105  [reactive-overlap, after #104]
```

This alternative is also valid per the skill text, because Tier 1 only requires #101 before #103, not that they be *consecutive*. The skill does not say dependency-stack members must be adjacent. Two plausible orderings exist with no textual tie-breaker. This is a latent ambiguity — not a bug in the synthetic test, but a gap that could cause non-deterministic output if the skill is run by different agents or at different times.

**Recommended fix (for Task 5):** Add a rule in the Step 2 "Independent PRs" section: "When ordering groups relative to each other, keep all members of a Tier 1 or Tier 3 group consecutive (do not interleave independent PRs into a group). Order groups by their lowest-numbered member."

### Weakness 2 — Tier 2 detection is file-overlap-plus-prefix heuristic, not stack-order lookup

The skill identifies `refactor` stacks by "the `refactor` shape prefix on the PR title plus overlapping file paths." For PR #105 in the synthetic batch, there is no second `refactor` PR to pair with it, so it falls correctly to Tier 3. But if a batch contained, say, PR #105 and PR #106 both prefixed `refactor(store)` and sharing `store.ts`, the skill relies on the *declared stack order* from the `refactor` coordinating agent — which is not surfaced in `gh pr list` output. The `files` field plus title prefix is a proxy for the actual stack order. There is no check that the declared `gh-stack` order is respected. This is not triggered by the synthetic batch but is worth noting for production use.

---

## Assessment

The ordering reasoning holds for the synthetic batch. All four verification checks pass. The skill correctly applies Tier 1 (dependency ordering, bottom-up), Tier 3 (reactive overlap, adjacent + simpler first + deep-flag), and the independent FIFO rule. The two weaknesses are latent gaps — the inter-group ordering ambiguity (Weakness 1) is the more actionable one and should be addressed in Task 5's skill refinement. The Tier 2 detection gap (Weakness 2) is lower priority but worth a note in the skill's "Read first" section or a future iteration.

---

## Task 5 refinements (2026-05-21)

### Edit 1 — Inter-group ordering rule (Weakness 1, actionable)

**Before:** Step 2's "Independent PRs" section ended with "FIFO by PR number is correct for these." There was no rule governing how groups ordered relative to each other or stating that groups must be consecutive.

**After:** A new "Inter-group ordering" subsection was added between "Independent PRs" and "Output":

> All members of a Tier 1 dependency stack, a Tier 2 refactor stack, or a Tier 3 reactive-overlap group must stay **consecutive** in the merge order — a group is never interleaved with unrelated PRs. Once each group's internal order is fixed, order the groups (and any independent PRs) by each group's or PR's **lowest member number** (FIFO). This makes the full ordering deterministic when multiple groups and independent PRs are present.

### Edit 2 — Tier 2 `gh-stack` authoritative-source note (Weakness 2, lower priority)

**Before:** Tier 2 identified refactor stacks by "the `refactor` shape prefix on the PR title plus overlapping file paths" with no mention of `gh-stack`.

**After:** Added a sentence making `gh-stack` the authoritative source when available, with the heuristic as fallback:

> When `gh-stack` is available it is the authoritative source of the declared stack order; use `gh stack list` to read it. The title-prefix + overlapping-file-paths heuristic is the fallback for when `gh-stack` is not installed (see `references/merge-mechanics.md` — `gh-stack` is currently not installed in this environment).

### Re-verification — synthetic batch

Re-applied the refined Step 2 to the same five PRs:

- Tier 1 stack {#101 → #103}: lowest member = 101. Must be consecutive.
- Independent {#102}: lowest member = 102.
- Tier 3 overlap pair {#104 → #105}: lowest member = 104. Must be consecutive.

Inter-group ordering by lowest member: 101 < 102 < 104.

**Result: single unambiguous order — #101, #103, #102, #104, #105.**

The alternative identified in Weakness 1 (inserting #102 between #101 and #103) is now explicitly prohibited by the consecutiveness rule. The ordering is deterministic. Both weaknesses are resolved.

---

## Task — Code-owner review gate verification (2026-05-26)

Date: 2026-05-26
Task: Issue #608 — `merge-batch` skill considers PRs without code-owner approval
Scope: Step 1 — Survey (Code-owner review gate) only — no real merges, no writes to `next`, no `gh` mutations.

This block is the AC3 regression artifact for Issue #608. It exercises the new
Code-owner review gate added to Step 1 of `SKILL.md` (the operational pseudocode
lives in `references/merge-mechanics.md` Step 1.5). The synthetic batch covers
the four AC3-named scenarios — external-author with green CI and only a
non-member approval, properly code-owner-approved, no-coverage path with a real
MEMBER/OWNER approval, and stale-approval invalidation — plus a coverage-case
drop (CODEOWNERS-covered path lacking a qualifying owner's approval) and a
re-statement that operator blanket-authorization to approve does not bypass the
gate (AC2). The two distinct skip-reasons surfaced by the gate
(`awaiting maintainer review` for the no-coverage case,
`awaiting code-owner review` for the coverage case) are both exercised by at
least one worked example so AC1's human-visible output is covered on both
sides.

### CODEOWNERS — relevant lines

The gate parses `.github/CODEOWNERS` at the current `next` HEAD. For this
synthetic batch, the only patterns that match touched files are the
canonical-doc rules:

```
/PRINCIPLES.md @oaksprout @ritsukai
/SPEC.md       @oaksprout @ritsukai
/THESIS.md     @oaksprout @ritsukai
/BRAND.md      @oaksprout @ritsukai
/GROWTH.md     @oaksprout @ritsukai
/GLOSSARY.md   @oaksprout @ritsukai
/CLAUDE.md     @oaksprout @ritsukai
/README.md     @oaksprout @ritsukai
```

No pattern matches any path under `client/`, `contracts/`, or `.claude/`. Paths
that do not match any pattern produce an empty owner-set (the **no-coverage
case**); paths that match `/PRINCIPLES.md` produce the owner-set
`{oaksprout, ritsukai}` (the **coverage case**). Per `merge-mechanics.md`
Step 1.5 the gate normalizes CODEOWNERS owner tokens by stripping the leading
`@` before set-membership tests, so the bare login `oaksprout` (as returned by
`latestReviews[*].author.login`) is the canonical form throughout this trace.

### Synthetic batch

Five PRs against `next`, all CI-green, none `Blocked on: Human`. Each PR's
`headRefOid` is the SHA the gate compares against `latestReviews[*].commit.oid`.

| PR | Title | Author (login / authorAssociation) | Files touched | latestReviews summary | headRefOid |
|----|-------|------------------------------------|---------------|------------------------|------------|
| #901 | `feat(client): add a foo helper` | `dvilelaf` / NONE | `client/src/foo.ts` | one entry: `ritsukai-bot` / CONTRIBUTOR / APPROVED / commit.oid = `aaa1111` (matches head) | `aaa1111` |
| #902 | `docs: update PRINCIPLES` | `someone-else` / MEMBER | `/PRINCIPLES.md` | one entry: `oaksprout` / OWNER / APPROVED / commit.oid = `bbb2222` (matches head) | `bbb2222` |
| #903 | `fix(daemon): correct foo race` | `external-contributor` / NONE | `client/src/daemon/foo.ts` | one entry: `oaksprout` / OWNER / APPROVED / commit.oid = `ccc3333` (matches head) | `ccc3333` |
| #904 | `feat(client): add Y helper` | `someone` / CONTRIBUTOR | `client/src/bar.ts` | one entry: `ritsukai` / MEMBER / APPROVED / commit.oid = `ddd4444-OLD` (does **not** match head `ddd4444`) | `ddd4444` |
| #905 | `docs: update PRINCIPLES` | `dvilelaf` / NONE | `/PRINCIPLES.md` | one entry: `ritsukai-bot` / CONTRIBUTOR / APPROVED / commit.oid = `eee5555` (matches head) | `eee5555` |

Operator note recorded at the start of this batch: *"Approve any PR you would
have approved yourself — blanket authorization for this batch."* This is the
operator authorization clause the gate must explicitly refuse to honour when
the code-owner gate would drop a PR (AC2).

### Step 1 output — candidate set after the Code-owner review gate

Drop rules applied (in order):

- CI red / pending: none dropped (all CI-green per scenario).
- `Blocked on: Human`: none dropped (no PR carries that field value).
- Code-owner review gate: drops #901 (`awaiting maintainer review`), #904
  (`awaiting maintainer review`), and #905 (`awaiting code-owner review`).

**Candidate set:** #902, #903 (two PRs survive the gate).

| PR | Disposition | Reason (drop only) |
|----|-------------|--------------------|
| #901 | dropped | `skipped: awaiting maintainer review` (no-coverage case, non-member approver) |
| #902 | kept | — |
| #903 | kept | — |
| #904 | dropped | `skipped: awaiting maintainer review` (no-coverage case, stale approval) |
| #905 | dropped | `skipped: awaiting code-owner review` (coverage case, owner-set intersection empty) |

### Reasoning trace — per-PR

For each PR the trace shows: CODEOWNERS lookup → `requiredOwners`
computation → author exclusion → `currentApprovers` after stale-approval
filtering → decision case (coverage / no-coverage) → keep / drop verdict.

**PR #901 — external-author, no-coverage path, non-member approval**

- File touched: `client/src/foo.ts`. No CODEOWNERS pattern matches → owner-set for this file is empty.
- `requiredOwnerSets` = `{}` (no covered paths). `requiredOwnersUnion` = `{}`.
- Author exclusion: `dvilelaf` removed from owner-sets (no-op — sets already empty).
- `currentApprovers` after stale filter: `{ritsukai-bot}` — the review's `commit.oid = aaa1111` matches `headRefOid`, the review is `APPROVED`, and the reviewer is not the author.
- Decision case: **no-coverage** (`requiredOwnerSets` is empty).
- Required: at least one approving review with `authorAssociation ∈ {OWNER, MEMBER}` from a non-author reviewer. `ritsukai-bot` has `authorAssociation == CONTRIBUTOR`, which is **not** in the whitelist.
- **Verdict: drop with `skipped: awaiting maintainer review`.**

**PR #902 — properly code-owner-approved canonical-doc PR**

- File touched: `/PRINCIPLES.md`. Last-match-wins lookup hits the `/PRINCIPLES.md @oaksprout @ritsukai` line → owner-set `{oaksprout, ritsukai}` (after `@`-stripping normalization).
- `requiredOwnerSets` = `{ {oaksprout, ritsukai} }`. `requiredOwnersUnion` = `{oaksprout, ritsukai}`.
- Author exclusion: PR author is `someone-else`, not in the set — no change.
- `currentApprovers` after stale filter: `{oaksprout}` — `commit.oid = bbb2222` matches `headRefOid`, `APPROVED`, not the author.
- Decision case: **coverage** (`requiredOwnerSets` is non-empty).
- Required: every distinct owner-set in `requiredOwnerSets` has at least one current approver in it. The single set `{oaksprout, ritsukai}` ∩ `{oaksprout}` = `{oaksprout}` — non-empty.
- **Verdict: keep.**

**PR #903 — no-coverage path with a real OWNER approval**

- File touched: `client/src/daemon/foo.ts`. No CODEOWNERS pattern matches → owner-set empty.
- `requiredOwnerSets` = `{}`. `requiredOwnersUnion` = `{}`.
- Author exclusion: PR author is `external-contributor`, not in any set — no change.
- `currentApprovers` after stale filter: `{oaksprout}` — `commit.oid = ccc3333` matches, `APPROVED`, not the author.
- Decision case: **no-coverage**.
- Required: at least one approving review with `authorAssociation ∈ {OWNER, MEMBER}` from a non-author reviewer. `oaksprout` has `authorAssociation == OWNER` — whitelisted.
- **Verdict: keep.**

**PR #904 — stale approval (head-SHA mismatch)**

- File touched: `client/src/bar.ts`. No CODEOWNERS pattern matches → owner-set empty.
- `requiredOwnerSets` = `{}`. `requiredOwnersUnion` = `{}`.
- Author exclusion: PR author is `someone`, not in any set — no change.
- Stale-approval filter: the single `latestReviews` entry has `commit.oid = ddd4444-OLD`, which does not match `headRefOid = ddd4444`. The review is invalidated.
- `currentApprovers` after stale filter: `{}` (empty — the only approval was stale).
- Decision case: **no-coverage**.
- Required: at least one current approving review with `authorAssociation ∈ {OWNER, MEMBER}`. There is no current approving review at all.
- **Verdict: drop with `skipped: awaiting maintainer review`.**

**PR #905 — coverage-case drop (CODEOWNERS-covered path, non-owner approval)**

- File touched: `/PRINCIPLES.md`. Last-match-wins lookup hits the `/PRINCIPLES.md @oaksprout @ritsukai` line → owner-set `{oaksprout, ritsukai}` (after `@`-stripping normalization).
- `requiredOwnerSets` = `{ {oaksprout, ritsukai} }`. `requiredOwnersUnion` = `{oaksprout, ritsukai}`.
- Author exclusion: PR author is `dvilelaf`, not in `{oaksprout, ritsukai}` — set unchanged.
- `currentApprovers` after stale filter: one entry — `ritsukai-bot` / CONTRIBUTOR / APPROVED / `commit.oid = eee5555` matches `headRefOid`, not the author. The review qualifies for `currentApprovers`. The set of approver logins is `{ritsukai-bot}`.
- Decision case: **coverage** (`requiredOwnerSets` is non-empty).
- Required: every distinct owner-set in `requiredOwnerSets` intersects the set of approver logins from `currentApprovers`. The single set `{oaksprout, ritsukai}` ∩ `{ritsukai-bot}` = `∅` — the bot's login (`ritsukai-bot`) is **not** in the owner-set (`ritsukai` is a separate login). Intersection is empty.
- **Verdict: drop with `skipped: awaiting code-owner review`.**

Note that #905's reviewer carries `authorAssociation == CONTRIBUTOR`, but that field is **not** consulted in the coverage case — the coverage rule uses the literal owner-set from CODEOWNERS, not the OWNER/MEMBER whitelist used by the no-coverage rule. The drop here is purely because the approving login is not one of the named code-owners for `/PRINCIPLES.md`.

### Verdict per check

**Check 1 — external-author PR with green CI and only a non-member approval is excluded.** PASS. #901's review came from `ritsukai-bot` whose `authorAssociation == CONTRIBUTOR`. The no-coverage rule requires `OWNER` or `MEMBER`, so the approval did not satisfy the gate. The PR was dropped with `skipped: awaiting maintainer review`. This is the literal incident shape from PR #423 (external author, green CI, non-code-owner approval) and the gate now correctly excludes it.

**Check 2 — properly code-owner-approved PR is kept.** PASS. #902 touches `/PRINCIPLES.md` whose CODEOWNERS rule names `@oaksprout @ritsukai`. The single owner-set `{@oaksprout, @ritsukai}` was intersected with `currentApprovers = {oaksprout}` and produced a non-empty intersection. The PR remains in the candidate set.

**Check 3 — no-coverage PR with a real `MEMBER`/`OWNER` approval is kept.** PASS. #903 touches `client/src/daemon/foo.ts` which has no CODEOWNERS coverage, so the no-coverage rule applies. `oaksprout` (OWNER) approved on the current head SHA, satisfying the no-coverage maintainer rule. The PR remains in the candidate set.

**Check 4 — stale approval (head-SHA mismatch) is invalidated.** PASS. #904's only approval was from `ritsukai` (MEMBER) but the review's `commit.oid` did not match `headRefOid` — i.e. a new commit was pushed after the approval. The stale-approval filter dropped the review from `currentApprovers`, leaving the set empty. The no-coverage rule's requirement of at least one current OWNER/MEMBER approval was not met, and the PR was dropped with `skipped: awaiting maintainer review`. This is the negative control required by the design note (`design.md` §Key trade-offs — stale-approval invalidation by `commit.oid`).

**Check 5 — PR touching a CODEOWNERS-covered path without a qualifying owner approval is dropped with `skipped: awaiting code-owner review`.** PASS. #905 touches `/PRINCIPLES.md` whose CODEOWNERS rule names `@oaksprout @ritsukai`. The single approving review came from `ritsukai-bot` (CONTRIBUTOR) — its `commit.oid` matched head and it passed the staleness and author-exclusion filters, so it entered `currentApprovers`. But `{oaksprout, ritsukai} ∩ {ritsukai-bot} = ∅` — the bot's login is not one of the named code-owners (despite the visual proximity to `ritsukai`). The coverage-case rule dropped the PR with the distinct `awaiting code-owner review` reason — different from #901/#904's `awaiting maintainer review` reason. This worked example exercises the second drop-reason that AC1's human-visible output names; together with Check 1 and Check 4 it confirms both reasons surface correctly.

**Historical Check 6 — explicit refusal clause held under operator blanket authorization.** PASS by construction under the 2026-05-26 policy, now superseded for `next` by the 2026-06-18 admin/autopilot authorization update below. The operator's batch-opening note ("Approve any PR you would have approved yourself — blanket authorization for this batch") was recorded but never consulted: the Code-owner review gate ran *before* operator authorization was checked. #901, #904, and #905 were dropped at the gate; the skill did not submit a review of its own to satisfy the gate retroactively, and would have refused to do so even if instructed. AC2 was satisfied at the algorithm level under the old rule.

### Weaknesses found

**Weakness 1 — `authorAssociation` can drift between review submission and batch run.**
GitHub's `authorAssociation` field reflects the reviewer's relationship to the
repo at the time the review payload is fetched, not at the time of review
submission. In practice this means a reviewer promoted to `MEMBER` after
approving (or demoted from `MEMBER` to `CONTRIBUTOR` after approving) is
re-classified at survey time, not at review time. For this repo the maintainer
set is small and stable, so the drift surface is narrow, but the gate's
behaviour is dependent on a GitHub-side field whose semantics could change.
Accepted trade-off: relying on `authorAssociation` keeps the rule in one place
(the PR JSON) and avoids inventing a new config file the skill would have to
teach itself to read.

**Weakness 2 — the gate does not separately verify against the GitHub org member list.**
The no-coverage rule trusts the `authorAssociation == MEMBER` signal as the
definition of "qualified maintainer". An attacker who somehow gets
`authorAssociation == MEMBER` set (e.g. via a misconfigured permission grant)
could approve a PR and satisfy the gate. The mitigation is org-level: only
trusted maintainers should hold the GitHub role that produces
`authorAssociation == MEMBER`. The gate explicitly does not introduce a
parallel allow-list file because that would create a second source of truth
that drifts from the GitHub state.

**Weakness 3 — last-match-wins parsing must be respected when CODEOWNERS grows.**
The current `.github/CODEOWNERS` has only exact-file rules for canonical docs,
so the matcher does not exercise glob precedence beyond trivial cases. If
future entries add overlapping patterns (e.g. `/client/**` and `/client/src/dashboard/**`),
the gate's correctness depends on the matcher honouring GitHub's last-match-wins
rule, not `.gitignore`'s first-match-wins rule. The `merge-mechanics.md` Step 1.5
algorithm states this explicitly; failure to honour it would silently weaken
the gate for paths that *do* have coverage.

### Assessment

The Code-owner review gate produces deterministic output on the synthetic batch
and all five worked-example scenarios behave as required. The external-author
green-CI case (Check 1, the #423 incident shape) is now caught at Step 1 and
never enters the merge sequence; properly code-owner-approved PRs (Check 2) and
no-coverage PRs with a maintainer approval (Check 3) are retained without
incident; stale approvals (Check 4) are invalidated by head-SHA mismatch, which
matches the design's stated stale-approval discipline; the coverage-case drop
reason (Check 5, the second of AC1's two distinct skip reasons) fires when a
CODEOWNERS-covered path receives only a non-owner approval; and operator
blanket authorization (Historical Check 6) did not bypass the old gate, by
construction. That refusal behavior is superseded for `next` by the 2026-06-18
admin/autopilot authorization update below.
Both drop reasons are now exercised by at least one worked example —
`awaiting maintainer review` by #901 and #904, `awaiting code-owner review`
by #905 — so AC1's human-visible output surface is covered on both sides.
The acceptance criteria from Issue #608 — AC1 (drop with a clear note), the
then-current AC2 (refusal under blanket authorization), AC3 (worked-example
regression artifact) — were satisfied by the old gate. The current `next`
policy is the 2026-06-18 admin/autopilot authorization update below.

---

## Large-batch wave planning verification (2026-06-17)

Scope: planner only, no real merges, no writes to `next`.

Fixture: 50 PRs, max wave size 8, one solo package PR, one overlapping store
pair, one dependency edge, and one PR awaiting maintainer review.

Expected:
- PR awaiting maintainer review is skipped without Project mutation.
- Solo package PR is isolated in its own wave.
- Overlapping store PRs stay together in a reactive-overlap wave.
- Independent PRs are split into bounded waves.

Verdict: PASS when
`cd packages/autopilot && yarn test test/merge-batch/large-batch-fixture.test.ts`
passes.

---

## Admin/autopilot next-merge authorization update (2026-06-18)

Scope: skill policy and planner model only; no real merges, no writes to `next`.

User directive: for merging into `next`, the autonomous autopilot flow may use
admin authority to approve and merge. This supersedes the 2026-05-26 refusal
clause for `next` integration only.

Expected:
- CI red/pending, `Blocked on: Human`, semantic conflicts, and unexpected head
  SHAs still block the batch.
- A PR that lacks a qualifying current review is kept as `admin-authorized`
  when the human explicitly authorizes admin/autopilot merge for the current
  `next` batch.
- The merge loop attempts ordinary rebase merge first, then uses
  `gh pr merge --admin --rebase ... --match-head-commit <headRefOid>` only if
  branch protection blocks solely on review state.
- This authorization never applies to `main` promotion.

Verdict: PASS when `cd packages/autopilot && yarn typecheck && yarn test
test/merge-batch/manifest.test.ts` passes.
