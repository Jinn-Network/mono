# Marketplace-Backed Autopilot Execution

- **Version:** 0.1
- **Date:** 2026-07-20
- **Author:** Jinn contributor (Ritsu) with Claude
- **Status:** Proposed (design sketch — no implementation; issues to be filed per stage after
  review)

## Summary

Make the Jinn task marketplace the execution backend for Autopilot. Autopilot stops spawning
local implementation and review sessions and becomes a **launcher + generator + GitHub bridge**:
it posts engineering tasks to a SolverNet, marketplace operators execute them, and Autopilot
retains all GitHub authority (branches, PRs, reviews, merges). jinn-mono becomes the first repo
whose engineering runs through the marketplace.

This gives the marketplace its missing ingredient — a sustained, real, daily demand stream with
unambiguous success criteria (CI + independent review + human-gated merge) — and makes "Jinn's
engineering runs on Jinn" an on-chain-verifiable claim. Per DR-2026-06-30, operators earn OLAS
for verified completed-loop work; mono engineering becomes precisely that work.

## Why the fit is structural

1. **Autopilot's implement/review split is the marketplace's solution/verdict split.**
   implement-issue maps to the solver role; review-pr maps to the evaluator role. The contract
   already sequences solution → verdict, and on-chain self-evaluation prevention
   (`TCSolverSelfEvaluation`) enforces AI workflow rule 4 (implementer ≠ reviewer, no
   self-merge) by contract instead of process discipline.
2. **PR #1883 already drew the required security boundary.** Its delegated-root doctrine —
   delegated roots receive no lifecycle manifest, attestation, GitHub credential, or Git/SSH
   publication authority — describes a marketplace solver exactly. Solvers produce artifacts;
   the Autopilot host keeps every GitHub authority.
3. **The harness exists in prototype form.** `swe-rebench-v2` is "clone a repo at a pinned SHA,
   solve an issue, produce a patch, evaluate against tests" as a benchmark SolverType;
   `yarn e2e:daemon-harness` proves the full daemon + real-harness + settlement loop. The eng
   harness is that machinery retargeted from benchmark instances to live mono issues.

## Architecture

### Role mapping

| Autopilot stage (today) | Marketplace primitive (proposed) |
|---|---|
| `selectReady` ready-filter → `dispatchIssue` | Ready-filter becomes a `TaskSource` for the `CreatorLoop`; Autopilot is a launched-record-driven generator |
| implement-issue coordinator session | Solver role: eng harness claims, solves, delivers patch + evidence envelope |
| review-pr session | Evaluator role: verdict harness reviews the delivered patch; verdict envelope drives the GitHub review |
| merge sweep, label/board sweeps, merge-prep | **Unchanged, host-side forever** (require GitHub authority) |

### Authority split

Host-side (Autopilot, permanently): GitHub pushes, PR creation, review posting, merges, board
reads/writes (Project fields via GraphQL — solvers never need board access), human gates
(code-owned / human-surface PRs still wait for a human per DR-2026-06-03). Merge-prep never
migrates: it needs push authority by definition.

Marketplace-side: claim, execution, delivery, evaluation. Solvers hold no GitHub credentials at
any stage.

### `eng-issue.v0` SolverType

Typed spec is a pointer, not a payload:

```
{ repo, issueNumber, baseSha, issueSnapshotCid, effort }
```

