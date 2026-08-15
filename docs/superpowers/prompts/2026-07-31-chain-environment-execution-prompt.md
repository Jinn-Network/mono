# Execution kickoff — the chain environment family

**Date:** 2026-07-31

**Shape:** `feat` — implement six planned components. This session executes plans; it does
not redesign. Output is code on stacked branches with draft PRs.

**Audience note:** written for a session with **no context from the design or planning
rounds**. Everything you need is linked. Where this prompt restates a document, the
document wins.

---

## 0. What exists, and what you are doing

The Jinn platform is getting a second **environment family**: sandboxed blockchain worlds
(EVM state frozen from a public chain, booted in a pinned Anvil) in which agents perform
consequential crypto actions — swap, supply, borrow, vote, revoke, rescue — graded
deterministically against resulting chain state, published as marketplace task supply.

The design is approved and the implementation is fully planned. **Your job is to execute
six component plans and nothing else.**

Read in this order:

1. [`../specs/2026-07-31-chain-environment-family-design.md`](../specs/2026-07-31-chain-environment-family-design.md)
   — the approved design. **Law.**
2. [`../plans/2026-07-31-chain-environment-program.md`](../plans/2026-07-31-chain-environment-program.md)
   — the program plan: §1 components, §2 topology, §3 **pinned interfaces**, §4 the twelve
   cross-plan contracts, §5 gates, §5a **rulings CR1–CR8**. Also law.
3. Your component's plan, `../plans/2026-07-31-chain-ce{1..6}-*.md` — task-by-task, TDD,
   with real code in every step.
4. Context for how the sibling family was built and what its first real run taught:
   [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md)
   and [`../notes/2026-07-31-supply-first-e2e-findings.md`](../notes/2026-07-31-supply-first-e2e-findings.md).

The six supply packages this family builds beside are **merged on
`integration/evidence-v1`** and are law, not drafts. This family adds siblings and touches
them only additively (CF1 in `task-execution/profiles`, CF2 in `task-supply/admission`,
plus the CR1 derivation-seam widening).

## 1. Components and topology

| # | Package | Branch | Base |
| --- | --- | --- | --- |
| CE1 | `chain-environment-record` (`packages/environments/chain-record`) | `chain/ce1-chain-record` | `origin/integration/evidence-v1` |
| CE2 | `state-predicate` family (additive in `packages/task-execution/profiles`) | `chain/ce2-state-predicate` | `origin/integration/evidence-v1` |
| CE3 | `chain-environment-verification` (`packages/environments/chain-verification`) | `chain/ce3-chain-verification` | `chain/ce1-chain-record` |
| CE4 | `chain-state-extraction` (`packages/environments/chain-extraction`) | `chain/ce4-chain-extraction` | `chain/ce3-chain-verification` |
| CE5 | `chain-scenarios` (`packages/task-supply/chain-scenarios`) + CF2 | `chain/ce5-chain-scenarios` | `chain/ce3-chain-verification`, **merges** `chain/ce2-state-predicate` |
| CE6 | `information-world` (`packages/environments/information-world`) | `chain/ce6-information-world` | `chain/ce1-chain-record` |

**Critical path:** CE1 → CE3 → CE5. CE2 is independent and should start immediately (CE5
merges it). CE4 and CE6 ride beside the path.

**CE6 is gated** (program §5): it does not start until the chain-only path (CE1/CE3/CE5)
is proven — its plan header states the gate and the evidence required.

Every PR targets its base branch, never the integration branch directly (except CE1, CE2).
Restack after a base updates: `git rebase --onto <new-base> <old-base> <branch>`.

## 2. How to run it

**Worktrees.** Each component gets its own git worktree under
`../jinn-mono_worktrees/chain-ce<N>` — never work in the coordination checkout, and use
`git -C "<worktree>"` for every git call (paths contain an apostrophe; quote them).
Node 22; `corepack enable`; plain `yarn install` (never `--immutable` — new packages change
the lockfile).

**Portal build order.** These packages consume each other via `portal:` links, so a fresh
worktree must build upstream packages before downstream ones typecheck. Known-good order
from the sibling family's first run: `trust/core`, `trust/resolve`, `evidence/protocol`,
`environments/record`, `task-execution/{protocol,profiles,backend}`, `marketplace/binding`,
`task-supply/*`, then this family's packages. Budget for this; it is not optional setup.

