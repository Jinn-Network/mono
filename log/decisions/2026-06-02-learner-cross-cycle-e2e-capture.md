---
id: DR-2026-06-02
title: learner-full-cycle-swe-rebench-v2 e2e — cross-cycle persistence captured green on claude-code/Haiku; recalibrated off model-prose assertions; kept on-demand
date: 2026-06-02
verb: Verify
status: ratified
authors: opus (test session on #930); ratified by Captain ritsukai 2026-06-02
shape: test
relates-to: >
  issue #930 (this), #788 (added the e2e), #780 (fixture fix), #682 (harness config),
  DR-2026-05-26 (#673 — the swe-rebench learning-loop fix this e2e guards),
  DR-2026-05-28 (#766 — the held-out exam; the efficacy measurement this is NOT),
  #929 (Milestone 2 re-pin to claude-code/Haiku)
---

## Summary

Ran the controlled `learner-full-cycle-swe-rebench-v2` e2e on `claude-code` +
`claude-haiku-4-5-20251001` (the issue #930 AC config) and captured a fresh
cross-cycle learning result. The cross-cycle **persistence** claim holds:
`implStateDir` HEAD advances between cycles, cycle 2 boots from cycle 1's HEAD,
and durable learning commits accumulate. Getting a reliable green required
**recalibrating the test off three claude-code/Haiku-fragile assertions** — it
was red on the first two attempts for two *different* reasons, both in the
test's strictness/budget rather than in the learner's mechanism.

**Decision (ratified): keep this e2e on-demand. Do not promote it to per-PR CI.**

## What this e2e covers — and what it does NOT

This is the **in-repo dual of the network learning claim** (issue #930 framing):
a cheap, controlled, offline demonstration that the learner's durable-state
machinery carries knowledge from run N to run N+1. It is a **cross-cycle
persistence** guard — the regression guard for the [DR-2026-05-26](2026-05-26-solvernet-learning-investigation.md)
/ [#673](https://github.com/Jinn-Network/mono/issues/673)-class bug, where
swe-rebench-v2 sessions used to terminate before Improve/Memory ever ran (the
impl-state git history had only the `init` commit and *nothing accumulated
across runs*).

It is **not** a learning-*efficacy* test. It never measures whether accumulated
knowledge raises the pass rate — on a trivial smoke task it structurally
cannot. Efficacy is the **held-out exam** (`jinn eval`, [DR-2026-05-28](2026-05-28-rl-eval-measurement.md)),
which shipped separately on `next` (PRs #841–#845) and is the right tool for
"did the agent get *better*." The e2e's header has been updated to label its
scope as cross-cycle persistence so its narrowness is not mistaken for an
efficacy claim.

## Captured result (claude-code/Haiku, 2026-06-02)

| Run | Wall | Outcome |
|---|---|---|
| 1 | ~1s | Prereq gap — `@jinn-network/sdk` workspace not compiled; the bare `tsx` script imports it via `solver-nets/registry`. Not a test-logic failure. Fixed by making the script self-contained (`yarn build:sdk &&`). |
| 2 | 12m43s | Both cycles completed all 7 phases. Cross-cycle persistence proven. Failed only on the over-strict `consolidate:` assertion → loosened. |
| 3 | 16m53s | Cycle 1 ok; **cycle 2 hit the old 600s/cycle window cap and was aborted before Memory consolidation**. Also: Haiku emitted `Learn:` / `Promote HIGH recommendation:` commit subjects, no `improve:`/`consolidate:` prefixes. |
| 4 | — | Killed mid-cycle-2 by a session resume (environment, not a test failure). Cycle 1 had already passed green with the new assertions. |
| **5** | **14m20s** | **GREEN** — `=== e2e PASSED ===`, exit 0. |

### Run 5 green output (load-bearing)

```
CYCLE 1 (221s): ✓ 7 phase artifacts · ✓ boot.json implStateDirShaAtStart=c03f6b29
               · ✓ Improve + Memory-consolidation phase records present · HEAD → 3d08dbf3
CYCLE 2 (636s): ✓ 7 phase artifacts · ✓ boot.json implStateDirShaAtStart=3d08dbf3
               · ✓ Improve + Memory-consolidation phase records present · HEAD → 728b4919
✓ implStateDir HEAD advanced cycle1→cycle2: 3d08dbf3 → 728b4919
✓ 2 commit(s) between cycles:
    728b491 docs: document path resolution mapping for cycle 3+ planning
    0a69e42 docs: persist cycle 2 execution notes with metrics and path resolution documentation
✓ cycle 2 boot.json.implStateDirShaAtStart matches cycle 1's HEAD
✓ implStateDir has 3 durable learning commit(s) beyond init
```

Two of the recalibrations were proven necessary *by the green run itself*:
cycle 2 took **636s** — it would have been aborted under the old 600s cap; and
the durable commits were prefixed `docs:` (a third distinct subject style after
run 2's `Learn:`/`improve:` and run 3's `Learn:`/`Promote…`), which the old
`improve:`-prefix requirement would have failed.

### Runtime + cost

Runtime measured: 12–17 min/run wall (green run 14m20s). On cost: these ran via
the `claude` CLI under **session auth** (subscription), not a metered API key,
so there is **no per-run dollar meter from this session**. The issue's
**~$0.80/run on Haiku** estimate stands as the API-pricing reference. Each run
spawns a real model CLI subprocess; it is real inference spend, just not
dollar-metered here.

## Fragilities found and fixed (all toward the documented design, never weakening the check)

1. **`consolidate:` assertion was unconditional.** The consolidator commits a
   `consolidate:` commit **only when it has durable curation work**; on a
   trivial task Improve already persisted the note and consolidation correctly
   makes no commit. This is by design — `client/plugins/learner/skills/learn/consolidator-prompt.md`
   ("If there's nothing to consolidate … no commit is made") and the design
   spec [`2026-04-23-default-learning-restorer-design.md`](../../docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md)
   §9. **Fix:** the assertion no longer requires a `consolidate:` commit.
2. **10-min/cycle window too tight.** Cycle 2 reads cycle 1's accumulated
   `implStateDir` and runs slower (478s, 600s+, 636s observed); it overran the
   cap and was aborted before consolidation. DR-2026-05-26 §Caveats #3 flagged
   exactly this as unverified. **Fix:** `CYCLE_WINDOW_MS` 10→20 min (a headroom
   cap, not a target — cycles return when their loop completes).
3. **`improve:`/`consolidate:` subject-prefix gating was model-prose-fragile.**
   Across three runs Haiku emitted `Learn:`, `Promote HIGH recommendation:`, and
   `docs:` for what is mechanically an Improve promotion. Gating on that prose
   tests the model's formatting, not the learner's mechanism. **Fix:** replaced
   with model-robust checks — the Improve and Memory-consolidation **phase
   records** must be present (`requirePhaseRecords`, opt-in so the portfolio
   variant's contract is unchanged), plus the existing git-level checks (HEAD
   advanced, ≥1 durable commit, cycle 2 boots from cycle 1's HEAD). Commit
   subjects are now logged for visibility, not gated.
4. **AC command was not self-contained.** `yarn e2e:full-cycle-swe-rebench-v2`
   imported the SDK workspace but didn't build it (unlike `e2e:corpus`). **Fix:**
   prepend `yarn build:sdk &&` so a clean checkout runs green.

Files: `client/test/e2e/learner-full-cycle-core.ts`,
`client/test/e2e/learner-full-cycle-swe-rebench-v2.ts`, `client/package.json`.

## Decision: keep on-demand (do not promote to per-PR CI)

Grounded in [DR-2026-05-28](2026-05-28-rl-eval-measurement.md)'s own
honesty-per-dollar tiering. This e2e is **real-inference + non-deterministic +
~12–17 min + requires CLI/API auth wired into the runner** — exactly the profile
that DR-2026-05-28 keeps *off* per-PR CI (its CI rung, Tier 1, is a **mocked**
harness; real-inference exams are on-demand/nightly). The mocked-harness CI rung
for this domain already exists as [#819](https://github.com/Jinn-Network/mono/issues/819).
This e2e is the real-Haiku **persistence** guard, run on demand (e.g. before a
release that touches the learner loop, or when validating a harness/model
re-pin). A future cheaper CI variant would be a mocked-harness version, not this
one.

## Consequences and follow-ups

- The e2e is now reliably green on the claude-code/Haiku config and self-contained
  from a clean checkout. It remains the cheap on-demand dual that guards the
  #673 fix from regressing.
- **Substantive finding for [#929](https://github.com/Jinn-Network/mono/issues/929)
  (Milestone 2 re-pin to claude-code/Haiku):** Haiku does **not** reliably emit
  the learner's own `improve:`/`consolidate:` commit-subject conventions
  (observed: `Learn:`, `Promote…`, `docs:` across three runs). The e2e no longer
  depends on this, but since the network is re-pinning *learning* to Haiku, the
  learner's prompt-convention adherence under Haiku is worth a look — flagged on
  #929 rather than fixed here (out of this test's scope).
- Sibling learner e2es (`e2e:full-cycle`, `e2e:hermes`, `e2e:daemon-harness`) are
  also bare `tsx`; if any shares the SDK-build prereq it could get the same
  `build:sdk &&` treatment. Low priority; not done here.