- **Issues are mutable; tasks are not.** Task creation snapshots the issue body (context +
  impact + acceptance criteria — the handbook's ratified spec shape), pins it to IPFS, and the
  task references the snapshot CID. Material issue edits → cancel and re-post.
- `baseSha` pins `origin/next` at post time for reproducibility; solver and evaluator both work
  against it.
- `effort` carries the board's Effort field as the reasoning-depth signal, replacing the
  coordinator session's `effortFlag`.

### Generator

`selectReady` (packages/autopilot/src/dispatcher/ready-filter.ts) output feeds a `TaskSource`
instead of `dispatchIssue`. An execution-mode switch (`local | marketplace`) sits alongside the
existing process-wide runtime switch; existing gates (Issue Type, Priority, Blocked on, author
allowlist, backpressure, concurrency) apply unchanged before posting. Posting draws on the
launcher escrow exactly as any SolverNet task does.

### Solver harness

Packages the implement-issue behavior as a harness: checkout mono at `baseSha`, run the
implement flow, run the touched test suites, emit patch + evidence envelope (transcript, test
output). Built by retargeting the swe-rebench machinery. This is the largest and riskiest
component: mono builds are heavy (install, typecheck, vitest), so per-task compute and
wall-clock budgets are real constraints on operator hardware.

### Delivery → PR bridge (host-side)

Consumes a delivered solution envelope: applies the patch in a fresh worktree, pushes the
branch, opens the draft PR against `next` with the `engine:review` label, links the on-chain
evidence in the PR body. One PR per task; a rebase conflict at PR-open never silently mutates
the verified patch — the task is marked stalled for re-post against the new head.

### Verdict → review bridge (host-side)

Maps the evaluator's verdict envelope to the GitHub review step: Autopilot's reviewer identity
posts approve / request-changes derived from the verdict, preserving the existing separate
implementer/reviewer credential split. During transition, local review-pr sessions may run as a
second layer; they retire (or demote to spot-checks) once verdict quality is proven.

## Fleet permissioning

- **Day one: closed SolverNet.** `openRoles` restricted; operators are the project's own fleet
  (the hosted claude-code operator exists today). Same inference as local Autopilot, now routed
  through claim → execute → deliver → evaluate with on-chain receipts.
- **Later: open joins.** Community operators earn by solving mono issues — permissionless
  contribution with staked accountability. The trust load is carried by the evaluator verdict,
  CI, and the unchanged human merge gates.

## Sequencing

1. **Stage 1 — implement only, closed fleet.** New SolverType + generator + delivery bridge;
   harness retargeted from swe-rebench; review stays local (review-pr as today).
   **Kill-test:** prove the harness produces mergeable PRs on a handful of `Low`-effort issues
   at acceptable cost before building further. If it cannot, the rest is plumbing around a
   hollow core.
2. **Stage 2 — review through verdicts.** Evaluator role activated; verdict bridge drives the
   review step; local review-pr retires.
3. **Stage 3 — open the fleet.** Community operators join. (This is where the
   inference-donation concept re-enters: not as a separate product, but as opening roles on a
   SolverNet already doing real work.)

## Open decisions

- **Timeout semantics.** Autopilot's 4h WallClock needs a marketplace analog: `maxClaims=1` +
  re-post on staleness (no wasted inference, slower recovery) vs `maxClaims>1` racing (faster,
  burns operator compute). Leaning `maxClaims=1` + re-post while the fleet is closed.
- **Escrow rates.** Per-task solution/verdict rates on testnet; symbolic initially, but the
  numbers set the template for mainnet OLAS economics.
- **Which issues route to the marketplace.** All ready issues, or an opt-in subset (e.g. by
  Effort tier) during Stage 1.
- **Verdict → review fidelity.** Whether a verdict envelope carries enough structure to render a
  genuine line-level review, or Stage 2 needs an enriched verdict payload schema.

## Risks

- **Harness feasibility (dominant risk).** Mergeable-PR rate on real issues at real cost is
  unproven; hence the Stage 1 kill-test.
- **Compute weight.** Mono checkouts and test runs may exceed what casual operator hardware
  sustains; may force minimum operator specs or a slimmer verification profile in the harness.
- **Issue text is untrusted model input.** Lower-stakes while the fleet is closed and the repo
  is our own; must be revisited before Stage 3 (prompt-injection steering a solver).
- **Latency.** Post → claim → solve → deliver → evaluate adds marketplace round-trips over
  direct local dispatch; acceptable for a 10-minute-cycle system, but worth measuring in
  Stage 1.

## What does not change

Merge authority and every human gate. The board (single SoR per DR-2026-05-18 /
DR-2026-05-20-b) remains the demand registry. PRs still target `next`, carry Conventional-Commit
shapes, and pass the same CI, review, and CODEOWNERS policy. This proposal relocates execution,
not governance.