**Per component:** an Opus coordinator owns the plan and dispatches a **fresh Sonnet
implementer per task**, giving it the task's full text verbatim — every step, code block,
command, and commit message. One task per implementer, in plan order, waiting for each.
After each, verify the worktree is clean and the task's commit landed. *If a subagent tool
is unavailable in your harness, implement the tasks yourself with identical per-task
discipline and say so in the report — do not silently change the model.*

**Verification before completion, every task:** typecheck, tests, the component's kit, and
the tree guards — run locally, output shown. No task is "done" without them.

## 3. Review: at most two waves per component

**This is a hard cap.** Per component:

- **Wave 1 (always):** when implementation completes, one fresh high-effort **Opus**
  reviewer reads the design, the component plan, the program plan, and the diff; it
  **reproduces the verification itself** (green you did not reproduce is not green) and runs
  an adversarial pass on the component's frozen surfaces. It reports; it does not fix.
- **Fix pass:** all blockers and majors. Minors only if trivial. Re-run verification and
  show output.
- **Wave 2 (only if wave 1 found blockers):** one confirmation review, scoped **to the
  fixes only** — not a fresh full audit.
- **Then stop.** Anything still outstanding becomes a filed follow-up finding with a
  proposed disposition, not a third wave. A component that cannot reach green in two waves
  is a **stop-and-report to the human**, not a loop.

Rationale: the sibling family's execution showed reviews earn their keep on the first pass
and mostly restate on later ones. Two waves buys the correctness; a third buys churn.

## 4. Contracts that bite hardest

The full twelve are in program §4; these are the ones that produced real defects in the
sibling family and will produce them here:

1. **Register in the existing tree guards in the same PR.** `packages/environments/` and
   `packages/task-supply/` are already open and guarded — **do not re-scaffold them.** Add
   your inventory row + dependency-graph entry, the boundary sweep, the packed-types
   entrypoint, and the CI job. In the sibling family a package shipped *invisible* to the
   tree's boundary guard because it skipped this, and only surfaced at merge.
2. **Stop on a missing Consumes symbol** (contract 11). A symbol your task consumes that is
   not on your base branch is a **stop-and-report** — never improvise it, never widen an
   interface to fit. Check the plan's Findings section first; most known gaps already carry
   dispositions.
3. **Plans are law** (contract 1). A defect found while implementing is a finding with a
   proposed disposition, surfaced — never a silent patch. The plans already carry ~50
   findings; adding one is normal and expected.
4. **Bounded claims** (contract 7). No API, log line, comment, or README says
   "deterministic", "verified", or "authenticated against mainnet" without the
   qualification the design gives those words. Several plans enforce this with a
   build-failing scan; do not weaken it.
5. **Fixture keys are freshly generated per record and never reused** (contract 8), and
   never a well-known dev-mnemonic address. Design §8: a funded fixture address turns every
   published solution script into a replayable mainnet transaction. Plans carry deny-lists;
   keep them.
6. **Docker-dependent tests are opt-in and skip cleanly** (contract 12). Kits run against
   scripted fakes — stable, flaky-on-run-3, vanishing-image — not a live daemon.
7. **Custody law:** no key material, no ambient authority (no ambient `fetch`, no ambient
   Docker, no ambient clock), everything injected, fail closed.

## 5. Completion

Per component: push the branch, open a **draft PR** targeting its base, and report honestly
— tasks completed vs planned, verification output, findings filed, anything you stopped on.

**CI note, so you classify it correctly:** `integration/evidence-v1` carries a
**pre-existing ~12-failure baseline** that reds every PR from every program (an npm
`edgesOut` bug in the shared pack-smoke harness, breaking packages that predate all of this
work). Before concluding your work broke CI, diff your failing check *names* against an
unrelated PR on the same base. "12 pre-existing, 0 mine" is information; "CI is red" is not.

**Program-end gate** (program §5), after all components: an integrated review, then a
**first sealed chain environment** — a real anchored-subset world extracted, verified
`closed-reproducible` at K≥5 under network blackhole, with one scenario task admitted
against it. That gate is the point of the whole family; report honestly if it is not met
rather than declaring it met.

## 6. What this session does not do

- Redesign anything. Design defects are findings; the design is approved and committed.
- Touch the six merged supply packages beyond the additive amendments the plans specify
  (CF1, CF2, CR1's derivation widening) — all of which are **byte-neutral for the existing
  mined path**, with acceptance steps proving it.
- Start CE6 before its gate.
- Chase the pre-existing CI baseline (§5) — not this family's bug.
- Post anything to a real network or acquire any key. Nothing in this family needs funds.
