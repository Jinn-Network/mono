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
