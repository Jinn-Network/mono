# Marketplace-Backed Autopilot Execution

- **Version:** 0.2 — no new SolverType: live tasks are a variant of the existing `jinn-repo`
  type, whose solve-side shape (and solver harness) they share exactly; the only true delta is
  the grading oracle.
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
3. **The solve side already exists — entirely.** `jinn-repo.v1`
   (client/src/solver-types/jinn-repo.ts) is already "solve a coding task on Jinn-Network/mono
   at a pinned `base_commit` from a `problem_statement`" — today its instances are mined
   retrospectively from merged PRs. The learner harness's `supports()` accepts any
   non-evaluation SolverType, so live-issue tasks need **zero solver-harness changes**, and the
   mono environment provisioning is proven by the pilot-rig runs. `yarn e2e:daemon-harness`
   proves the full daemon + real-harness + settlement loop.

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

### No new SolverType: a live variant of `jinn-repo`

Live issues have the same solve-side shape as the existing `jinn-repo.v1` tasks (`instance_id`,
`repo: 'Jinn-Network/mono'`, `base_commit`, `problem_statement`, `language`). The only true
delta is the **grading oracle**: `jinn-repo.v1` is retrospective — mined from merged PRs, so
gold tests exist (`merged_pr`, `test_files` as the FAIL_TO_PASS gold, `test_cmd`). A live issue
is prospective — no merged PR, no gold tests, by definition.

So the change is a schema variant, not a new type: a discriminated union
(`source: 'merged-pr' | 'live-issue'`) where the live branch replaces the oracle fields with
`issue_number` + an issue-body snapshot reference, plus `effort` (the board's Effort field as
the reasoning-depth signal, replacing the coordinator session's `effortFlag`).

- **Issues are mutable; tasks are not.** Task creation snapshots the issue body (context +
  impact + acceptance criteria — the handbook's ratified spec shape); material issue edits →
  cancel and re-post. `base_commit` pins `origin/next` at post time.
- **Corpus continuity is the payoff of staying in the type family.** `knowledgeAutoload` keys on
  the task's solverType, so knowledge mined from the repo's merged-PR history auto-loads into
  live solves on the same repo — the retrospective type becomes training data for the
  prospective one. (Whether the live variant shares the exact solverType string or bumps a
  version is an implementation decision; corpus keying is the constraint to preserve.)
- **Evaluator pairing follows the oracle split.** `jinn-repo-evaluator` (exact-match on
  `jinn-repo.v1` + gold `test_files`) grades retrospective tasks. The live variant needs its own
  grading: Stage 1 ships a thin mechanical evaluator adapted from it — patch applies, typecheck,
  policy-scoped tests pass; no gold needed — so the on-chain loop (solution → verdict) completes
  and activity counters increment while human-equivalent review stays host-side. Judgment-shaped
  verdicts are Stage 2.

### Generator

`selectReady` (packages/autopilot/src/dispatcher/ready-filter.ts) output feeds a `TaskSource`
instead of `dispatchIssue`. An execution-mode switch (`local | marketplace`) sits alongside the
existing process-wide runtime switch; existing gates (Issue Type, Priority, Blocked on, author
allowlist, backpressure, concurrency) apply unchanged before posting. Posting draws on the
launcher escrow exactly as any SolverNet task does.

### Solver harness

Already exists. The learner harness `supports()` any non-evaluation SolverType and the mono
environment story (checkout at `base_commit`, install, run tests) is proven by the jinn-repo
pilot-rig runs. Remaining solver-side work is shaping, not construction: prompt/context
adaptation for live issues (the implement-issue skill chain's discipline — regression-test-first
for fixes, TDD for features — expressed as harness context), and per-task compute/wall-clock
budgets, since mono builds are heavy for casual operator hardware.

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

1. **Stage 1 — implement only, closed fleet.** jinn-repo live-variant schema + generator +
   delivery bridge + thin mechanical evaluator; solver harness unchanged; review stays local
   (review-pr as today). **Kill-test:** prove the existing harness produces mergeable PRs on a
   handful of `Low`-effort live issues at acceptable cost before building further. If it
   cannot, the rest is plumbing around a hollow core.
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

- **Solve quality (dominant risk).** The harness exists, but its mergeable-PR rate on live
  issues at real cost is unproven — retrospective jinn-repo instances carry gold tests that
  live issues lack; hence the Stage 1 kill-test.
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
